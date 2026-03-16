const { ethers } = require("hardhat");

// Sepolia Chainlink oracles
const BTC_USD_ORACLE = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
const ETH_USD_ORACLE = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploy eden:", deployer.address);

    const OXOBTC_ADDRESS = process.env.TOKEN_ADDRESS || "0xA6fB891D117ce6C03880168bADE140067ED44D78";

    console.log("\n📦 OXOLending deploy ediliyor...");
    const Lending = await ethers.getContractFactory("OXOLending");
    const lending = await Lending.deploy(OXOBTC_ADDRESS, BTC_USD_ORACLE, ETH_USD_ORACLE);
    await lending.waitForDeployment();
    console.log("✅ OXOLending:", lending.target);

    // İlk likiditeyi yükle (0.1 ETH)
    const seed = ethers.parseEther("0.1");
    await deployer.sendTransaction({ to: lending.target, value: seed });
    console.log("💧 İlk likidite yüklendi: 0.1 ETH");

    console.log("\n=== DEPLOY ÖZET ===");
    console.log("LENDING:", lending.target);
    console.log("BTC/USD Oracle:", BTC_USD_ORACLE);
    console.log("ETH/USD Oracle:", ETH_USD_ORACLE);
    console.log("LTV: %70 | Likidite Eşiği: %80 | Bonus: %10 | Faiz: %5 APR");
}

main().catch(e => { console.error(e); process.exit(1); });
