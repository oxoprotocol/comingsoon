// scripts/setup_staking.js
// Staking + Treasury zaten deploy edildi.
// Bu script: Bridge redeploy + tüm bağlantıları kurar.
//
// Kullanım:
//   npx hardhat run scripts/setup_staking.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");

// ─── Deploy edilen adresler ───────────────────────────────────────
const OXOBTC_ADDRESS   = "0xA6fB891D117ce6C03880168bADE140067ED44D78";
const OXO_ADDRESS      = "0xca0cd5448fabdfdc33f0795c871901c5e2bb60a8";
const ROUTER_ADDRESS   = "0xb898537873ab341557963db261563092c784e725";
const WETH_ADDRESS     = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

// Deploy edilmiş güncel adresler (Sepolia)
const STAKING_ADDRESS  = "0x54e8f0348EB1E531f72d94E89FF877bA6B9b460A";
const TREASURY_ADDRESS = "0xdCC5Eef80df9cF48F4504D476BB4701B17e7E361";

const BRIDGE_FEE_BPS   = 10; // %0.1

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    const staking  = await ethers.getContractAt("OXOStaking", STAKING_ADDRESS);
    const treasury = await ethers.getContractAt("ProtocolTreasury", TREASURY_ADDRESS);

    // ─── 1. BridgeV3 redeploy (fee hook'lu yeni versiyon) ────────
    console.log("1/4 BridgeV3 (yeni) deploy ediliyor...");
    const BridgeV3 = await ethers.getContractFactory("BridgeV3");
    const bridge   = await BridgeV3.deploy(OXOBTC_ADDRESS);
    await bridge.waitForDeployment();
    const BRIDGE_ADDRESS = await bridge.getAddress();
    console.log("   BridgeV3 (yeni):", BRIDGE_ADDRESS);

    // OXOBTC'ye yeni bridge'e MINTER_ROLE ver
    const oxoBTC      = await ethers.getContractAt("OXOBTC", OXOBTC_ADDRESS);
    const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
    let tx = await oxoBTC.grantRole(MINTER_ROLE, BRIDGE_ADDRESS);
    await tx.wait();
    console.log("   MINTER_ROLE → yeni Bridge");

    // ─── 2. Staking → Treasury bağlantısı ────────────────────────
    console.log("\n2/4 Staking → Treasury bağlantısı...");
    tx = await staking.setTreasury(TREASURY_ADDRESS);
    await tx.wait();
    console.log("   TREASURY_ROLE →", TREASURY_ADDRESS);

    // ─── 3. Treasury → Bridge + Router FEEDER_ROLE ───────────────
    console.log("\n3/4 Treasury feeder'ları ayarlanıyor...");
    tx = await treasury.addFeeder(BRIDGE_ADDRESS);
    await tx.wait();
    console.log("   FEEDER_ROLE → Bridge");

    tx = await treasury.addFeeder(ROUTER_ADDRESS);
    await tx.wait();
    console.log("   FEEDER_ROLE → Router");

    // ─── 4. Bridge → Treasury fee hook ───────────────────────────
    console.log("\n4/4 Bridge fee hook aktif ediliyor...");
    tx = await bridge.setTreasury(TREASURY_ADDRESS, BRIDGE_FEE_BPS);
    await tx.wait();
    tx = await bridge.setFeeEnabled(true);
    await tx.wait();
    console.log("   Treasury set, fee %0.1 aktif");

    // ─── Özet ─────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════");
    console.log("SETUP TAMAMLANDI");
    console.log("═══════════════════════════════════════");
    console.log("STAKING  :", STAKING_ADDRESS);
    console.log("TREASURY :", TREASURY_ADDRESS);
    console.log("BRIDGE   :", BRIDGE_ADDRESS, "(YENİ)");
    console.log("\n⚠  Backend .env güncellenmeli:");
    console.log("   BRIDGE_ADDRESS=" + BRIDGE_ADDRESS);
    console.log("\n⚠  Frontend CONFIG güncellenmeli:");
    console.log("   BRIDGE:", BRIDGE_ADDRESS);
    console.log("\n⚠  OXO emisyon fonu için:");
    console.log("   OXO token'dan Staking'e 10M OXO approve + fundOxoRewards()");

    // Dosyaya kaydet
    const output = [
        `STAKING_ADDRESS=${STAKING_ADDRESS}`,
        `TREASURY_ADDRESS=${TREASURY_ADDRESS}`,
        `BRIDGE_ADDRESS=${BRIDGE_ADDRESS}`,
    ].join("\n") + "\n";
    fs.writeFileSync("deployment-staking.txt", output);
    console.log("\ndeployment-staking.txt kaydedildi.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
