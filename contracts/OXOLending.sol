// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80, int256, uint256, uint256 updatedAt, uint80
    );
    function decimals() external view returns (uint8);
}

interface IOXOStaking {
    function usersPool1(address user) external view returns (
        uint256 staked, uint256 ethDebt, uint256 oxoBtcDebt,
        uint256 pendingEth, uint256 pendingOxoBtc,
        uint256 cooldownAmount, uint256 cooldownEnd
    );
}

/// @title OXO Lending
/// @notice oxoBTC collateral ile ETH borç al. "Bitcoin'ini sat, yield kazan."
/// @dev LTV %70 | Likidite eşiği %80 | Likidite bonusu %10
contract OXOLending is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Token & Oracle ─────────────────────────────────────────────────────────
    IERC20 public immutable oxoBTC;
    AggregatorV3Interface public btcUsdOracle;
    AggregatorV3Interface public ethUsdOracle;

    // ── Parametreler ───────────────────────────────────────────────────────────
    uint256 public constant LTV_BPS            = 7000;  // %70
    uint256 public constant LTV_BOOST_BPS      = 7500;  // %75 (OXO stake boost)
    uint256 public constant LIQ_THRESHOLD_BPS  = 8000;  // %80
    uint256 public constant LIQ_BONUS_BPS      = 1000;  // %10 likidatör bonusu
    uint256 public constant BPS                = 10_000;

    IOXOStaking public oxoStaking;
    uint256 public oxoBoostThreshold = 100e18; // 100 OXO stake → LTV boost
    uint256 public constant ORACLE_STALE       = 3600;  // 1 saat
    uint256 public constant SECONDS_PER_YEAR   = 365 days;

    uint256 public baseRateBps = 500; // %5 APR

    // ── Oracle fiyat koruması ───────────────────────────────────────────────────
    uint256 public maxPriceDeviationBps = 1500; // %15 — bu kadar sapma olursa borrow durur
    uint256 public lastBtcPrice;                // son onaylı BTC fiyatı
    uint256 public lastEthPrice;                // son onaylı ETH fiyatı

    // ── Pozisyonlar ────────────────────────────────────────────────────────────
    struct Position {
        uint256 collateral;    // oxoBTC (8 decimal)
        uint256 debt;          // ETH (18 decimal) — anapara + birikmiş faiz
        uint256 debtUpdatedAt; // son faiz hesaplama zamanı
    }

    mapping(address => Position) public positions;
    uint256 public totalBorrowed; // toplam aktif ETH borcu

    // ── Events ─────────────────────────────────────────────────────────────────
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 ethAmount);
    event Repaid(address indexed user, uint256 principal, uint256 interest);
    event Liquidated(address indexed user, address indexed liquidator, uint256 collateralSeized, uint256 debtRepaid);
    event EthFunded(address indexed funder, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────────
    constructor(
        address _oxoBTC,
        address _btcOracle,
        address _ethOracle
    ) Ownable(msg.sender) {
        require(_oxoBTC != address(0) && _btcOracle != address(0) && _ethOracle != address(0), "Zero addr");
        oxoBTC      = IERC20(_oxoBTC);
        btcUsdOracle = AggregatorV3Interface(_btcOracle);
        ethUsdOracle = AggregatorV3Interface(_ethOracle);
    }

    // ── Oracle ─────────────────────────────────────────────────────────────────
    function getBtcUsd() public view returns (uint256) {
        (, int256 ans,, uint256 updatedAt,) = btcUsdOracle.latestRoundData();
        require(ans > 0, "Bad BTC price");
        require(block.timestamp - updatedAt <= ORACLE_STALE, "Stale BTC oracle");
        return uint256(ans);
    }

    function getEthUsd() public view returns (uint256) {
        (, int256 ans,, uint256 updatedAt,) = ethUsdOracle.latestRoundData();
        require(ans > 0, "Bad ETH price");
        require(block.timestamp - updatedAt <= ORACLE_STALE, "Stale ETH oracle");
        return uint256(ans);
    }

    /// @dev Fiyat sapması kontrolü — son bilinen fiyata göre maxPriceDeviationBps'den
    ///      fazla değişim varsa borrow işlemi reddedilir.
    function _checkPriceDeviation() internal {
        uint256 btc = getBtcUsd();
        uint256 eth = getEthUsd();

        if (lastBtcPrice > 0) {
            uint256 btcDiff = btc > lastBtcPrice
                ? btc - lastBtcPrice
                : lastBtcPrice - btc;
            require(
                btcDiff * BPS / lastBtcPrice <= maxPriceDeviationBps,
                "BTC price deviation too high"
            );
        }

        if (lastEthPrice > 0) {
            uint256 ethDiff = eth > lastEthPrice
                ? eth - lastEthPrice
                : lastEthPrice - eth;
            require(
                ethDiff * BPS / lastEthPrice <= maxPriceDeviationBps,
                "ETH price deviation too high"
            );
        }

        // Onaylı fiyatı güncelle
        lastBtcPrice = btc;
        lastEthPrice = eth;
    }

    /// @dev oxoBTC (8 dec) → ETH değeri (18 dec)
    function oxoBtcToEth(uint256 oxoAmt) public view returns (uint256) {
        return oxoAmt * getBtcUsd() * 1e18 / getEthUsd() / 1e8;
    }

    /// @dev ETH (18 dec) → oxoBTC miktarı (8 dec)
    function ethToOxoBtc(uint256 ethAmt) public view returns (uint256) {
        return ethAmt * getEthUsd() * 1e8 / getBtcUsd() / 1e18;
    }

    // ── Faiz Hesabı ────────────────────────────────────────────────────────────
    function _accrueInterest(address user) internal returns (uint256 interest) {
        Position storage pos = positions[user];
        if (pos.debt == 0 || pos.debtUpdatedAt == 0) return 0;
        uint256 elapsed = block.timestamp - pos.debtUpdatedAt;
        interest = pos.debt * baseRateBps * elapsed / BPS / SECONDS_PER_YEAR;
        pos.debt += interest;
        pos.debtUpdatedAt = block.timestamp;
        totalBorrowed += interest;
    }

    /// @notice Güncel borç (anapara + birikmiş faiz)
    function currentDebt(address user) public view returns (uint256) {
        Position memory pos = positions[user];
        if (pos.debt == 0) return 0;
        uint256 elapsed = block.timestamp - pos.debtUpdatedAt;
        uint256 interest = pos.debt * baseRateBps * elapsed / BPS / SECONDS_PER_YEAR;
        return pos.debt + interest;
    }

    // ── Health Factor ──────────────────────────────────────────────────────────
    /// @notice 1e18 = sağlıklı eşik. <1e18 → likide edilebilir.
    function healthFactor(address user) public view returns (uint256) {
        Position memory pos = positions[user];
        uint256 debt = currentDebt(user);
        if (debt == 0) return type(uint256).max;
        uint256 collateralEth = oxoBtcToEth(pos.collateral);
        uint256 liqThreshold  = collateralEth * LIQ_THRESHOLD_BPS / BPS;
        return liqThreshold * 1e18 / debt;
    }

    /// @notice Kullanıcının efektif LTV'si (OXO stake varsa boost)
    function effectiveLtvBps(address user) public view returns (uint256) {
        if (address(oxoStaking) != address(0)) {
            (uint256 staked,,,,,,) = oxoStaking.usersPool1(user);
            if (staked >= oxoBoostThreshold) return LTV_BOOST_BPS;
        }
        return LTV_BPS;
    }

    /// @notice Kullanıcının maksimum borçlanabileceği ETH
    function maxBorrow(address user) public view returns (uint256) {
        Position memory pos = positions[user];
        uint256 maxEth = oxoBtcToEth(pos.collateral) * effectiveLtvBps(user) / BPS;
        uint256 debt   = currentDebt(user);
        return debt >= maxEth ? 0 : maxEth - debt;
    }

    // ── Core ───────────────────────────────────────────────────────────────────

    /// @notice oxoBTC teminat yatır
    function depositCollateral(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Zero amount");
        oxoBTC.safeTransferFrom(msg.sender, address(this), amount);
        _accrueInterest(msg.sender);
        positions[msg.sender].collateral += amount;
        if (positions[msg.sender].debtUpdatedAt == 0) {
            positions[msg.sender].debtUpdatedAt = block.timestamp;
        }
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice oxoBTC teminat çek (borç varsa health factor korunmalı)
    function withdrawCollateral(uint256 amount) external nonReentrant {
        Position storage pos = positions[msg.sender];
        require(amount > 0 && amount <= pos.collateral, "Invalid amount");
        _accrueInterest(msg.sender);
        pos.collateral -= amount;
        require(pos.debt == 0 || healthFactor(msg.sender) >= 1e18, "Undercollateralized");
        oxoBTC.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice ETH borç al (teminat LTV'ye göre sınırlı)
    function borrow(uint256 ethAmount) external nonReentrant whenNotPaused {
        require(ethAmount > 0, "Zero amount");
        require(address(this).balance >= ethAmount, "Insufficient liquidity");
        _checkPriceDeviation(); // oracle delay saldırısı koruması
        _accrueInterest(msg.sender);
        require(ethAmount <= maxBorrow(msg.sender), "Exceeds LTV");
        positions[msg.sender].debt += ethAmount;
        positions[msg.sender].debtUpdatedAt = block.timestamp;
        totalBorrowed += ethAmount;
        (bool ok,) = msg.sender.call{value: ethAmount}("");
        require(ok, "ETH transfer failed");
        emit Borrowed(msg.sender, ethAmount);
    }

    /// @notice Borç geri öde (ETH gönder)
    function repay() external payable nonReentrant {
        require(msg.value > 0, "Zero repay");
        uint256 interest = _accrueInterest(msg.sender);
        Position storage pos = positions[msg.sender];
        require(pos.debt > 0, "No debt");
        uint256 repayAmt = msg.value > pos.debt ? pos.debt : msg.value;
        uint256 excess   = msg.value - repayAmt;
        pos.debt -= repayAmt;
        totalBorrowed -= repayAmt;
        if (pos.debt == 0) pos.debtUpdatedAt = 0;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            require(ok, "Refund failed");
        }
        emit Repaid(msg.sender, repayAmt, interest);
    }

    /// @notice Sağlıksız pozisyonu likide et, %10 bonus kazan
    function liquidate(address user) external payable nonReentrant {
        require(healthFactor(user) < 1e18, "Position healthy");
        _accrueInterest(user);
        Position storage pos = positions[user];
        require(pos.debt > 0, "No debt");
        uint256 repayAmt = msg.value > pos.debt ? pos.debt : msg.value;
        // Likidatöre teminattan bonus dahil miktar ver
        uint256 seize = ethToOxoBtc(repayAmt * (BPS + LIQ_BONUS_BPS) / BPS);
        if (seize > pos.collateral) seize = pos.collateral;
        pos.debt -= repayAmt;
        totalBorrowed -= repayAmt;
        pos.collateral -= seize;
        if (pos.debt == 0) pos.debtUpdatedAt = 0;
        uint256 excess = msg.value - repayAmt;
        oxoBTC.safeTransfer(msg.sender, seize);
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            require(ok, "Refund failed");
        }
        emit Liquidated(user, msg.sender, seize, repayAmt);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────
    receive() external payable { emit EthFunded(msg.sender, msg.value); }

    function withdrawEth(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Amount exceeds balance");
        require(address(this).balance - amount >= totalBorrowed, "Would underfund");
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function setBaseRate(uint256 bps) external onlyOwner {
        require(bps <= 5000, "Max 50% APR");
        baseRateBps = bps;
    }

    function setOracles(address btc, address eth) external onlyOwner {
        require(btc != address(0) && eth != address(0), "Zero addr");
        btcUsdOracle = AggregatorV3Interface(btc);
        ethUsdOracle = AggregatorV3Interface(eth);
    }

    function setOxoStaking(address _staking) external onlyOwner {
        oxoStaking = IOXOStaking(_staking);
    }

    function setOxoBoostThreshold(uint256 _threshold) external onlyOwner {
        oxoBoostThreshold = _threshold;
    }

    /// @notice Oracle deviation limitini güncelle (default %15)
    function setMaxPriceDeviation(uint256 _bps) external onlyOwner {
        require(_bps >= 500 && _bps <= 5000, "Must be 5-50%");
        maxPriceDeviationBps = _bps;
    }

    /// @notice Son bilinen fiyatları sıfırla (oracle değiştirince çağır)
    function resetPriceAnchors() external onlyOwner {
        lastBtcPrice = 0;
        lastEthPrice = 0;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
