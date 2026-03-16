// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function token0() external view returns (address);
}

interface IUniswapV2Router {
    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path)
        external view returns (uint[] memory amounts);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @dev BridgeV3.withdraw(): oxoBTC'yi msg.sender'dan yakar, RedeemRequested event'i atar
interface IBridge {
    function withdraw(string calldata btcAddress, uint256 amount) external;
}

/// @title OXO Flash Exit
/// @notice Büyük ETH → BTC çıkışlarını slippage optimizasyonuyla yönetir.
///
///  exitInstant  → slippage uygunsa tek swapte anında
///  exitChunked  → büyük çıkış, parça parça swap, hepsi bitince bridge
///  getExitQuote → kaç chunk, tahmini output, slippage bilgisi
contract FlashExit is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Adresler ─────────────────────────────────────────────────
    address public immutable oxoBTC;
    address public immutable WETH;
    IUniswapV2Router  public immutable router;
    IUniswapV2Factory public immutable factory;
    IBridge           public bridge;           // admin güncelleyebilir

    // ─── Parametreler ─────────────────────────────────────────────
    uint256 public defaultMaxSlippageBps = 100; // %1
    uint256 public maxChunks             = 10;
    uint256 public chunkInterval         = 30;  // sn — chunk'lar arası min bekleme
    uint256 public exitFeeBps            = 10;  // %0.1 protokol fee

    // ─── Çıkış Emri ───────────────────────────────────────────────
    struct ExitOrder {
        address user;
        string  btcAddress;
        uint256 totalEth;
        uint256 remainingEth;
        uint256 acquiredOxoBtc;
        uint256 chunkEth;
        uint256 maxSlippageBps;
        uint256 lastChunkTime;
        uint256 chunksLeft;
        bool    completed;
        bool    cancelled;
    }

    uint256 public nextOrderId;
    mapping(uint256 => ExitOrder) public orders;
    mapping(address => uint256[]) private _userOrders;

    // ─── Events ───────────────────────────────────────────────────
    event ExitInstant(address indexed user, string btcAddress, uint256 ethIn, uint256 oxoBtcBurned);
    event ExitOrderCreated(uint256 indexed orderId, address indexed user, uint256 totalEth, uint256 chunks);
    event ChunkExecuted(uint256 indexed orderId, uint256 chunkEth, uint256 oxoBtcGot, uint256 chunksLeft);
    event ExitCompleted(uint256 indexed orderId, address indexed user, uint256 totalOxoBtc);
    event ExitCancelled(uint256 indexed orderId, address indexed user, uint256 ethReturned);
    event BridgeUpdated(address newBridge);
    event ParamsUpdated(uint256 maxSlippage, uint256 chunkInterval, uint256 fee);

    // ─────────────────────────────────────────────────────────────
    constructor(
        address _oxoBTC,
        address _WETH,
        address _router,
        address _factory,
        address _bridge,
        address _admin
    ) {
        oxoBTC  = _oxoBTC;
        WETH    = _WETH;
        router  = IUniswapV2Router(_router);
        factory = IUniswapV2Factory(_factory);
        bridge  = IBridge(_bridge);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
    }

    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════
    //  QUOTE
    // ═══════════════════════════════════════════════════════════════

    /// @notice Çıkış planını analiz eder.
    /// @return chunks          Kaç parçada yapılacak (1 = anlık)
    /// @return estimatedOxoBtc Tahmini ilk chunk çıktısı (8 decimal)
    /// @return slippageBps     Tek seferde yapılsaydı toplam slippage
    function getExitQuote(uint256 ethAmount, uint256 maxSlippageBps)
        public view
        returns (uint256 chunks, uint256 estimatedOxoBtc, uint256 slippageBps)
    {
        (uint256 ethRes, uint256 btcRes) = _getReserves();
        if (ethRes == 0 || btcRes == 0) return (0, 0, 10_000);

        // UniswapV2 output formula: out = (in*997*resOut) / (resIn*1000 + in*997)
        uint256 amtFee  = ethAmount * 997;
        uint256 amtOut  = (amtFee * btcRes) / (ethRes * 1000 + amtFee);

        // Ideal output (zero slippage): ethAmount * btcRes / ethRes
        uint256 idealOut = (ethAmount * btcRes) / ethRes;
        slippageBps = idealOut > 0 ? ((idealOut - amtOut) * 10_000) / idealOut : 10_000;

        if (slippageBps <= maxSlippageBps) {
            return (1, amtOut, slippageBps);
        }

        uint256 chunkEth = _calcChunkSize(ethAmount, maxSlippageBps, ethRes, btcRes);
        chunks = (ethAmount + chunkEth - 1) / chunkEth;
        if (chunks > maxChunks) chunks = maxChunks;
        return (chunks, amtOut, slippageBps);
    }

    // ═══════════════════════════════════════════════════════════════
    //  EXIT INSTANT
    // ═══════════════════════════════════════════════════════════════

    /// @notice ETH gönder → swap → bridge. Tek işlemde, slippage dahilinde.
    /// @param btcAddress   Kullanıcının BTC adresi
    /// @param minOxoBtcOut Minimum çıktı (slippage koruması)
    function exitInstant(
        string calldata btcAddress,
        uint256 minOxoBtcOut
    ) external payable nonReentrant {
        require(msg.value > 0, "No ETH sent");
        require(bytes(btcAddress).length > 0, "Invalid BTC address");

        uint256 fee   = (msg.value * exitFeeBps) / 10_000;
        uint256 ethIn = msg.value - fee;

        // ETH → oxoBTC swap
        uint256 oxoBtcOut = _swapEthToOxoBtc(ethIn, minOxoBtcOut);

        // oxoBTC'yi bridge üzerinden yak (RedeemRequested event → relayer BTC gönderir)
        _sendToBridge(btcAddress, oxoBtcOut);

        emit ExitInstant(msg.sender, btcAddress, msg.value, oxoBtcOut);
    }

    // ═══════════════════════════════════════════════════════════════
    //  EXIT CHUNKED
    // ═══════════════════════════════════════════════════════════════

    /// @notice ETH gönder → parça parça swap → hepsi bitince bridge.
    /// @param btcAddress      BTC çıkış adresi
    /// @param maxSlippageBps  Her chunk için max slippage (örn. 50 = %0.5)
    function exitChunked(
        string calldata btcAddress,
        uint256 maxSlippageBps
    ) external payable nonReentrant returns (uint256 orderId) {
        require(msg.value > 0, "No ETH sent");
        require(bytes(btcAddress).length > 0, "Invalid BTC address");
        require(maxSlippageBps >= 10 && maxSlippageBps <= 1000, "Slippage: 0.1%-10%");

        uint256 fee   = (msg.value * exitFeeBps) / 10_000;
        uint256 ethIn = msg.value - fee;

        (uint256 chunks,,) = getExitQuote(ethIn, maxSlippageBps);
        require(chunks > 0, "Pool has no liquidity");
        if (chunks > maxChunks) chunks = maxChunks;

        uint256 chunkEth = ethIn / chunks;
        if (chunkEth == 0) chunkEth = ethIn;

        orderId = nextOrderId++;
        ExitOrder storage o = orders[orderId];
        o.user           = msg.sender;
        o.btcAddress     = btcAddress;
        o.totalEth       = ethIn;
        o.remainingEth   = ethIn;
        o.chunkEth       = chunkEth;
        o.maxSlippageBps = maxSlippageBps;
        o.chunksLeft     = chunks;

        _userOrders[msg.sender].push(orderId);
        emit ExitOrderCreated(orderId, msg.sender, ethIn, chunks);

        // İlk chunk'ı hemen çalıştır
        _executeChunk(orderId);
    }

    /// @notice Bir sonraki chunk'ı çalıştırır. Herkes çağırabilir (keeper veya kullanıcı).
    function executeNextChunk(uint256 orderId) external nonReentrant {
        ExitOrder storage o = orders[orderId];
        require(!o.completed && !o.cancelled, "Order not active");
        require(o.chunksLeft > 0, "No chunks remaining");
        require(
            block.timestamp >= o.lastChunkTime + chunkInterval,
            "Wait for chunk interval"
        );
        _executeChunk(orderId);
    }

    function _executeChunk(uint256 orderId) internal {
        ExitOrder storage o = orders[orderId];

        // Son chunk: kalan ETH'in hepsini kullan
        uint256 ethToSwap = (o.chunksLeft == 1 || o.remainingEth <= o.chunkEth)
            ? o.remainingEth
            : o.chunkEth;

        // Slippage koruması
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = oxoBTC;
        uint256[] memory est = router.getAmountsOut(ethToSwap, path);
        uint256 minOut = est[1] * (10_000 - o.maxSlippageBps) / 10_000;

        uint256 got = _swapEthToOxoBtcWithPath(ethToSwap, minOut, path);

        o.acquiredOxoBtc += got;
        o.remainingEth   -= ethToSwap;
        o.chunksLeft     -= 1;
        o.lastChunkTime   = block.timestamp;

        emit ChunkExecuted(orderId, ethToSwap, got, o.chunksLeft);

        if (o.chunksLeft == 0) {
            o.completed = true;
            _sendToBridge(o.btcAddress, o.acquiredOxoBtc);
            emit ExitCompleted(orderId, o.user, o.acquiredOxoBtc);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  İPTAL
    // ═══════════════════════════════════════════════════════════════

    /// @notice Aktif emri iptal et. Kalan ETH iade, birikmiş oxoBTC kullanıcıya.
    function cancelOrder(uint256 orderId) external nonReentrant {
        ExitOrder storage o = orders[orderId];
        require(o.user == msg.sender, "Not your order");
        require(!o.completed && !o.cancelled, "Order not active");

        o.cancelled = true;

        if (o.acquiredOxoBtc > 0) {
            IERC20(oxoBTC).safeTransfer(msg.sender, o.acquiredOxoBtc);
        }
        if (o.remainingEth > 0) {
            (bool ok,) = msg.sender.call{value: o.remainingEth}("");
            require(ok, "ETH refund failed");
        }

        emit ExitCancelled(orderId, msg.sender, o.remainingEth);
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════

    function _swapEthToOxoBtc(uint256 ethIn, uint256 minOut) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = oxoBTC;
        return _swapEthToOxoBtcWithPath(ethIn, minOut, path);
    }

    function _swapEthToOxoBtcWithPath(
        uint256 ethIn,
        uint256 minOut,
        address[] memory path
    ) internal returns (uint256) {
        uint256[] memory amounts = router.swapExactETHForTokens{value: ethIn}(
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );
        return amounts[amounts.length - 1];
    }

    /// @dev oxoBTC'yi bridge üzerinden yak.
    ///      Bridge.withdraw(btcAddress, amount) → burnFrom(FlashExit) → RedeemRequested event
    ///      Relayer event'i dinler ve BTC'yi btcAddress'e gönderir.
    function _sendToBridge(string memory btcAddress, uint256 amount) internal {
        // Bridge, burnFrom için FlashExit'in approve vermesini bekler
        IERC20(oxoBTC).approve(address(bridge), amount);
        bridge.withdraw(btcAddress, amount);
    }


    function _calcChunkSize(
        uint256 ethAmount,
        uint256 maxSlippageBps,
        uint256 ethRes,
        uint256 btcRes
    ) internal view returns (uint256 chunkEth) {
        chunkEth = maxChunks > 0 ? ethAmount / maxChunks : ethAmount;
        uint256 lo = 1;
        uint256 hi = ethAmount;
        for (uint256 i = 0; i < 16; i++) {
            if (lo > hi) break;
            uint256 mid    = (lo + hi) / 2;
            uint256 midFee = mid * 997;
            uint256 midOut = (midFee * btcRes) / (ethRes * 1000 + midFee);
            uint256 midIdeal = (mid * btcRes) / ethRes;
            uint256 midSlip = midIdeal > 0 ? ((midIdeal - midOut) * 10_000) / midIdeal : 10_000;
            if (midSlip <= maxSlippageBps) { chunkEth = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        if (chunkEth == 0) chunkEth = ethAmount;
    }

    function _getReserves() internal view returns (uint256 ethReserve, uint256 btcReserve) {
        address pair = factory.getPair(oxoBTC, WETH);
        if (pair == address(0)) return (0, 0);
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        address token0 = IUniswapV2Pair(pair).token0();
        bool isBtcFirst = token0 == oxoBTC;
        btcReserve = isBtcFirst ? uint256(r0) : uint256(r1);
        ethReserve = isBtcFirst ? uint256(r1) : uint256(r0);
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════

    function getOrder(uint256 orderId) external view returns (ExitOrder memory) {
        return orders[orderId];
    }

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return _userOrders[user];
    }

    function getPoolLiquidity() external view returns (uint256 ethReserve, uint256 btcReserve) {
        return _getReserves();
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    function setParams(
        uint256 _maxSlippageBps,
        uint256 _maxChunks,
        uint256 _chunkInterval,
        uint256 _feeBps
    ) external onlyRole(ADMIN_ROLE) {
        require(_maxSlippageBps <= 1000, "Max 10% slippage");
        require(_maxChunks >= 1 && _maxChunks <= 20, "1-20 chunks");
        require(_feeBps <= 50, "Max 0.5% fee");
        defaultMaxSlippageBps = _maxSlippageBps;
        maxChunks             = _maxChunks;
        chunkInterval         = _chunkInterval;
        exitFeeBps            = _feeBps;
        emit ParamsUpdated(_maxSlippageBps, _chunkInterval, _feeBps);
    }

    function setBridge(address _bridge) external onlyRole(ADMIN_ROLE) {
        require(_bridge != address(0), "zero address");
        bridge = IBridge(_bridge);
        emit BridgeUpdated(_bridge);
    }

    function collectFees(address to) external onlyRole(ADMIN_ROLE) {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            require(ok, "ETH transfer failed");
        }
    }
}
