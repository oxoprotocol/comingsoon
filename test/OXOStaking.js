const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { time }         = require("@nomicfoundation/hardhat-network-helpers");

// BTC fiyatı: $85,000 → Chainlink 8 decimal formatı
const BTC_PRICE_USD   = 85_000n * 10n ** 8n;   // 8_500_000_000
// $50'lık min stake: (50 * 1e8 * 1e18) / (85_000 * 1e18) ≈ 58_824 units
const MIN_STAKE       = 60_000n;                 // > minOxoBtcStake, biraz pay bırak
const STAKE_AMOUNT    = 1_000_000n;              // 0.01 oxoBTC (8 dec) — yeterince büyük
const OXO_PER_SECOND  = ethers.parseUnits("0.1", 18); // 0.1 OXO/saniye
const THREE_DAYS      = 3 * 24 * 60 * 60;

describe("OXO Staking & Treasury", function () {

    // ─── Ortak değişkenler ──────────────────────────────────────
    let owner, treasury_addr, user1, user2;
    let oxoBTC, oxo, oracle, staking, treasury;

    // ─── Deploy yardımcısı ──────────────────────────────────────
    async function deployAll() {
        [owner, treasury_addr, user1, user2] = await ethers.getSigners();

        // OXOBTC token
        const OXOBTC = await ethers.getContractFactory("OXOBTC");
        oxoBTC = await OXOBTC.deploy("oxoBTC Token", "oxoBTC");

        // OXO governance token
        const OXO = await ethers.getContractFactory("OXO");
        oxo = await OXO.deploy();

        // Mock Chainlink oracle ($85k BTC)
        const Oracle = await ethers.getContractFactory("MockAggregatorV3");
        oracle = await Oracle.deploy(BTC_PRICE_USD);

        // OXOStaking
        const Staking = await ethers.getContractFactory("OXOStaking");
        staking = await Staking.deploy(
            oxoBTC.target,
            oxo.target,
            OXO_PER_SECOND,
            oracle.target,
            owner.address
        );

        // ProtocolTreasury (router yerine owner adresi — testlerde POL çağrılmıyor)
        const Treasury = await ethers.getContractFactory("ProtocolTreasury");
        treasury = await Treasury.deploy(
            oxoBTC.target,
            staking.target,
            owner.address, // mock router
            owner.address, // mock WETH
            owner.address
        );

        // Bağlantılar
        await staking.setTreasury(treasury.target);
        await treasury.addFeeder(owner.address); // test için owner feeder olacak

        // Min stake $50 olarak ayarla
        await staking.setMinStakeUsd(50);

        // oxoBTC mint yetkisi owner'a ver
        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER_ROLE, owner.address);

        // Kullanıcılara oxoBTC dağıt
        await oxoBTC.mint(user1.address, 10_000_000n); // 0.1 oxoBTC
        await oxoBTC.mint(user2.address, 10_000_000n);

        // OXO emisyon fonunu staking'e yükle (10M OXO)
        const fundAmount = ethers.parseUnits("10000000", 18);
        await oxo.approve(staking.target, fundAmount);
        await staking.fundOxoRewards(fundAmount);
    }

    // ═══════════════════════════════════════════════════════════
    //  DEPLOY & ORACLE
    // ═══════════════════════════════════════════════════════════

    describe("Deploy & Oracle", function () {
        beforeEach(deployAll);

        it("tüm contract'lar doğru deploy edilmeli", async function () {
            expect(staking.target).to.not.equal(ethers.ZeroAddress);
            expect(treasury.target).to.not.equal(ethers.ZeroAddress);
            expect(await staking.oxoBTC()).to.equal(oxoBTC.target);
            expect(await staking.oxo()).to.equal(oxo.target);
        });

        it("oracle BTC fiyatını doğru okumalı", async function () {
            const price = await staking.getBtcPrice();
            // Chainlink answer * 1e10 = 85_000 * 1e8 * 1e10 = 85_000e18
            expect(price).to.equal(85_000n * 10n ** 18n);
        });

        it("minimum oxoBTC stake $50 eşdeğeri olmalı", async function () {
            const min = await staking.minOxoBtcStake();
            // 50 * 1e8 * 1e18 / (85_000 * 1e18) = 58_823
            expect(min).to.be.closeTo(58_823n, 5n);
        });

        it("stale oracle revert etmeli", async function () {
            await oracle.setStale();
            await expect(staking.getBtcPrice()).to.be.revertedWith("Oracle: stale price");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  POOL 0 — oxoBTC → OXO Emisyon
    // ═══════════════════════════════════════════════════════════

    describe("Pool 0 — oxoBTC Staking", function () {
        beforeEach(deployAll);

        it("minimum altında stake revert etmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, 1000n);
            await expect(
                staking.connect(user1).stakeOxoBTC(1000n)
            ).to.be.revertedWith("Below $50 minimum");
        });

        it("oxoBTC stake edilebilmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await expect(staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT))
                .to.emit(staking, "Staked")
                .withArgs(user1.address, 0, STAKE_AMOUNT);

            const u = await staking.usersPool0(user1.address);
            expect(u.staked).to.equal(STAKE_AMOUNT);
            expect(await oxoBTC.balanceOf(staking.target)).to.be.gte(STAKE_AMOUNT);
        });

        it("zaman geçtikçe OXO ödülü birikebilmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);

            await time.increase(100); // 100 saniye

            const pending = await staking.pendingOxo(user1.address);
            // 100 sn * 0.1 OXO/sn = 10 OXO (tek staker olduğu için %100)
            expect(pending).to.be.closeTo(
                ethers.parseUnits("10", 18),
                ethers.parseUnits("0.1", 18) // ±0.1 OXO tolerans
            );
        });

        it("OXO ödülü claim edilebilmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);
            await time.increase(100);

            const before = await oxo.balanceOf(user1.address);
            await staking.connect(user1).claimPool0();
            const after = await oxo.balanceOf(user1.address);

            expect(after - before).to.be.gt(0n);
        });

        it("unstake cooldown başlatılabilmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);

            await expect(staking.connect(user1).requestUnstakeOxoBTC(STAKE_AMOUNT))
                .to.emit(staking, "UnstakeRequested");

            const u = await staking.usersPool0(user1.address);
            expect(u.cooldownAmount).to.equal(STAKE_AMOUNT);
            expect(u.staked).to.equal(0n);
        });

        it("cooldown bitmeden withdraw revert etmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);
            await staking.connect(user1).requestUnstakeOxoBTC(STAKE_AMOUNT);

            await time.increase(ONE_DAY); // sadece 1 gün
            await expect(
                staking.connect(user1).withdrawOxoBTC()
            ).to.be.revertedWith("Cooldown not finished");
        });

        it("3 gün sonra oxoBTC withdraw edilebilmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);
            await staking.connect(user1).requestUnstakeOxoBTC(STAKE_AMOUNT);

            await time.increase(THREE_DAYS + 1);

            const before = await oxoBTC.balanceOf(user1.address);
            await staking.connect(user1).withdrawOxoBTC();
            const after = await oxoBTC.balanceOf(user1.address);

            expect(after - before).to.equal(STAKE_AMOUNT);
        });

        it("iki kullanıcı staking yaparsa ödül orantılı bölünmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);

            await oxoBTC.connect(user2).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user2).stakeOxoBTC(STAKE_AMOUNT);

            await time.increase(100);

            const p1 = await staking.pendingOxo(user1.address);
            const p2 = await staking.pendingOxo(user2.address);

            // Aynı miktar stake → ödüller yaklaşık eşit
            const diff = p1 > p2 ? p1 - p2 : p2 - p1;
            expect(diff).to.be.lt(ethers.parseUnits("1", 18)); // < 1 OXO fark
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  POOL 0 → POOL 1 COMPOUND
    // ═══════════════════════════════════════════════════════════

    describe("Compound (Pool0 → Pool1)", function () {
        beforeEach(deployAll);

        it("compound OXO ödülünü Pool 1'e stake etmeli", async function () {
            await oxoBTC.connect(user1).approve(staking.target, STAKE_AMOUNT);
            await staking.connect(user1).stakeOxoBTC(STAKE_AMOUNT);

            await time.increase(100);

            const pending = await staking.pendingOxo(user1.address);
            expect(pending).to.be.gt(0n);

            await expect(staking.connect(user1).compound())
                .to.emit(staking, "Compounded");

            // Pool 1'de OXO stake olmuş olmalı
            const u1 = await staking.usersPool1(user1.address);
            expect(u1.staked).to.be.gt(0n);

            // Pool 0 pending sıfırlanmış olmalı
            expect(await staking.pendingOxo(user1.address)).to.be.lt(
                ethers.parseUnits("0.2", 18) // sadece yeni blok birikimi
            );
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  POOL 1 — OXO → Protocol Fee
    // ═══════════════════════════════════════════════════════════

    describe("Pool 1 — OXO Staking", function () {
        beforeEach(deployAll);

        it("OXO stake edilebilmeli", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await expect(staking.stakeOXO(stakeOxo))
                .to.emit(staking, "Staked")
                .withArgs(owner.address, 1, stakeOxo);

            const u = await staking.usersPool1(owner.address);
            expect(u.staked).to.equal(stakeOxo);
        });

        it("ETH fee dağıtılınca staker'a yansımalı", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            const feeAmount = ethers.parseEther("1"); // 1 ETH fee
            // TREASURY_ROLE ile fee gönder
            await staking.distributeEthFee({ value: feeAmount });

            const [ethPending] = await staking.pendingFees(owner.address);
            expect(ethPending).to.equal(feeAmount);
        });

        it("oxoBTC fee dağıtılınca staker'a yansımalı", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            const feeAmount = 100_000n; // 0.001 oxoBTC
            await oxoBTC.mint(owner.address, feeAmount);
            await oxoBTC.approve(staking.target, feeAmount);
            await staking.distributeOxoBtcFee(feeAmount);

            const [, oxoBtcPending] = await staking.pendingFees(owner.address);
            expect(oxoBtcPending).to.equal(feeAmount);
        });

        it("ETH + oxoBTC ödülleri claim edilebilmeli", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            const ethFee    = ethers.parseEther("0.5");
            const oxoBtcFee = 50_000n;

            await staking.distributeEthFee({ value: ethFee });
            await oxoBTC.mint(owner.address, oxoBtcFee);
            await oxoBTC.approve(staking.target, oxoBtcFee);
            await staking.distributeOxoBtcFee(oxoBtcFee);

            const ethBefore    = await ethers.provider.getBalance(owner.address);
            const oxoBtcBefore = await oxoBTC.balanceOf(owner.address);

            const tx = await staking.claimPool1();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * tx.gasPrice;

            const ethAfter    = await ethers.provider.getBalance(owner.address);
            const oxoBtcAfter = await oxoBTC.balanceOf(owner.address);

            expect(ethAfter - ethBefore + gasUsed).to.equal(ethFee);
            expect(oxoBtcAfter - oxoBtcBefore).to.equal(oxoBtcFee);
        });

        it("OXO unstake 3 gün cooldown çalışmalı", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            await staking.requestUnstakeOXO(stakeOxo);

            // Cooldown bitmeden withdraw denemesi
            await expect(staking.withdrawOXO()).to.be.revertedWith("Cooldown not finished");

            await time.increase(THREE_DAYS + 1);

            const before = await oxo.balanceOf(owner.address);
            await staking.withdrawOXO();
            const after = await oxo.balanceOf(owner.address);
            expect(after - before).to.equal(stakeOxo);
        });

        it("fee staker yokken dağıtılırsa kaybolmamalı (totalStaked=0)", async function () {
            // Pool 1'de kimse yok — fee gönderilse de revert olmamalı
            const feeAmount = ethers.parseEther("1");
            await expect(
                staking.distributeEthFee({ value: feeAmount })
            ).to.not.be.reverted;
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  PROTOCOL TREASURY
    // ═══════════════════════════════════════════════════════════

    describe("ProtocolTreasury", function () {
        beforeEach(deployAll);

        it("oranlar toplamı 10000 olmalı, yanlışsa revert etmeli", async function () {
            await expect(
                treasury.setShares(5000, 3000, 1000, 0) // toplam 9000
            ).to.be.revertedWith("Must sum to 10000");
        });

        it("oranlar güncellenebilmeli", async function () {
            await treasury.setShares(6000, 2500, 1000, 500);
            expect(await treasury.stakersShare()).to.equal(6000n);
            expect(await treasury.polShare()).to.equal(2500n);
            expect(await treasury.reserveShare()).to.equal(1000n);
            expect(await treasury.buybackShare()).to.equal(500n);
        });

        it("ETH fee alınca eşik geçince otomatik dağıtılmalı", async function () {
            // OXO Pool 1'e stake et ki fee gelebilsin
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            // TREASURY_ROLE ver staking'e (treasury çağıracak)
            // zaten setTreasury ile verildi

            // Eşiği düşür (0.01 ETH) ve üstünde gönder
            await treasury.setThresholds(
                ethers.parseEther("0.01"),
                1000n
            );

            const sendAmount = ethers.parseEther("0.1"); // > eşik
            await treasury.receiveFeeETH({ value: sendAmount });

            // %70'i staker'a gitmiş olmalı
            const [ethPending] = await staking.pendingFees(owner.address);
            const expected = (sendAmount * 7000n) / 10000n;
            expect(ethPending).to.equal(expected);

            // %10'u reserve'de birikmeli
            expect(await treasury.reserveETH()).to.be.gt(0n);
        });

        it("oxoBTC fee alınca dağıtılmalı", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            await treasury.setThresholds(
                ethers.parseEther("10"), // ETH eşiği yüksek tut
                1000n                    // oxoBTC eşiği düşük
            );

            const feeAmount = 10_000n;
            await oxoBTC.mint(owner.address, feeAmount);
            await oxoBTC.approve(treasury.target, feeAmount);
            await treasury.receiveFeeOxoBtc(feeAmount);

            const [, oxoBtcPending] = await staking.pendingFees(owner.address);
            const expected = (feeAmount * 7000n) / 10000n;
            expect(oxoBtcPending).to.equal(expected);
        });

        it("distributeNow manuel dağıtım çalışmalı", async function () {
            const stakeOxo = ethers.parseUnits("1000", 18);
            await oxo.approve(staking.target, stakeOxo);
            await staking.stakeOXO(stakeOxo);

            // Eşiği çok yüksek tut → otomatik tetiklenmesin
            await treasury.setThresholds(
                ethers.parseEther("100"),
                1_000_000n
            );

            // ETH gönder (eşiğin altında)
            await owner.sendTransaction({ to: treasury.target, value: ethers.parseEther("0.05") });

            // Manuel dağıt
            await treasury.distributeNow();

            const [ethPending] = await staking.pendingFees(owner.address);
            expect(ethPending).to.be.gt(0n);
        });

        it("useReserve stability reserve'den çekim yapılabilmeli", async function () {
            // Reserve'e bir miktar biriktir
            await treasury.setThresholds(
                ethers.parseEther("0.001"),
                1n
            );
            await treasury.receiveFeeETH({ value: ethers.parseEther("0.1") });

            const reserveBefore = await treasury.reserveETH();
            expect(reserveBefore).to.be.gt(0n);

            const balanceBefore = await ethers.provider.getBalance(user1.address);
            await treasury.useReserve(user1.address, reserveBefore, 0n);
            const balanceAfter = await ethers.provider.getBalance(user1.address);

            expect(balanceAfter - balanceBefore).to.equal(reserveBefore);
            expect(await treasury.reserveETH()).to.equal(0n);
        });

        it("FEEDER_ROLE olmadan fee gönderilemez", async function () {
            await expect(
                treasury.connect(user1).receiveFeeETH({ value: ethers.parseEther("0.1") })
            ).to.be.reverted;
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  ADMIN KONTROLLER
    // ═══════════════════════════════════════════════════════════

    describe("Admin Kontroller", function () {
        beforeEach(deployAll);

        it("emisyon hızı güncellenebilmeli", async function () {
            const newRate = ethers.parseUnits("0.2", 18);
            await expect(staking.setOxoPerSecond(newRate))
                .to.emit(staking, "EmissionUpdated")
                .withArgs(newRate);

            const p = await staking.pool0();
            expect(p.oxoPerSecond).to.equal(newRate);
        });

        it("oracle adresi güncellenebilmeli", async function () {
            const Oracle2 = await ethers.getContractFactory("MockAggregatorV3");
            const oracle2 = await Oracle2.deploy(90_000n * 10n ** 8n);

            await staking.setOracle(oracle2.target);
            const price = await staking.getBtcPrice();
            expect(price).to.equal(90_000n * 10n ** 18n);
        });

        it("yetkisiz kullanıcı admin fonksiyonu çağıramamalı", async function () {
            await expect(
                staking.connect(user1).setOxoPerSecond(1n)
            ).to.be.reverted;

            await expect(
                treasury.connect(user1).distributeNow()
            ).to.be.reverted;
        });
    });
});

// Helper
const ONE_DAY = 24 * 60 * 60;
