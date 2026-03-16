// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol"; // ✅ OZ v5.4.0 için doğru yol

// Minimal OXOBTC arayüzü
interface IOXOBTC {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
    function totalSupply() external view returns (uint256);
}

// Treasury arayüzü — bridge fee'si için
interface IProtocolTreasury {
    function receiveFeeOxoBtc(uint256 amount) external;
}

// Staking arayüzü — OXO fee discount için
interface IOXOStaking {
    function usersPool1(address user) external view returns (
        uint256 staked, uint256 ethDebt, uint256 oxoBtcDebt,
        uint256 pendingEth, uint256 pendingOxoBtc,
        uint256 cooldownAmount, uint256 cooldownEnd
    );
}

/// @title OXO Bridge V3 (Final - Debug+)
/// @notice BTC→ETH yönünde relayer imzası ile mint; ETH→BTC yönünde yakma + redeem
contract BridgeV3 is AccessControl, Pausable {
    using ECDSA for bytes32;

    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");

    IOXOBTC public immutable oxoToken;

    // ─── Multisig threshold ───────────────────────────────────────
    uint256 public signerThreshold = 1; // kaç farklı SIGNER_ROLE imzası gerekli

    // ─── Treasury fee ayarları ────────────────────────────────────
    IProtocolTreasury public treasury;
    uint256 public bridgeFeeBps = 10; // %0.1 (10 / 10_000)
    bool    public feeEnabled   = false;

    // ─── OXO staking fee discount ─────────────────────────────────
    IOXOStaking public oxoStaking;
    uint256 public oxoFeeDiscountThreshold = 1_000e18; // 1000 OXO stake → sıfır bridge fee

    // ─── oxoBTC supply cap ────────────────────────────────────────
    uint256 public maxTotalSupply; // 0 = sınırsız (varsayılan)

    // BTC→ETH işlemleri için replay koruması
    mapping(bytes32 => bool) public usedDigests;

    // ETH→BTC işlemleri için kullanıcı başına nonce sayacı
    mapping(address => uint256) public withdrawNonces;

    // ─── Redemption state machine ─────────────────────────────────
    uint256 public constant CANCEL_TIMEOUT = 24 hours; // kullanıcı iptal için bekleme süresi

    enum RedeemState { Pending, Processing, Completed, Cancelled }

    struct RedeemInfo {
        address  user;
        string   btcAddress;
        uint256  amount;
        RedeemState state;
        uint256  requestedAt;
    }

    mapping(bytes32 => RedeemInfo) public redeemRequests;

    // ---- Events ----
    event MintProcessed(
        address indexed to,
        uint256 amount,
        bytes32 indexed depositId,
        address indexed signer,
        bytes32 digest
    );

    event RedeemRequested(
        address indexed ethAddress,
        string btcAddress,
        uint256 amount,
        bytes32 indexed redeemHash,
        uint256 nonce,
        uint256 chainId
    );

    event RedeemCompleted(
        bytes32 indexed redeemHash,
        uint256 amount,
        address indexed relayer
    );

    event RedeemProcessing(
        bytes32 indexed redeemHash,
        address indexed relayer
    );

    event RedeemCancelled(
        bytes32 indexed redeemHash,
        address indexed user,
        uint256 amount
    );

    event TreasurySet(address treasury, uint256 feeBps);
    event FeeSent(uint256 feeAmount, uint256 netAmount);
    event SupplyCapSet(uint256 newCap);
    event SignerThresholdSet(uint256 newThreshold);

    constructor(address _oxoTokenAddress) {
        require(_oxoTokenAddress != address(0), "Invalid token address");
        oxoToken = IOXOBTC(_oxoTokenAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SIGNER_ROLE, msg.sender);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // -------- Admin --------
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @notice Treasury adresini ve fee oranını ayarla (admin)
    function setTreasury(address _treasury, uint256 _feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_feeBps <= 100, "Max fee %1"); // en fazla %1
        treasury     = IProtocolTreasury(_treasury);
        bridgeFeeBps = _feeBps;
        emit TreasurySet(_treasury, _feeBps);
    }

    /// @notice Fee'yi aç/kapat (admin)
    function setFeeEnabled(bool _enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeEnabled = _enabled;
    }

    /// @notice OXO staking kontratını set et (admin)
    function setOxoStaking(address _staking) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oxoStaking = IOXOStaking(_staking);
    }

    /// @notice Fee discount için minimum OXO stake miktarını güncelle (admin)
    function setOxoFeeDiscountThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oxoFeeDiscountThreshold = _threshold;
    }

    /// @notice Mint için kaç farklı SIGNER_ROLE imzası gerektiğini ayarla (admin)
    function setSignerThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_threshold >= 1, "BRIDGE: threshold must be >= 1");
        signerThreshold = _threshold;
        emit SignerThresholdSet(_threshold);
    }

    /// @notice oxoBTC toplam arzına üst limit koy (satoshi cinsinden, 0 = sınırsız)
    function setMaxSupplyCap(uint256 _cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Eğer cap sıfırdan farklı ise mevcut arzın altında olamaz
        require(_cap == 0 || _cap >= oxoToken.totalSupply(), "BRIDGE: cap below current supply");
        maxTotalSupply = _cap;
        emit SupplyCapSet(_cap);
    }

    // -------- BTC -> ETH --------
    function mintAndTransfer(
        address _to,
        uint256 _amount,
        bytes32 _depositId,             // BTC TXID veya benzersiz ID
        bytes[] calldata _signatures    // Birden fazla relayer EIP-191 imzası
    ) external whenNotPaused {
        require(_to != address(0), "BRIDGE: invalid recipient");
        require(_amount > 0, "BRIDGE: amount must be > 0");

        // Relayer tarafıyla aynı sırada digest üret
        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), _to, _amount, _depositId)
        );

        // Replay koruması
        require(!usedDigests[digest], "BRIDGE: TXID_ALREADY_USED");

        // Supply cap kontrolü (maxTotalSupply == 0 ise sınırsız)
        if (maxTotalSupply > 0) {
            require(
                oxoToken.totalSupply() + _amount <= maxTotalSupply,
                "BRIDGE: SUPPLY_CAP_EXCEEDED"
            );
        }

        // Multisig threshold doğrulama
        address recoveredSigner = _verifySignatures(digest, _signatures);

        // Fee hesapla — OXO stake eden kullanıcılar fee ödemez
        uint256 fee    = 0;
        uint256 netAmt = _amount;
        bool hasDiscount = false;
        if (address(oxoStaking) != address(0)) {
            (uint256 staked,,,,,,) = oxoStaking.usersPool1(_to);
            hasDiscount = staked >= oxoFeeDiscountThreshold;
        }
        if (feeEnabled && address(treasury) != address(0) && bridgeFeeBps > 0 && !hasDiscount) {
            fee    = (_amount * bridgeFeeBps) / 10_000;
            netAmt = _amount - fee;
        }

        // Kullanıcıya net miktarı mint et
        (bool success, bytes memory ret) = address(oxoToken).call(
            abi.encodeWithSignature("mint(address,uint256)", _to, netAmt)
        );
        if (!success) {
            if (ret.length > 0) {
                assembly { revert(add(32, ret), mload(ret)) }
            } else {
                revert("BRIDGE: MINT_CALL_FAILED_NO_REASON");
            }
        }

        // Fee treasury'ye mint et ve gönder
        if (fee > 0) {
            (bool feeSuccess,) = address(oxoToken).call(
                abi.encodeWithSignature("mint(address,uint256)", address(this), fee)
            );
            if (feeSuccess) {
                // Treasury'ye approve + transfer
                (bool approveOk,) = address(oxoToken).call(
                    abi.encodeWithSignature("approve(address,uint256)", address(treasury), fee)
                );
                if (approveOk) {
                    try treasury.receiveFeeOxoBtc(fee) {
                        emit FeeSent(fee, netAmt);
                    } catch {}
                }
            }
        }

        // Başarılı → digest işaretle + event yay
        usedDigests[digest] = true;
        emit MintProcessed(_to, netAmt, _depositId, recoveredSigner, digest);
    }

    // -------- ETH -> BTC --------
    function withdraw(string calldata _btcAddress, uint256 _amount)
        external
        whenNotPaused
    {
        require(_amount > 0, "BridgeV3: amount must be > 0");
        require(bytes(_btcAddress).length > 0, "BridgeV3: invalid BTC address");

        uint256 nonce = withdrawNonces[msg.sender];
        withdrawNonces[msg.sender] = nonce + 1;

        // Kullanıcının bridge'e approve vermiş olması gerekir
        oxoToken.burnFrom(msg.sender, _amount);

        bytes32 redeemHash = keccak256(
            abi.encode(msg.sender, _btcAddress, _amount, nonce)
        );

        redeemRequests[redeemHash] = RedeemInfo({
            user:        msg.sender,
            btcAddress:  _btcAddress,
            amount:      _amount,
            state:       RedeemState.Pending,
            requestedAt: block.timestamp
        });

        emit RedeemRequested(
            msg.sender,
            _btcAddress,
            _amount,
            redeemHash,
            nonce,
            block.chainid
        );
    }

    /// @notice Backend BTC göndermeden ÖNCE çağırır — Pending → Processing (cancel kilidi)
    function markProcessing(bytes32 _redeemHash)
        external
        onlyRole(SIGNER_ROLE)
        whenNotPaused
    {
        RedeemInfo storage info = redeemRequests[_redeemHash];
        require(info.user != address(0), "Redeem: Hash not found");
        require(info.state == RedeemState.Pending, "Redeem: Not pending");

        info.state = RedeemState.Processing;
        emit RedeemProcessing(_redeemHash, msg.sender);
    }

    /// @notice Backend BTC gönderdikten SONRA çağırır — Processing → Completed
    function markRedeemCompleted(bytes32 _redeemHash, uint256 _amount)
        external
        onlyRole(SIGNER_ROLE)
        whenNotPaused
    {
        RedeemInfo storage info = redeemRequests[_redeemHash];
        require(info.user != address(0), "Redeem: Hash not found");
        require(info.amount == _amount, "Redeem: Amount mismatch");
        require(info.state == RedeemState.Processing, "Redeem: Not processing");

        info.state = RedeemState.Completed;
        emit RedeemCompleted(_redeemHash, _amount, msg.sender);
    }

    /// @notice Kullanıcı, 24 saat geçmişse VE Pending durumundaysa iptal edebilir.
    ///         oxoBTC geri mint edilir. Processing/Completed/Cancelled'da çalışmaz.
    function cancelRedeem(bytes32 _redeemHash) external whenNotPaused {
        RedeemInfo storage info = redeemRequests[_redeemHash];
        require(info.user != address(0), "Redeem: Hash not found");
        require(info.user == msg.sender, "Redeem: Not your request");
        require(info.state == RedeemState.Pending, "Redeem: Not cancellable");
        require(
            block.timestamp >= info.requestedAt + CANCEL_TIMEOUT,
            "Redeem: Timeout not reached"
        );

        info.state = RedeemState.Cancelled;

        // oxoBTC'yi kullanıcıya geri mint et
        (bool ok, bytes memory ret) = address(oxoToken).call(
            abi.encodeWithSignature("mint(address,uint256)", info.user, info.amount)
        );
        if (!ok) {
            if (ret.length > 0) { assembly { revert(add(32, ret), mload(ret)) } }
            else { revert("Redeem: Cancel mint failed"); }
        }

        emit RedeemCancelled(_redeemHash, info.user, info.amount);
    }

    // -------- Helpers / Getters --------

    /// @dev threshold sayıda unique SIGNER_ROLE imzasını doğrular; ilk geçerli imzacıyı döner.
    function _verifySignatures(bytes32 digest, bytes[] calldata signatures)
        internal
        view
        returns (address firstSigner)
    {
        bytes32 ethSigned = _toEthSignedMessageHash(digest);
        address[] memory seen = new address[](signatures.length);
        uint256 validCount;
        for (uint256 i = 0; i < signatures.length; i++) {
            address recovered = ECDSA.recover(ethSigned, signatures[i]);
            if (!hasRole(SIGNER_ROLE, recovered)) continue;
            bool dup;
            for (uint256 j = 0; j < validCount; j++) {
                if (seen[j] == recovered) { dup = true; break; }
            }
            if (dup) continue;
            if (validCount == 0) firstSigner = recovered;
            seen[validCount] = recovered;
            validCount++;
        }
        require(validCount >= signerThreshold, "BRIDGE: INSUFFICIENT_SIGNATURES");
    }

    function _toEthSignedMessageHash(bytes32 hash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// Digest'i relayer tarafında test etmek için
    function computeDigest(address to, uint256 amount, bytes32 depositId)
        external
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), to, amount, depositId));
    }

    /// Digest işlenmiş mi?
    function isUsedDigest(bytes32 digest) external view returns (bool) {
        return usedDigests[digest];
    }

    /// Redeem request bilgisi
    function getRedeemInfo(bytes32 redeemHash) external view returns (RedeemInfo memory) {
        return redeemRequests[redeemHash];
    }
}
