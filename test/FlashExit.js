const { expect } = require("chai");
const { ethers }  = require("hardhat");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");

const CHUNK_INTERVAL = 30; // saniye

describe("FlashExit", function () {
    let owner, user, keeper;
    let oxoBTC, weth, factory, router, bridge, flashExit;

    // ─── Deploy yardımcısı ──────────────────────────────────────
    async function deployAll() {
        [owner, user, keeper] = await ethers.getSigners();

        // OXOBTC
        const OXOBTC = await ethers.getContractFactory("OXOBTC");
        oxoBTC = await OXOBTC.deploy("oxoBTC Token", "oxoBTC");

        // WETH
        const WETH = await ethers.getContractFactory("WETH");
        weth = await WETH.deploy();

        // Factory + Router
        const Factory = await ethers.getContractFactory("UniswapV2Factory");
        factory = await Factory.deploy(owner.address);

        const Router = await ethers.getContractFactory("UniswapV2Router02");
        router = await Router.deploy(factory.target, weth.target);

        // BridgeV3 (oxoBTC burnFrom için)
        const Bridge = await ethers.getContractFactory("BridgeV3");
        bridge = await Bridge.deploy(oxoBTC.target);

        // FlashExit
        const FlashExit = await ethers.getContractFactory("FlashExit");
        flashExit = await FlashExit.deploy(
            oxoBTC.target,
            weth.target,
            router.target,
            factory.target,
            bridge.target,
            owner.address
        );

        // oxoBTC mint yetkisi
        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER_ROLE, owner.address);
        await oxoBTC.grantRole(MINTER_ROLE, bridge.target);

        // Bridge'in burnFrom yapabilmesi için FlashExit approve edecek
        // (bu _sendToBridge içinde yapılıyor)

        // DEX için başlangıç likidite: 1 ETH ≈ 0.00001 oxoBTC (BTC/ETH ~1:100000)
        // Test amacıyla: 10 ETH + 0.001 oxoBTC → 1 ETH = 0.0001 oxoBTC
        const INIT_ETH     = ethers.parseEther("10");
        const INIT_OXOBTC  = 1_000_000n; // 0.01 oxoBTC (8 dec)

        await oxoBTC.mint(owner.address, INIT_OXOBTC * 10n);
        await oxoBTC.approve(router.target, INIT_OXOBTC);

        await router.addLiquidityETH(
            oxoBTC.target,
            INIT_OXOBTC,
            0, 0,
            owner.address,
            (await time.latest()) + 300,
            { value: INIT_ETH }
        );

        // Kullanıcıya ETH ver (hardhat varsayılan bakiye yeterli)
    }

    // ═══════════════════════════════════════════════════════════
    //  DEPLOY
    // ═══════════════════════════════════════════════════════════

    describe("Deploy", function () {
        beforeEach(deployAll);

        it("doğru deploy edilmeli", async function () {
            expect(await flashExit.oxoBTC()).to.equal(oxoBTC.target);
            expect(await flashExit.WETH()).to.equal(weth.target);
            expect(await flashExit.exitFeeBps()).to.equal(10n);
        });

        it("pool likiditesi okunabilmeli", async function () {
            const [ethRes, btcRes] = await flashExit.getPoolLiquidity();
            expect(ethRes).to.be.gt(0n);
            expect(btcRes).to.be.gt(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  QUOTE
    // ═══════════════════════════════════════════════════════════

    describe("getExitQuote", function () {
        beforeEach(deployAll);

        it("küçük miktar için 1 chunk döndürmeli (düşük slippage)", async function () {
            const smallEth = ethers.parseEther("0.01"); // pool'un %0.1'i → düşük slippage
            const [chunks, estimated, slippage] = await flashExit.getExitQuote(smallEth, 100);
            expect(chunks).to.equal(1n);
            expect(estimated).to.be.gt(0n);
            expect(slippage).to.be.lt(100n); // %1'den az
        });

        it("büyük miktar için birden fazla chunk döndürmeli", async function () {
            const bigEth = ethers.parseEther("5"); // pool'un %50'si → yüksek slippage
            const [chunks, , slippage] = await flashExit.getExitQuote(bigEth, 50); // max %0.5
            expect(chunks).to.be.gt(1n);
            expect(slippage).to.be.gt(50n);
        });

        it("sıfır likiditede (0,0) döndürmeli", async function () {
            // Yeni factory ile likiditesiz test
            const Factory2 = await ethers.getContractFactory("UniswapV2Factory");
            const factory2 = await Factory2.deploy(owner.address);
            const Router2  = await ethers.getContractFactory("UniswapV2Router02");
            const router2  = await Router2.deploy(factory2.target, weth.target);
            const FE2 = await ethers.getContractFactory("FlashExit");
            const fe2 = await FE2.deploy(oxoBTC.target, weth.target, router2.target, factory2.target, bridge.target, owner.address);

            const [chunks] = await fe2.getExitQuote(ethers.parseEther("1"), 100);
            expect(chunks).to.equal(0n);
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  EXIT INSTANT
    // ═══════════════════════════════════════════════════════════

    describe("exitInstant", function () {
        beforeEach(deployAll);

        it("ETH → oxoBTC swap yapıp bridge'e yönlendirmeli", async function () {
            const ethIn = ethers.parseEther("0.01");
            const [, estimated] = await flashExit.getExitQuote(ethIn, 200);
            const minOut = estimated * 90n / 100n; // %10 tolerans

            await expect(
                flashExit.connect(user).exitInstant("tb1qtest123", minOut, { value: ethIn })
            ).to.emit(flashExit, "ExitInstant");
        });

        it("minOxoBtcOut sağlanmazsa revert etmeli", async function () {
            const ethIn = ethers.parseEther("0.01");
            const impossibleMin = ethers.parseUnits("100", 8); // imkansız yüksek

            await expect(
                flashExit.connect(user).exitInstant("tb1qtest123", impossibleMin, { value: ethIn })
            ).to.be.reverted;
        });

        it("ETH gönderilmezse revert etmeli", async function () {
            await expect(
                flashExit.connect(user).exitInstant("tb1qtest123", 0, { value: 0 })
            ).to.be.revertedWith("No ETH sent");
        });

        it("boş BTC adresi revert etmeli", async function () {
            await expect(
                flashExit.connect(user).exitInstant("", 0, { value: ethers.parseEther("0.01") })
            ).to.be.revertedWith("Invalid BTC address");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  EXIT CHUNKED
    // ═══════════════════════════════════════════════════════════

    describe("exitChunked", function () {
        beforeEach(deployAll);

        it("sipariş oluşturmalı ve ilk chunk'ı çalıştırmalı", async function () {
            const ethIn = ethers.parseEther("5"); // büyük miktar
            const tx = await flashExit.connect(user).exitChunked("tb1qtest123", 50, { value: ethIn });
            const receipt = await tx.wait();

            // ExitOrderCreated event'inden toplam chunk sayısını al
            const event = receipt.logs
                .map(log => { try { return flashExit.interface.parseLog(log); } catch { return null; } })
                .find(e => e && e.name === "ExitOrderCreated");
            expect(event).to.not.be.undefined;
            const totalChunks = event.args.chunks;

            const orders = await flashExit.getUserOrders(user.address);
            expect(orders.length).to.equal(1);

            const order = await flashExit.getOrder(orders[0]);
            expect(order.user).to.equal(user.address);
            expect(order.completed).to.be.false;
            expect(order.cancelled).to.be.false;
            expect(order.chunksLeft).to.be.lt(totalChunks); // ilk chunk çalıştı
        });

        it("chunk interval geçmeden ikinci chunk revert etmeli", async function () {
            const ethIn = ethers.parseEther("5");
            await flashExit.connect(user).exitChunked("tb1qtest123", 50, { value: ethIn });
            const orders = await flashExit.getUserOrders(user.address);
            const orderId = orders[0];
            const order = await flashExit.getOrder(orderId);

            if (order.chunksLeft > 0n) {
                await expect(
                    flashExit.connect(keeper).executeNextChunk(orderId)
                ).to.be.revertedWith("Wait for chunk interval");
            }
        });

        it("chunk interval sonrası bir sonraki chunk çalıştırılabilmeli", async function () {
            const ethIn = ethers.parseEther("5");
            await flashExit.connect(user).exitChunked("tb1qtest123", 50, { value: ethIn });
            const orders = await flashExit.getUserOrders(user.address);
            const orderId = orders[0];
            const order = await flashExit.getOrder(orderId);

            if (order.chunksLeft > 0n) {
                await time.increase(CHUNK_INTERVAL + 1);
                await expect(
                    flashExit.connect(keeper).executeNextChunk(orderId)
                ).to.emit(flashExit, "ChunkExecuted");
            }
        });

        it("tüm chunk'lar bitince ExitCompleted emit edilmeli", async function () {
            // Küçük ETH ama küçük pool ile 2+ chunk zorla
            // chunkInterval=0 yaparak kolaylaştır
            await flashExit.setParams(50, 2, 0, 10); // 2 chunk max, interval=0

            const ethIn = ethers.parseEther("4"); // 2 chunk zorla
            const tx = await flashExit.connect(user).exitChunked("tb1qtest123", 50, { value: ethIn });
            const orders = await flashExit.getUserOrders(user.address);
            const orderId = orders[0];
            let order = await flashExit.getOrder(orderId);

            // Kalan chunk'ları çalıştır
            let i = 0;
            while (!order.completed && order.chunksLeft > 0n && i < 20) {
                await flashExit.connect(keeper).executeNextChunk(orderId);
                order = await flashExit.getOrder(orderId);
                i++;
            }
            expect(order.completed).to.be.true;
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  İPTAL
    // ═══════════════════════════════════════════════════════════

    describe("cancelOrder", function () {
        beforeEach(deployAll);

        it("aktif emri iptal edebilmeli ve ETH iade edilmeli", async function () {
            await flashExit.setParams(50, 10, 9999, 10); // uzun interval → chunk durur

            const ethIn = ethers.parseEther("3");
            await flashExit.connect(user).exitChunked("tb1qtest123", 100, { value: ethIn });
            const orders = await flashExit.getUserOrders(user.address);
            const orderId = orders[0];

            const balBefore = await ethers.provider.getBalance(user.address);
            const tx = await flashExit.connect(user).cancelOrder(orderId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * tx.gasPrice;
            const balAfter = await ethers.provider.getBalance(user.address);

            const order = await flashExit.getOrder(orderId);
            expect(order.cancelled).to.be.true;
            // Kalan ETH iade edilmiş olmalı (ilk chunk gitti)
            expect(balAfter + gasUsed).to.be.gt(balBefore);
        });

        it("başkasının emrini iptal edememeli", async function () {
            await flashExit.connect(user).exitChunked("tb1qtest123", 100, {
                value: ethers.parseEther("3")
            });
            const orders = await flashExit.getUserOrders(user.address);

            await expect(
                flashExit.connect(keeper).cancelOrder(orders[0])
            ).to.be.revertedWith("Not your order");
        });

        it("tamamlanmış emri iptal edememeli", async function () {
            await flashExit.setParams(50, 1, 0, 10); // 1 chunk, instant tamamlanır
            await flashExit.connect(user).exitChunked("tb1qtest123", 200, {
                value: ethers.parseEther("0.1")
            });
            const orders = await flashExit.getUserOrders(user.address);
            const order = await flashExit.getOrder(orders[0]);
            expect(order.completed).to.be.true;

            await expect(
                flashExit.connect(user).cancelOrder(orders[0])
            ).to.be.revertedWith("Order not active");
        });
    });

    // ═══════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════

    describe("Admin", function () {
        beforeEach(deployAll);

        it("parametreler güncellenebilmeli", async function () {
            await flashExit.setParams(200, 5, 60, 5);
            expect(await flashExit.defaultMaxSlippageBps()).to.equal(200n);
            expect(await flashExit.maxChunks()).to.equal(5n);
            expect(await flashExit.chunkInterval()).to.equal(60n);
            expect(await flashExit.exitFeeBps()).to.equal(5n);
        });

        it("bridge adresi güncellenebilmeli", async function () {
            const Bridge2 = await ethers.getContractFactory("BridgeV3");
            const bridge2 = await Bridge2.deploy(oxoBTC.target);
            await flashExit.setBridge(bridge2.target);
            expect(await flashExit.bridge()).to.equal(bridge2.target);
        });

        it("fee limitini aşarsa revert etmeli (%0.5 max)", async function () {
            await expect(
                flashExit.setParams(100, 5, 30, 100) // fee %1 → hata
            ).to.be.revertedWith("Max 0.5% fee");
        });

        it("yetkisiz admin işlemi revert etmeli", async function () {
            await expect(
                flashExit.connect(user).setParams(100, 5, 30, 5)
            ).to.be.reverted;
        });
    });
});
