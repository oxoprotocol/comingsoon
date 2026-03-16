// scripts/deploy_flashexit.js
// FlashExit contract'ını Sepolia'ya deploy eder.
//
// Kullanım:
//   npx hardhat run scripts/deploy_flashexit.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");

// ─── Mevcut deploy edilmiş adresler ───────────────────────────────
const OXOBTC_ADDRESS  = "0xA6fB891D117ce6C03880168bADE140067ED44D78";
const WETH_ADDRESS    = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const ROUTER_ADDRESS  = "0xb898537873ab341557963db261563092c784e725";
const FACTORY_ADDRESS = "0xe969090d30f76e8b7969db2113d7572b5944e842";
const BRIDGE_ADDRESS  = "0x1bff71d8Eb29666DE2238A52E296320d2E98645D";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    console.log("FlashExit deploy ediliyor...");
    const FlashExit = await ethers.getContractFactory("FlashExit");
    const flashExit = await FlashExit.deploy(
        OXOBTC_ADDRESS,
        WETH_ADDRESS,
        ROUTER_ADDRESS,
        FACTORY_ADDRESS,
        BRIDGE_ADDRESS,
        deployer.address  // admin
    );
    await flashExit.waitForDeployment();
    const FLASH_EXIT_ADDRESS = await flashExit.getAddress();
    console.log("   FlashExit:", FLASH_EXIT_ADDRESS);

    // Doğrulama
    const feeBps        = await flashExit.exitFeeBps();
    const chunkInterval = await flashExit.chunkInterval();
    const maxChunks     = await flashExit.maxChunks();
    console.log("\nParametreler:");
    console.log("   exitFeeBps     :", feeBps.toString(), "(%0.1)");
    console.log("   chunkInterval  :", chunkInterval.toString(), "saniye");
    console.log("   maxChunks      :", maxChunks.toString());

    // ─── Özet ───────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════");
    console.log("DEPLOY TAMAMLANDI");
    console.log("═══════════════════════════════════════");
    console.log("FLASH_EXIT:", FLASH_EXIT_ADDRESS);
    console.log("\n⚠  Frontend CONFIG'de güncelle:");
    console.log("   FLASH_EXIT:", FLASH_EXIT_ADDRESS);

    // Dosyaya kaydet
    const existing = fs.existsSync("deployment-staking.txt")
        ? fs.readFileSync("deployment-staking.txt", "utf8")
        : "";
    const hasLine = existing.includes("FLASH_EXIT_ADDRESS=");
    const updated = hasLine
        ? existing.replace(/FLASH_EXIT_ADDRESS=.*/, `FLASH_EXIT_ADDRESS=${FLASH_EXIT_ADDRESS}`)
        : existing + `FLASH_EXIT_ADDRESS=${FLASH_EXIT_ADDRESS}\n`;
    fs.writeFileSync("deployment-staking.txt", updated);
    console.log("\ndeployment-staking.txt güncellendi.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
