const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("OXO Protocol - BridgeV3", function () {
    let oxoBTC;
    let bridge;
    let owner;
    let signer;
    let user;

    before(async function () {
        [owner, signer, user] = await ethers.getSigners();
    });

    async function deployContracts() {
        const OXOBTC = await ethers.getContractFactory("OXOBTC");
        oxoBTC = await OXOBTC.deploy("oxoBTC Token", "oxoBTC");

        const BridgeV3 = await ethers.getContractFactory("BridgeV3");
        bridge = await BridgeV3.deploy(oxoBTC.target);

        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER_ROLE, bridge.target);
    }

    // Tek imzayla bytes[] döner (default kullanım)
    async function signMint(signerWallet, toAddress, amount, depositId) {
        const digest = await bridge.computeDigest(toAddress, amount, depositId);
        const sig = await signerWallet.signMessage(ethers.getBytes(digest));
        return [sig];
    }

    // Birden fazla cüzdanla imzalar (multisig testleri için)
    async function signMintMulti(wallets, toAddress, amount, depositId) {
        const digest = await bridge.computeDigest(toAddress, amount, depositId);
        const digestBytes = ethers.getBytes(digest);
        return Promise.all(wallets.map(w => w.signMessage(digestBytes)));
    }

    it("should deploy OXOBTC and BridgeV3 correctly", async function () {
        await deployContracts();
        expect(oxoBTC.target).to.not.equal(ethers.ZeroAddress);
        expect(bridge.target).to.not.equal(ethers.ZeroAddress);
        expect(await bridge.oxoToken()).to.equal(oxoBTC.target);
    });

    it("should grant MINTER_ROLE to BridgeV3", async function () {
        await deployContracts();
        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        expect(await oxoBTC.hasRole(MINTER_ROLE, bridge.target)).to.be.true;
    });

    it("BTC → ETH: should mint oxoBTC to user via mintAndTransfer with valid signature", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.001", 8); // 100_000 satoshi
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("test_btc_txid_1"));

        // owner varsayılan SIGNER_ROLE'a sahip
        const signature = await signMint(owner, user.address, mintAmount, depositId);

        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signature);
        expect(await oxoBTC.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("BTC → ETH: should prevent replay attacks (same depositId twice)", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("replay_test_txid"));

        const signature = await signMint(owner, user.address, mintAmount, depositId);

        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signature);
        await expect(
            bridge.mintAndTransfer(user.address, mintAmount, depositId, signature)
        ).to.be.revertedWith("BRIDGE: TXID_ALREADY_USED");
    });

    it("BTC → ETH: should reject mint with unauthorized signature", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("fake_sig_txid"));

        // signer hesabı SIGNER_ROLE'a sahip değil
        const fakeSignature = await signMint(signer, user.address, mintAmount, depositId);

        await expect(
            bridge.mintAndTransfer(user.address, mintAmount, depositId, fakeSignature)
        ).to.be.revertedWith("BRIDGE: INSUFFICIENT_SIGNATURES");
    });

    it("ETH → BTC: should allow user to withdraw (redeem) oxoBTC", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.001", 8);
        const redeemAmount = ethers.parseUnits("0.0005", 8);
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("redeem_test_txid"));
        const chainId = (await ethers.provider.getNetwork()).chainId;

        const signature = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signature);

        await oxoBTC.connect(user).approve(bridge.target, redeemAmount);

        const btcAddress = "tb1qtest123testnet";
        await expect(bridge.connect(user).withdraw(btcAddress, redeemAmount))
            .to.emit(bridge, "RedeemRequested")
            .withArgs(user.address, btcAddress, redeemAmount, anyValue, 0n, chainId);

        expect(await oxoBTC.balanceOf(user.address)).to.equal(mintAmount - redeemAmount);
    });

    it("ETH → BTC: should reject withdraw with zero amount", async function () {
        await deployContracts();
        await expect(
            bridge.connect(user).withdraw("tb1qtest", 0)
        ).to.be.revertedWith("BridgeV3: amount must be > 0");
    });

    it("Admin: should allow admin to pause and unpause the bridge", async function () {
        await deployContracts();
        await bridge.pause();
        expect(await bridge.paused()).to.be.true;

        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("pause_test"));
        const signature = await signMint(owner, user.address, mintAmount, depositId);

        await expect(
            bridge.mintAndTransfer(user.address, mintAmount, depositId, signature)
        ).to.be.revertedWithCustomError(bridge, "EnforcedPause");

        await bridge.unpause();
        expect(await bridge.paused()).to.be.false;
    });

    it("Supply cap: should allow minting up to the cap", async function () {
        await deployContracts();
        const capAmount = ethers.parseUnits("1", 8); // 1 BTC cap
        await bridge.setMaxSupplyCap(capAmount);
        expect(await bridge.maxTotalSupply()).to.equal(capAmount);

        const mintAmount = ethers.parseUnits("1", 8); // tam cap kadar
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("cap_exact_txid"));
        const signature = await signMint(owner, user.address, mintAmount, depositId);

        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signature);
        expect(await oxoBTC.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("Supply cap: should revert mint that would exceed the cap", async function () {
        await deployContracts();
        // Önce 0.5 BTC mint et
        const firstMint = ethers.parseUnits("0.5", 8);
        const depositId1 = ethers.keccak256(ethers.toUtf8Bytes("cap_first_txid"));
        const sig1 = await signMint(owner, user.address, firstMint, depositId1);
        await bridge.mintAndTransfer(user.address, firstMint, depositId1, sig1);

        // Cap'i 0.5 BTC'ye ayarla (mevcut supply = 0.5, yani başka mint yapılamaz)
        const cap = ethers.parseUnits("0.5", 8);
        await bridge.setMaxSupplyCap(cap);

        // 1 satoshi daha mint etmeye çalış → revert beklenir
        const depositId2 = ethers.keccak256(ethers.toUtf8Bytes("cap_exceed_txid"));
        const sig2 = await signMint(owner, user.address, 1n, depositId2);
        await expect(
            bridge.mintAndTransfer(user.address, 1n, depositId2, sig2)
        ).to.be.revertedWith("BRIDGE: SUPPLY_CAP_EXCEEDED");
    });

    it("Multisig: threshold=1 (default) — tek imzayla mint çalışır", async function () {
        await deployContracts();
        expect(await bridge.signerThreshold()).to.equal(1n);
        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("multisig_t1_txid"));
        const signatures = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signatures);
        expect(await oxoBTC.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("Multisig: threshold=3 — 2 imzayla revert atar", async function () {
        await deployContracts();
        const [, signer2, signer3] = await ethers.getSigners();
        const SIGNER_ROLE = await bridge.SIGNER_ROLE();
        await bridge.grantRole(SIGNER_ROLE, signer2.address);
        await bridge.grantRole(SIGNER_ROLE, signer3.address);
        await bridge.setSignerThreshold(3);

        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("multisig_t3_fail_txid"));
        // Sadece 2 imza (owner + signer2) — threshold karşılanmaz
        const twoSigs = await signMintMulti([owner, signer2], user.address, mintAmount, depositId);
        await expect(
            bridge.mintAndTransfer(user.address, mintAmount, depositId, twoSigs)
        ).to.be.revertedWith("BRIDGE: INSUFFICIENT_SIGNATURES");
    });

    it("Multisig: threshold=3 — 3 geçerli imzayla mint başarılı", async function () {
        await deployContracts();
        const [, signer2, signer3] = await ethers.getSigners();
        const SIGNER_ROLE = await bridge.SIGNER_ROLE();
        await bridge.grantRole(SIGNER_ROLE, signer2.address);
        await bridge.grantRole(SIGNER_ROLE, signer3.address);
        await bridge.setSignerThreshold(3);

        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("multisig_t3_ok_txid"));
        const threeSigs  = await signMintMulti([owner, signer2, signer3], user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, threeSigs);
        expect(await oxoBTC.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("Multisig: duplicate imza sayılmaz (threshold=2 iken aynı imza 2 kez gönderilse revert)", async function () {
        await deployContracts();
        await bridge.setSignerThreshold(2);

        const mintAmount = ethers.parseUnits("0.001", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("multisig_dup_txid"));
        const sig        = (await signMint(owner, user.address, mintAmount, depositId))[0];
        // Aynı imzayı iki kez gönder → duplicate sayılmaz, validCount=1 < threshold=2
        await expect(
            bridge.mintAndTransfer(user.address, mintAmount, depositId, [sig, sig])
        ).to.be.revertedWith("BRIDGE: INSUFFICIENT_SIGNATURES");
    });

    it("State machine: withdraw oluşturur → Pending (state=0)", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_pending_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const redeemAmount = ethers.parseUnits("0.005", 8);
        const tx = await bridge.connect(user).withdraw("tb1qtest", redeemAmount);
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment?.name === "RedeemRequested");
        const redeemHash = event.args.redeemHash;

        const info = await bridge.getRedeemInfo(redeemHash);
        expect(info.state).to.equal(0n); // Pending = 0
        expect(info.requestedAt).to.be.gt(0n);
    });

    it("State machine: markProcessing → Processing (state=1)", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_processing_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        await expect(bridge.markProcessing(redeemHash))
            .to.emit(bridge, "RedeemProcessing")
            .withArgs(redeemHash, owner.address);

        expect((await bridge.getRedeemInfo(redeemHash)).state).to.equal(1n); // Processing = 1
    });

    it("State machine: Processing → markRedeemCompleted → Completed (state=2)", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_completed_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        await bridge.markProcessing(redeemHash);
        await expect(bridge.markRedeemCompleted(redeemHash, mintAmount))
            .to.emit(bridge, "RedeemCompleted")
            .withArgs(redeemHash, mintAmount, owner.address);

        expect((await bridge.getRedeemInfo(redeemHash)).state).to.equal(2n); // Completed = 2
    });

    it("State machine: markRedeemCompleted Pending'den çağrılamaz (Processing gerekir)", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_noprocessing_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        // markProcessing çağrılmadan direkt complete → revert
        await expect(bridge.markRedeemCompleted(redeemHash, mintAmount))
            .to.be.revertedWith("Redeem: Not processing");
    });

    it("State machine: cancelRedeem timeout geçmeden revert atar", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_cancel_early_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        await expect(bridge.connect(user).cancelRedeem(redeemHash))
            .to.be.revertedWith("Redeem: Timeout not reached");
    });

    it("State machine: cancelRedeem 24h sonra oxoBTC'yi geri mint eder", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_cancel_ok_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        // oxoBTC MINTER_ROLE'u bridge'e ver (cancel için re-mint gerekli)
        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER_ROLE, bridge.target);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const balBefore = await oxoBTC.balanceOf(user.address);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        // 24 saat + 1 sn ileri sar
        await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
        await ethers.provider.send("evm_mine", []);

        await expect(bridge.connect(user).cancelRedeem(redeemHash))
            .to.emit(bridge, "RedeemCancelled")
            .withArgs(redeemHash, user.address, mintAmount);

        // oxoBTC kullanıcıya geri döndü
        expect(await oxoBTC.balanceOf(user.address)).to.equal(balBefore);
        expect((await bridge.getRedeemInfo(redeemHash)).state).to.equal(3n); // Cancelled = 3
    });

    it("State machine: Processing'deyken cancelRedeem engellenir", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId  = ethers.keccak256(ethers.toUtf8Bytes("sm_cancel_blocked_txid"));
        const sig        = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, sig);

        await oxoBTC.connect(user).approve(bridge.target, mintAmount);
        const tx = await bridge.connect(user).withdraw("tb1qtest", mintAmount);
        const receipt = await tx.wait();
        const redeemHash = receipt.logs.find(l => l.fragment?.name === "RedeemRequested").args.redeemHash;

        await bridge.markProcessing(redeemHash); // Processing'e al

        // 24 saat geçse bile Processing'deyse cancel edilemez
        await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
        await ethers.provider.send("evm_mine", []);

        await expect(bridge.connect(user).cancelRedeem(redeemHash))
            .to.be.revertedWith("Redeem: Not cancellable");
    });

    it("ETH → BTC: should track withdraw nonces per user", async function () {
        await deployContracts();
        const mintAmount = ethers.parseUnits("0.01", 8);
        const depositId = ethers.keccak256(ethers.toUtf8Bytes("nonce_test_txid"));

        const signature = await signMint(owner, user.address, mintAmount, depositId);
        await bridge.mintAndTransfer(user.address, mintAmount, depositId, signature);

        const redeemAmount = ethers.parseUnits("0.001", 8);
        await oxoBTC.connect(user).approve(bridge.target, mintAmount);

        expect(await bridge.withdrawNonces(user.address)).to.equal(0n);
        await bridge.connect(user).withdraw("tb1qtest1", redeemAmount);
        expect(await bridge.withdrawNonces(user.address)).to.equal(1n);
        await bridge.connect(user).withdraw("tb1qtest2", redeemAmount);
        expect(await bridge.withdrawNonces(user.address)).to.equal(2n);
    });
});
