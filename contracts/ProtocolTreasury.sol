// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal staking interface — Treasury sadece fee dağıtım fonlarını çağırır
interface IOXOStaking {
    function distributeOxoBtcFee(uint256 amount) external;
    function distributeEthFee() external payable;
}

/// @notice Minimal router interface — POL eklemek + buyback için
interface IRouter {
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable returns (uint amountToken, uint amountETH, uint liquidity);

    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable returns (uint[] memory amounts);
}

/// @title OXO Protocol Treasury
/// @notice Bridge + Swap fee'lerini toplar, üç kola böler:
///         %70 → OXO Staker'lar (anlık dağıtım)
///         %20 → Protocol-Owned Liquidity (ETH/oxoBTC pool)
///         %10 → Stability Reserve (acil durum fonu)
contract ProtocolTreasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE  = keccak256("ADMIN_ROLE");
    bytes32 public constant FEEDER_ROLE = keccak256("FEEDER_ROLE"); // Bridge + Router

    // ─── Adresler ─────────────────────────────────────────────────
    IERC20        public immutable oxoBTC;
    IOXOStaking   public staking;
    IRouter       public router;
    address       public immutable WETH;
    address       public oxoToken;   // OXO governance token (buyback hedefi)

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ─── Dağıtım oranları (bps, toplam 10_000) ────────────────────
    uint256 public stakersShare  = 7_000; // %70
    uint256 public polShare      = 2_000; // %20
    uint256 public reserveShare  =   500; // %5
    uint256 public buybackShare  =   500; // %5 → OXO buyback+burn

    // ─── Eşikler — bu miktarın üstüne çıkınca dağıtım tetiklenir ──
    uint256 public ethThreshold    = 0.05 ether;
    uint256 public oxoBtcThreshold = 5_000; // 0.00005 oxoBTC (8 decimals)

    // ─── Stability Reserve bakiyeleri (contract içinde tutulur) ───
    uint256 public reserveETH;
    uint256 public reserveOxoBtc;

    // ─── Buyback birikimi ──────────────────────────────────────────
    uint256 public buybackETH;           // biriken buyback ETH
    uint256 public buybackThreshold = 0.01 ether; // bu kadar birikince auto-burn

    // ─── İstatistikler ────────────────────────────────────────────
    uint256 public totalEthDistributed;
    uint256 public totalOxoBtcDistributed;
    uint256 public totalPolAdded;
    uint256 public totalOxoBurned;

    // ─── Events ───────────────────────────────────────────────────
    event FeeReceived(address indexed from, uint256 ethAmount, uint256 oxoBtcAmount);
    event Distributed(uint256 toStakers, uint256 toPol, uint256 toReserve, bool isEth);
    event POLAdded(uint256 ethAmount, uint256 oxoBtcAmount, uint256 lpReceived);
    event ReserveWithdrawn(address indexed to, uint256 ethAmount, uint256 oxoBtcAmount);
    event SharesUpdated(uint256 stakers, uint256 pol, uint256 reserve, uint256 buyback);
    event ThresholdUpdated(uint256 ethThreshold, uint256 oxoBtcThreshold);
    event OxoBurned(uint256 ethSpent, uint256 oxoBurned);

    // ─────────────────────────────────────────────────────────────
    constructor(
        address _oxoBTC,
        address _staking,
        address _router,
        address _WETH,
        address _admin
    ) {
        require(_oxoBTC != address(0), "zero oxoBTC");
        require(_staking != address(0), "zero staking");
        require(_router  != address(0), "zero router");

        oxoBTC  = IERC20(_oxoBTC);
        staking = IOXOStaking(_staking);
        router  = IRouter(_router);
        WETH    = _WETH;
        // oxoToken deploy sonrası setOxoToken() ile set edilir

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(FEEDER_ROLE, _admin);
    }

    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════
    //  FEE GİRİŞİ
    // ═══════════════════════════════════════════════════════════════

    /// @notice Bridge'den ETH fee gelir (msg.value)
    function receiveFeeETH() external payable onlyRole(FEEDER_ROLE) {
        emit FeeReceived(msg.sender, msg.value, 0);
        _tryDistributeETH();
    }

    /// @notice Bridge'den oxoBTC fee gelir (önceden approve gerekli)
    function receiveFeeOxoBtc(uint256 amount) external onlyRole(FEEDER_ROLE) {
        require(amount > 0, "zero amount");
        oxoBTC.safeTransferFrom(msg.sender, address(this), amount);
        emit FeeReceived(msg.sender, 0, amount);
        _tryDistributeOxoBtc();
    }

    // ═══════════════════════════════════════════════════════════════
    //  OTOMATİK DAĞITIM (eşik geçilince)
    // ═══════════════════════════════════════════════════════════════

    function _tryDistributeETH() internal {
        uint256 bal = address(this).balance - reserveETH;
        if (bal >= ethThreshold) {
            _distributeETH(bal);
        }
    }

    function _tryDistributeOxoBtc() internal {
        uint256 bal = oxoBTC.balanceOf(address(this)) - reserveOxoBtc;
        if (bal >= oxoBtcThreshold) {
            _distributeOxoBtc(bal);
        }
    }

    function _distributeETH(uint256 amount) internal {
        uint256 toStakers = (amount * stakersShare) / 10_000;
        uint256 toPol     = (amount * polShare)     / 10_000;
        uint256 toBuyback = (amount * buybackShare)  / 10_000;
        uint256 toReserve = amount - toStakers - toPol - toBuyback;

        // Staker'lara gönder
        if (toStakers > 0) {
            staking.distributeEthFee{value: toStakers}();
        }

        // Buyback birikimine ekle
        buybackETH += toBuyback;

        // Reserve'e al
        reserveETH += toReserve;

        totalEthDistributed += toStakers;
        emit Distributed(toStakers, toPol, toReserve, true);

        // Eşik geçildi mi → auto buyback
        if (buybackETH >= buybackThreshold && oxoToken != address(0)) {
            _buybackAndBurn(buybackETH, 0);
        }
    }

    function _distributeOxoBtc(uint256 amount) internal {
        uint256 toStakers = (amount * stakersShare) / 10_000;
        uint256 toPol     = (amount * polShare)     / 10_000;
        uint256 toReserve = amount - toStakers - toPol;

        // Staker'lara approve + distribute
        if (toStakers > 0) {
            oxoBTC.forceApprove(address(staking), toStakers);
            staking.distributeOxoBtcFee(toStakers);
        }

        // POL payı burada kalır, addPOL() ile birleştirilir
        // toReserve reserve'e alınır
        reserveOxoBtc += toReserve;

        totalOxoBtcDistributed += toStakers;
        emit Distributed(toStakers, toPol, toReserve, false);
    }

    // ═══════════════════════════════════════════════════════════════
    //  OXO BUYBACK + BURN
    // ═══════════════════════════════════════════════════════════════

    /// @dev ETH ile OXO al, dead address'e gönder
    function _buybackAndBurn(uint256 ethAmount, uint256 minOxo) internal {
        require(oxoToken != address(0), "OXO token not set");
        buybackETH -= ethAmount;

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = oxoToken;

        try router.swapExactETHForTokens{value: ethAmount}(
            minOxo,
            path,
            DEAD,
            block.timestamp + 300
        ) returns (uint[] memory amounts) {
            uint256 burned = amounts[amounts.length - 1];
            totalOxoBurned += burned;
            emit OxoBurned(ethAmount, burned);
        } catch {
            // Swap başarısız olursa ETH'i geri buyback birikimine ekle
            buybackETH += ethAmount;
        }
    }

    /// @notice Manuel buyback+burn (admin). minOxo=0 → slippage koruması yok (dikkat)
    function buybackAndBurn(uint256 ethAmount, uint256 minOxo)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        require(ethAmount <= buybackETH, "Exceeds buyback balance");
        _buybackAndBurn(ethAmount, minOxo);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PROTOCOL-OWNED LIQUIDITY (POL)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Admin çağırır — biriken ETH + oxoBTC'yi DEX'e likidite olarak ekler
    /// @param ethAmount   Eklenecek ETH miktarı
    /// @param oxoBtcAmount Eklenecek oxoBTC miktarı
    /// @param slippageBps Kabul edilebilir max slippage (bps, örn. 50 = %0.5)
    function addPOL(
        uint256 ethAmount,
        uint256 oxoBtcAmount,
        uint256 slippageBps
    ) external onlyRole(ADMIN_ROLE) nonReentrant {
        uint256 ethBal    = address(this).balance - reserveETH;
        uint256 oxoBtcBal = oxoBTC.balanceOf(address(this)) - reserveOxoBtc;

        require(ethAmount    <= ethBal,    "Insufficient ETH for POL");
        require(oxoBtcAmount <= oxoBtcBal, "Insufficient oxoBTC for POL");

        uint256 ethMin    = ethAmount    - (ethAmount    * slippageBps / 10_000);
        uint256 oxoBtcMin = oxoBtcAmount - (oxoBtcAmount * slippageBps / 10_000);

        oxoBTC.forceApprove(address(router), oxoBtcAmount);

        (, , uint256 lp) = router.addLiquidityETH{value: ethAmount}(
            address(oxoBTC),
            oxoBtcAmount,
            oxoBtcMin,
            ethMin,
            address(this), // LP token'lar treasury'de kalır
            block.timestamp + 300
        );

        totalPolAdded += lp;
        emit POLAdded(ethAmount, oxoBtcAmount, lp);
    }

    // ═══════════════════════════════════════════════════════════════
    //  STABILITY RESERVE KULLANIMI
    // ═══════════════════════════════════════════════════════════════

    /// @notice Acil durum: reserve'den ETH veya oxoBTC çek (admin)
    /// @dev Gerçek kullanım senaryosu: pool kurudu, rezervden oxoBTC al
    function useReserve(
        address to,
        uint256 ethAmount,
        uint256 oxoBtcAmount
    ) external onlyRole(ADMIN_ROLE) nonReentrant {
        require(ethAmount    <= reserveETH,    "Reserve ETH insufficient");
        require(oxoBtcAmount <= reserveOxoBtc, "Reserve oxoBTC insufficient");

        reserveETH    -= ethAmount;
        reserveOxoBtc -= oxoBtcAmount;

        if (ethAmount > 0) {
            (bool ok,) = to.call{value: ethAmount}("");
            require(ok, "ETH transfer failed");
        }
        if (oxoBtcAmount > 0) {
            oxoBTC.safeTransfer(to, oxoBtcAmount);
        }

        emit ReserveWithdrawn(to, ethAmount, oxoBtcAmount);
    }

    // ═══════════════════════════════════════════════════════════════
    //  MANUEL DAĞITIM (admin trigger)
    // ═══════════════════════════════════════════════════════════════

    function distributeNow() external onlyRole(ADMIN_ROLE) nonReentrant {
        uint256 ethBal    = address(this).balance - reserveETH;
        uint256 oxoBtcBal = oxoBTC.balanceOf(address(this)) - reserveOxoBtc;

        if (ethBal > 0)    _distributeETH(ethBal);
        if (oxoBtcBal > 0) _distributeOxoBtc(oxoBtcBal);
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════

    function availableETH() external view returns (uint256) {
        return address(this).balance - reserveETH;
    }

    function availableOxoBtc() external view returns (uint256) {
        return oxoBTC.balanceOf(address(this)) - reserveOxoBtc;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    /// @notice Dağıtım oranlarını güncelle (toplam 10_000 olmalı)
    function setShares(
        uint256 _stakers,
        uint256 _pol,
        uint256 _reserve,
        uint256 _buyback
    ) external onlyRole(ADMIN_ROLE) {
        require(_stakers + _pol + _reserve + _buyback == 10_000, "Must sum to 10000");
        stakersShare = _stakers;
        polShare     = _pol;
        reserveShare = _reserve;
        buybackShare = _buyback;
        emit SharesUpdated(_stakers, _pol, _reserve, _buyback);
    }

    /// @notice OXO token adresini set et (buyback hedefi)
    function setOxoToken(address _oxo) external onlyRole(ADMIN_ROLE) {
        require(_oxo != address(0), "zero address");
        oxoToken = _oxo;
    }

    /// @notice Buyback eşiğini güncelle
    function setBuybackThreshold(uint256 _threshold) external onlyRole(ADMIN_ROLE) {
        buybackThreshold = _threshold;
    }

    /// @notice Otomatik dağıtım eşiklerini güncelle
    function setThresholds(
        uint256 _ethThreshold,
        uint256 _oxoBtcThreshold
    ) external onlyRole(ADMIN_ROLE) {
        ethThreshold    = _ethThreshold;
        oxoBtcThreshold = _oxoBtcThreshold;
        emit ThresholdUpdated(_ethThreshold, _oxoBtcThreshold);
    }

    /// @notice Staking contract adresini güncelle
    function setStaking(address _staking) external onlyRole(ADMIN_ROLE) {
        require(_staking != address(0), "zero address");
        staking = IOXOStaking(_staking);
    }

    /// @notice Router adresini güncelle
    function setRouter(address _router) external onlyRole(ADMIN_ROLE) {
        require(_router != address(0), "zero address");
        router = IRouter(_router);
    }

    /// @notice Bridge veya Router'a FEEDER_ROLE ver
    function addFeeder(address feeder) external onlyRole(ADMIN_ROLE) {
        _grantRole(FEEDER_ROLE, feeder);
    }
}
