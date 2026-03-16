const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");

// BTC $85,000 | ETH $3,000 → 1 BTC ≈ 28.33 ETH
const BTC_USD = 85_000n * 10n ** 8n;
const ETH_USD =  3_000n * 10n ** 8n;

// 0.01 oxoBTC = 1_000_000 units (8 dec)
const ONE_MILLI_BTC = 1_000_000n; // 0.01 BTC ≈ 0.2833 ETH

describe("OXO Lending", function () {
    let owner, user, liquidator;
    let oxoBTC, btcOracle, ethOracle, lending;

    async function deployAll() {
        [owner, user, liquidator] = await ethers.getSigners();

        const OXOBTC = await ethers.getContractFactory("OXOBTC");
        oxoBTC = await OXOBTC.deploy("oxoBTC Token", "oxoBTC");

        const Oracle = await ethers.getContractFactory("MockAggregatorV3");
        btcOracle = await Oracle.deploy(BTC_USD);
        ethOracle = await Oracle.deploy(ETH_USD);

        const Lending = await ethers.getContractFactory("OXOLending");
        lending = await Lending.deploy(oxoBTC.target, btcOracle.target, ethOracle.target);

        // oxoBTC mint yetkisi
        const MINTER = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER, owner.address);
        await oxoBTC.mint(user.address, 100_000_000n); // 1 BTC

        // Likidite: 10 ETH yükle
        await owner.sendTransaction({ to: lending.target, value: ethers.parseEther("10") });
    }

    // ═══════════════════════════════════════════════════════════
    //  DEPLOY
    // ═══════════════════════════════════════════════════════════
    describe("Deploy", function () {
        beforeEach(deployAll);

        it("doğru deploy edilmeli", async function () {
            expect(await lending.oxoBTC()).to.equal(oxoBTC.target);
            expect(await lending.baseRateBps()).to.equal(500n);
            expect(await ethers.provider.getBalance(lending.target)).to.equal(ethers.parseEther("10"));
        });

        it("oracle fiyatlarını doğru okumalı", async function () {
            expect(await lending.getBtcUsd()).to.equal(BTC_USD);
            expect(await lending.getEthUsd()).to.equal(ETH_USD);
        });

        it("oxoBtcToEth dönüşümü doğru olmalı", async function () {
            // 1 BTC (100_000_000 sat) = 85000/3000 ETH ≈ 28.33 ETH
            const ethVal = await lending.oxoBtcToEth(100_000_000n);
            const expected = ethers.parseEther("28.333333333333333333");
            expect(ethVal).to.be.closeTo(expected, ethers.parseEther("0.001"));
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  COLLATERAL
    // ═══════════════════════════════════════════════════════════
    describe("Collateral", function () {
        beforeEach(deployAll);

        it("oxoBTC teminat yatırılabilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await expect(lending.connect(user).depositCollateral(ONE_MILLI_BTC))
                .to.emit(lending, "CollateralDeposited")
                .withArgs(user.address, ONE_MILLI_BTC);
            const pos = await lending.positions(user.address);
            expect(pos.collateral).to.equal(ONE_MILLI_BTC);
        });

        it("sıfır teminat yatırılamaz", async function () {
            await expect(lending.connect(user).depositCollateral(0))
                .to.be.revertedWith("Zero amount");
        });

        it("borçsuz teminat çekilebilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            await lending.connect(user).withdrawCollateral(ONE_MILLI_BTC);
            const pos = await lending.positions(user.address);
            expect(pos.collateral).to.equal(0n);
        });

        it("borçlu iken teminatin tamamı çekilemez", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);
            await expect(lending.connect(user).withdrawCollateral(ONE_MILLI_BTC))
                .to.be.revertedWith("Undercollateralized");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  BORROW
    // ═══════════════════════════════════════════════════════════
    describe("Borrow", function () {
        beforeEach(deployAll);

        it("LTV sınırına kadar ETH borç alınabilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);

            const max = await lending.maxBorrow(user.address);
            // 0.01 BTC = $850 → %70 LTV → $595 → 595/3000 ≈ 0.19833 ETH
            expect(max).to.be.gt(0n);

            const before = await ethers.provider.getBalance(user.address);
            await lending.connect(user).borrow(max);
            const after = await ethers.provider.getBalance(user.address);
            expect(after).to.be.gt(before);
        });

        it("LTV üstünde borç alınamaz", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await expect(lending.connect(user).borrow(max + 1n))
                .to.be.revertedWith("Exceeds LTV");
        });

        it("teminatsız borç alınamaz", async function () {
            await expect(lending.connect(user).borrow(ethers.parseEther("0.1")))
                .to.be.revertedWith("Exceeds LTV");
        });

        it("likidite yoksa borç alınamaz", async function () {
            // Yeni lending, ETH yok
            const Lending = await ethers.getContractFactory("OXOLending");
            const empty = await Lending.deploy(oxoBTC.target, btcOracle.target, ethOracle.target);
            await oxoBTC.connect(user).approve(empty.target, ONE_MILLI_BTC);
            await empty.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await empty.maxBorrow(user.address);
            await expect(empty.connect(user).borrow(max))
                .to.be.revertedWith("Insufficient liquidity");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  REPAY
    // ═══════════════════════════════════════════════════════════
    describe("Repay", function () {
        beforeEach(deployAll);

        it("borç geri ödenebilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            // Faiz birikebilir — currentDebt + küçük buffer gönder, fazlası iade edilir
            const debt = await lending.currentDebt(user.address);
            const buffer = ethers.parseEther("0.01");
            await expect(lending.connect(user).repay({ value: debt + buffer }))
                .to.emit(lending, "Repaid");

            const pos = await lending.positions(user.address);
            expect(pos.debt).to.equal(0n);
        });

        it("fazla ödeme iade edilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            const extra = ethers.parseEther("5");
            const before = await ethers.provider.getBalance(user.address);
            const tx = await lending.connect(user).repay({ value: max + extra });
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const after = await ethers.provider.getBalance(user.address);
            // before - max(borrow repaid) - gas ≈ after
            expect(after).to.be.closeTo(before - max - gasCost, ethers.parseEther("0.001"));
        });

        it("borç yokken repay revert etmeli", async function () {
            await expect(lending.connect(user).repay({ value: ethers.parseEther("0.1") }))
                .to.be.revertedWith("No debt");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  FAİZ
    // ═══════════════════════════════════════════════════════════
    describe("Faiz", function () {
        beforeEach(deployAll);

        it("1 yıl sonra %5 faiz birikmiş olmalı", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            await time.increase(365 * 24 * 60 * 60); // 1 yıl

            const debt = await lending.currentDebt(user.address);
            const expectedInterest = max * 500n / 10000n; // %5
            expect(debt - max).to.be.closeTo(expectedInterest, max / 100n); // %1 tolerans
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  HEALTH FACTOR & LİKİDASYON
    // ═══════════════════════════════════════════════════════════
    describe("Health Factor & Likidасyon", function () {
        beforeEach(deployAll);

        it("borçsuz pozisyonun health factor'ı max olmalı", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            expect(await lending.healthFactor(user.address)).to.equal(ethers.MaxUint256);
        });

        it("sağlıklı pozisyon likide edilemez", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            await expect(
                lending.connect(liquidator).liquidate(user.address, { value: max })
            ).to.be.revertedWith("Position healthy");
        });

        it("fiyat düşünce pozisyon likide edilebilmeli", async function () {
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            // ETH fiyatı 2x → BTC/ETH oranı yarıya düşer → teminat değeri azalır
            // Yeni ETH $6000 → 1 BTC = 14.16 ETH, borç 0.7 * 28.33 * 0.5 = 9.91... sağlıksız
            const MockOracle = await ethers.getContractFactory("MockAggregatorV3");
            const newEthOracle = await MockOracle.deploy(6_000n * 10n ** 8n);
            await lending.setOracles(btcOracle.target, newEthOracle.target);

            expect(await lending.healthFactor(user.address)).to.be.lt(ethers.parseEther("1"));

            const liqBefore = await oxoBTC.balanceOf(liquidator.address);
            await lending.connect(liquidator).liquidate(user.address, { value: max });
            const liqAfter = await oxoBTC.balanceOf(liquidator.address);

            expect(liqAfter).to.be.gt(liqBefore); // likidatör oxoBTC kazandı
        });

        it("likidatör %10 bonus almalı", async function () {
            await oxoBTC.connect(user).approve(lending.target, 50_000_000n); // 0.5 BTC
            await lending.connect(user).depositCollateral(50_000_000n);
            const max = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(max);

            // ETH fiyatı artır
            const MockOracle = await ethers.getContractFactory("MockAggregatorV3");
            const highEth = await MockOracle.deploy(6_000n * 10n ** 8n);
            await lending.setOracles(btcOracle.target, highEth.target);

            const repayAmt = max / 2n;
            const beforeBal = await oxoBTC.balanceOf(liquidator.address);
            await lending.connect(liquidator).liquidate(user.address, { value: repayAmt });
            const afterBal = await oxoBTC.balanceOf(liquidator.address);

            const seized = afterBal - beforeBal;
            const debtValue = await lending.ethToOxoBtc(repayAmt);
            const expectedWithBonus = debtValue * 11000n / 10000n; // %110
            expect(seized).to.be.closeTo(expectedWithBonus, debtValue / 20n);
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  ADMİN
    // ═══════════════════════════════════════════════════════════
    describe("Admin", function () {
        beforeEach(deployAll);

        it("faiz oranı güncellenebilmeli", async function () {
            await lending.setBaseRate(1000); // %10
            expect(await lending.baseRateBps()).to.equal(1000n);
        });

        it("%50 üstü faiz revert etmeli", async function () {
            await expect(lending.setBaseRate(5001)).to.be.revertedWith("Max 50% APR");
        });

        it("aktif borç varken tüm ETH çekilemez", async function () {
            // Kullanıcı teminat yatır ve borç al
            await oxoBTC.connect(user).approve(lending.target, ONE_MILLI_BTC);
            await lending.connect(user).depositCollateral(ONE_MILLI_BTC);
            const borrowed = await lending.maxBorrow(user.address);
            await lending.connect(user).borrow(borrowed);

            // Kasadaki ETH tümü çekilmeye çalışılırsa revert
            const bal = await ethers.provider.getBalance(lending.target);
            await expect(lending.withdrawEth(bal)).to.be.revertedWith("Would underfund");
        });

        it("yetkisiz oracle güncellemesi revert etmeli", async function () {
            await expect(
                lending.connect(user).setOracles(btcOracle.target, ethOracle.target)
            ).to.be.reverted;
        });
    });
});
