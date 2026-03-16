// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Chainlink price feed interface
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,      // BTC/USD fiyatı (8 decimals)
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
    function decimals() external view returns (uint8);
}

/// @title OXO Staking
/// @notice Pool 0: oxoBTC stake → OXO emisyon ödülü
///         Pool 1: OXO stake   → Protocol fee (ETH + oxoBTC)
///
/// Min stake: $50 USD karşılığı oxoBTC — Chainlink BTC/USD oracle ile anlık hesaplanır
/// Unstake cooldown: 3 gün
/// Compound: Pool 0 OXO ödülü → otomatik Pool 1'e stake
contract OXOStaking is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE   = keccak256("ADMIN_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE"); // ProtocolTreasury

    // ─── Sabitler ─────────────────────────────────────────────────
    uint256 public constant COOLDOWN      = 3 days;
    uint256 public constant PRECISION     = 1e18;
    uint256 public minStakeUsd            = 0;           // Admin ayarlayabilir (0 = sınır yok)
    uint256 public constant ORACLE_STALE  = 3600;        // 1 saat — fiyat eskiyse revert

    // ─── Token'lar ────────────────────────────────────────────────
    IERC20 public immutable oxoBTC;
    IERC20 public immutable oxo;

    // ─── Chainlink BTC/USD Oracle ─────────────────────────────────
    AggregatorV3Interface public btcOracle;

    // ═══════════════════════════════════════════════════════════════
    //  POOL 0: oxoBTC → OXO Emisyon
    // ═══════════════════════════════════════════════════════════════

    struct Pool0 {
        uint256 totalStaked;
        uint256 oxoPerSecond;       // Admin ayarlayabilir emisyon hızı
        uint256 accOxoPerShare;     // Birikimli OXO / staked unit (PRECISION scaled)
        uint256 lastRewardTime;
    }
    Pool0 public pool0;

    struct UserPool0 {
        uint256 staked;
        uint256 rewardDebt;
        uint256 pendingOxo;
        uint256 cooldownAmount;
        uint256 cooldownEnd;
    }
    mapping(address => UserPool0) public usersPool0;

    // ═══════════════════════════════════════════════════════════════
    //  POOL 1: OXO → Protocol Fee (ETH + oxoBTC)
    // ═══════════════════════════════════════════════════════════════

    struct Pool1 {
        uint256 totalStaked;
        uint256 accEthPerShare;
        uint256 accOxoBtcPerShare;
    }
    Pool1 public pool1;

    struct UserPool1 {
        uint256 staked;
        uint256 ethDebt;
        uint256 oxoBtcDebt;
        uint256 pendingEth;
        uint256 pendingOxoBtc;
        uint256 cooldownAmount;
        uint256 cooldownEnd;
    }
    mapping(address => UserPool1) public usersPool1;

    // ─── Events ───────────────────────────────────────────────────
    event Staked(address indexed user, uint8 pool, uint256 amount);
    event UnstakeRequested(address indexed user, uint8 pool, uint256 amount, uint256 cooldownEnd);
    event Withdrawn(address indexed user, uint8 pool, uint256 amount);
    event Claimed(address indexed user, uint8 pool, uint256 oxo, uint256 eth, uint256 oxoBtc);
    event Compounded(address indexed user, uint256 oxoAmount);
    event FeeDistributed(uint256 ethAmount, uint256 oxoBtcAmount);
    event EmissionUpdated(uint256 newOxoPerSecond);
    event OracleUpdated(address newOracle);

    // ─────────────────────────────────────────────────────────────
    constructor(
        address _oxoBTC,
        address _oxo,
        uint256 _oxoPerSecond,   // Öneri: 0.1e18 = 0.1 OXO/saniye ≈ 8,640 OXO/gün
        address _btcOracle,      // Sepolia: 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43
        address _admin
    ) {
        require(_oxoBTC != address(0) && _oxo != address(0), "zero token");
        require(_btcOracle != address(0), "zero oracle");

        oxoBTC    = IERC20(_oxoBTC);
        oxo       = IERC20(_oxo);
        btcOracle = AggregatorV3Interface(_btcOracle);

        pool0.oxoPerSecond   = _oxoPerSecond;
        pool0.lastRewardTime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _admin); // treasury set edilince güncellenir
    }

    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════
    //  ORACLE — Minimum oxoBTC stake miktarı ($50 USD)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Chainlink'ten anlık BTC/USD fiyatını alır
    function getBtcPrice() public view returns (uint256 priceUsd) {
        (, int256 answer, , uint256 updatedAt,) = btcOracle.latestRoundData();
        require(answer > 0, "Oracle: invalid price");
        require(block.timestamp - updatedAt <= ORACLE_STALE, "Oracle: stale price");
        // Chainlink BTC/USD → 8 decimals. Normalize to 18 decimals.
        priceUsd = uint256(answer) * 1e10;
    }

    /// @notice Minimum oxoBTC stake miktarı (minStakeUsd=0 ise 0 döner)
    function minOxoBtcStake() public view returns (uint256) {
        if (minStakeUsd == 0) return 0;
        uint256 priceUsd = getBtcPrice(); // 18 decimals
        return (minStakeUsd * 1e8 * 1e18) / priceUsd;
    }

    /// @notice Minimum stake USD değerini güncelle (0 = sınır yok)
    function setMinStakeUsd(uint256 _minUsd) external onlyRole(ADMIN_ROLE) {
        minStakeUsd = _minUsd;
    }

    // ═══════════════════════════════════════════════════════════════
    //  POOL 0 — Internal helpers
    // ═══════════════════════════════════════════════════════════════

    function _updatePool0() internal {
        if (pool0.totalStaked == 0) {
            pool0.lastRewardTime = block.timestamp;
            return;
        }
        uint256 elapsed = block.timestamp - pool0.lastRewardTime;
        uint256 reward  = elapsed * pool0.oxoPerSecond;
        pool0.accOxoPerShare  += (reward * PRECISION) / pool0.totalStaked;
        pool0.lastRewardTime   = block.timestamp;
    }

    function _harvestPool0(UserPool0 storage u) internal returns (uint256 harvested) {
        harvested     = (u.staked * pool0.accOxoPerShare) / PRECISION - u.rewardDebt;
        u.pendingOxo += harvested;
        u.rewardDebt  = (u.staked * pool0.accOxoPerShare) / PRECISION;
    }

    // ═══════════════════════════════════════════════════════════════
    //  POOL 0 — Public functions
    // ═══════════════════════════════════════════════════════════════

    /// @notice oxoBTC stake et, OXO kazan. Min $50 USD karşılığı oxoBTC.
    function stakeOxoBTC(uint256 amount) external nonReentrant {
        require(amount >= minOxoBtcStake(), "Below $50 minimum");
        _updatePool0();

        UserPool0 storage u = usersPool0[msg.sender];
        if (u.staked > 0) _harvestPool0(u);

        oxoBTC.safeTransferFrom(msg.sender, address(this), amount);
        u.staked          += amount;
        pool0.totalStaked += amount;
        u.rewardDebt       = (u.staked * pool0.accOxoPerShare) / PRECISION;

        emit Staked(msg.sender, 0, amount);
    }

    /// @notice 3 günlük unstake cooldown'ı başlat
    function requestUnstakeOxoBTC(uint256 amount) external nonReentrant {
        UserPool0 storage u = usersPool0[msg.sender];
        require(u.staked >= amount, "Insufficient stake");
        require(u.cooldownAmount == 0, "Cooldown already active");

        _updatePool0();
        _harvestPool0(u);

        u.staked          -= amount;
        pool0.totalStaked -= amount;
        u.rewardDebt       = (u.staked * pool0.accOxoPerShare) / PRECISION;
        u.cooldownAmount   = amount;
        u.cooldownEnd      = block.timestamp + COOLDOWN;

        emit UnstakeRequested(msg.sender, 0, amount, u.cooldownEnd);
    }

    /// @notice Cooldown bittikten sonra oxoBTC çek
    function withdrawOxoBTC() external nonReentrant {
        UserPool0 storage u = usersPool0[msg.sender];
        require(u.cooldownAmount > 0, "Nothing to withdraw");
        require(block.timestamp >= u.cooldownEnd, "Cooldown not finished");

        uint256 amount   = u.cooldownAmount;
        u.cooldownAmount = 0;
        u.cooldownEnd    = 0;

        oxoBTC.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, 0, amount);
    }

    /// @notice Pool 0 OXO ödüllerini talep et
    function claimPool0() external nonReentrant {
        _updatePool0();
        UserPool0 storage u = usersPool0[msg.sender];
        _harvestPool0(u);

        uint256 total = u.pendingOxo;
        require(total > 0, "Nothing to claim");

        u.pendingOxo = 0;
        oxo.safeTransfer(msg.sender, total);
        emit Claimed(msg.sender, 0, total, 0, 0);
    }

    /// @notice Compound: Pool 0 OXO ödülü → otomatik Pool 1'e stake
    function compound() external nonReentrant {
        _updatePool0();
        UserPool0 storage u = usersPool0[msg.sender];
        _harvestPool0(u);

        uint256 total = u.pendingOxo;
        require(total > 0, "Nothing to compound");

        u.pendingOxo = 0;
        // OXO contract'ta zaten var (treasury tarafından yüklenmiş)
        // Pool 1'e internal stake yapıyoruz — transfer gereksiz
        _stakeOxoInternal(msg.sender, total);

        emit Compounded(msg.sender, total);
    }

    // ═══════════════════════════════════════════════════════════════
    //  POOL 1 — Internal helpers
    // ═══════════════════════════════════════════════════════════════

    function _stakeOxoInternal(address staker, uint256 amount) internal {
        UserPool1 storage u = usersPool1[staker];

        if (u.staked > 0) {
            u.pendingEth    += (u.staked * pool1.accEthPerShare)    / PRECISION - u.ethDebt;
            u.pendingOxoBtc += (u.staked * pool1.accOxoBtcPerShare) / PRECISION - u.oxoBtcDebt;
        }

        u.staked           += amount;
        pool1.totalStaked  += amount;
        u.ethDebt           = (u.staked * pool1.accEthPerShare)    / PRECISION;
        u.oxoBtcDebt        = (u.staked * pool1.accOxoBtcPerShare) / PRECISION;

        emit Staked(staker, 1, amount);
    }

    // ═══════════════════════════════════════════════════════════════
    //  POOL 1 — Public functions
    // ═══════════════════════════════════════════════════════════════

    /// @notice OXO stake et, ETH + oxoBTC protocol fee'si kazan
    function stakeOXO(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        oxo.safeTransferFrom(msg.sender, address(this), amount);
        _stakeOxoInternal(msg.sender, amount);
    }

    /// @notice 3 günlük unstake cooldown'ı başlat (OXO)
    function requestUnstakeOXO(uint256 amount) external nonReentrant {
        UserPool1 storage u = usersPool1[msg.sender];
        require(u.staked >= amount, "Insufficient stake");
        require(u.cooldownAmount == 0, "Cooldown already active");

        u.pendingEth    += (u.staked * pool1.accEthPerShare)    / PRECISION - u.ethDebt;
        u.pendingOxoBtc += (u.staked * pool1.accOxoBtcPerShare) / PRECISION - u.oxoBtcDebt;

        u.staked          -= amount;
        pool1.totalStaked -= amount;
        u.ethDebt          = (u.staked * pool1.accEthPerShare)    / PRECISION;
        u.oxoBtcDebt       = (u.staked * pool1.accOxoBtcPerShare) / PRECISION;
        u.cooldownAmount   = amount;
        u.cooldownEnd      = block.timestamp + COOLDOWN;

        emit UnstakeRequested(msg.sender, 1, amount, u.cooldownEnd);
    }

    /// @notice Cooldown bittikten sonra OXO çek
    function withdrawOXO() external nonReentrant {
        UserPool1 storage u = usersPool1[msg.sender];
        require(u.cooldownAmount > 0, "Nothing to withdraw");
        require(block.timestamp >= u.cooldownEnd, "Cooldown not finished");

        uint256 amount   = u.cooldownAmount;
        u.cooldownAmount = 0;
        u.cooldownEnd    = 0;

        oxo.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, 1, amount);
    }

    /// @notice Pool 1 ETH + oxoBTC ödüllerini talep et
    function claimPool1() external nonReentrant {
        UserPool1 storage u = usersPool1[msg.sender];

        uint256 ethAmt    = u.pendingEth    + (u.staked * pool1.accEthPerShare)    / PRECISION - u.ethDebt;
        uint256 oxoBtcAmt = u.pendingOxoBtc + (u.staked * pool1.accOxoBtcPerShare) / PRECISION - u.oxoBtcDebt;

        u.pendingEth    = 0;
        u.pendingOxoBtc = 0;
        u.ethDebt    = (u.staked * pool1.accEthPerShare)    / PRECISION;
        u.oxoBtcDebt = (u.staked * pool1.accOxoBtcPerShare) / PRECISION;

        if (ethAmt > 0) {
            (bool ok,) = msg.sender.call{value: ethAmt}("");
            require(ok, "ETH transfer failed");
        }
        if (oxoBtcAmt > 0) {
            oxoBTC.safeTransfer(msg.sender, oxoBtcAmt);
        }

        emit Claimed(msg.sender, 1, 0, ethAmt, oxoBtcAmt);
    }

    // ═══════════════════════════════════════════════════════════════
    //  FEE DAĞITIMI (ProtocolTreasury çağırır)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Treasury'den oxoBTC fee'si gelir → Pool 1 staker'lara dağıtılır
    function distributeOxoBtcFee(uint256 amount) external onlyRole(TREASURY_ROLE) nonReentrant {
        require(amount > 0, "Zero fee");
        oxoBTC.safeTransferFrom(msg.sender, address(this), amount);
        if (pool1.totalStaked > 0) {
            pool1.accOxoBtcPerShare += (amount * PRECISION) / pool1.totalStaked;
        }
        emit FeeDistributed(0, amount);
    }

    /// @notice Treasury'den ETH fee'si gelir → Pool 1 staker'lara dağıtılır
    function distributeEthFee() external payable onlyRole(TREASURY_ROLE) nonReentrant {
        require(msg.value > 0, "Zero fee");
        if (pool1.totalStaked > 0) {
            pool1.accEthPerShare += (msg.value * PRECISION) / pool1.totalStaked;
        }
        emit FeeDistributed(msg.value, 0);
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════

    /// @notice Real-time Pool 0 OXO ödülü (block time'a göre hesaplanmış)
    function pendingOxo(address account) external view returns (uint256) {
        UserPool0 storage u = usersPool0[account];
        uint256 acc = pool0.accOxoPerShare;
        if (pool0.totalStaked > 0) {
            uint256 elapsed = block.timestamp - pool0.lastRewardTime;
            acc += (elapsed * pool0.oxoPerSecond * PRECISION) / pool0.totalStaked;
        }
        return u.pendingOxo + (u.staked * acc) / PRECISION - u.rewardDebt;
    }

    /// @notice Real-time Pool 1 ETH + oxoBTC ödülleri
    function pendingFees(address account)
        external view
        returns (uint256 ethAmt, uint256 oxoBtcAmt)
    {
        UserPool1 storage u = usersPool1[account];
        ethAmt    = u.pendingEth    + (u.staked * pool1.accEthPerShare)    / PRECISION - u.ethDebt;
        oxoBtcAmt = u.pendingOxoBtc + (u.staked * pool1.accOxoBtcPerShare) / PRECISION - u.oxoBtcDebt;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    /// @notice Emisyon hızını güncelle (pool önce güncellenir)
    function setOxoPerSecond(uint256 newRate) external onlyRole(ADMIN_ROLE) {
        _updatePool0();
        pool0.oxoPerSecond = newRate;
        emit EmissionUpdated(newRate);
    }

    /// @notice Pool 0 OXO emisyon fonunu yükle (admin → contract'a transfer)
    function fundOxoRewards(uint256 amount) external onlyRole(ADMIN_ROLE) {
        oxo.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Oracle adresini güncelle
    function setOracle(address _oracle) external onlyRole(ADMIN_ROLE) {
        require(_oracle != address(0), "zero address");
        btcOracle = AggregatorV3Interface(_oracle);
        emit OracleUpdated(_oracle);
    }

    /// @notice Treasury adresine TREASURY_ROLE ver
    function setTreasury(address treasury) external onlyRole(ADMIN_ROLE) {
        _grantRole(TREASURY_ROLE, treasury);
    }
}
