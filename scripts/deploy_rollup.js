// scripts/deploy_rollup.js
// OXORollup + ZKVerifier'i Sepolia'ya deploy eder.
// Calistir: npx hardhat run scripts/deploy_rollup.js --network sepolia
//
// Gereklilikler:
//   .env dosyasinda OXOBTC_TOKEN_ADDRESS tanimli olmali
//   Oncesinde: node zk/scripts/setup.js (ZKVerifier.sol'u uretir)

const { ethers } = require("hardhat");
const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

const N_ACCOUNTS = 8;

async function computeZeroRoot() {
    const poseidon = await buildPoseidon();
    const inputs = Array(N_ACCOUNTS).fill(0n);
    const hash = poseidon(inputs);
    return BigInt(poseidon.F.toString(hash));
}

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log("════════════════════════════════════════");
    console.log("OXO ZK Rollup Deployment");
    console.log("Deployer :", deployer.address);
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance  :", ethers.formatEther(balance), "ETH");
    console.log("════════════════════════════════════════\n");

    // Mevcut OXOBTC adresini .env'den al
    const oxoBTCAddress = process.env.OXOBTC_TOKEN_ADDRESS;
    if (!oxoBTCAddress || oxoBTCAddress === "0x...") {
        console.error("HATA: OXOBTC_TOKEN_ADDRESS .env dosyasinda tanimli degil!");
        console.error("      deploy.js'i once calistirin veya .env'i guncelleyin.");
        process.exit(1);
    }
    console.log("Mevcut OXOBTC :", oxoBTCAddress);

    // 1. ZKVerifier
    console.log("\n1/3 ZKVerifier deploy ediliyor...");
    const ZKVerifier = await ethers.getContractFactory("contracts/ZKVerifier.sol:Groth16Verifier");
    const verifier = await ZKVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log("    ZKVerifier :", verifierAddress);

    // 2. Baslangic state root hesapla (8 hesap, hepsi 0)
    console.log("\n2/3 Baslangic state root hesaplaniyor...");
    const initialRoot = await computeZeroRoot();
    console.log("    initialRoot:", initialRoot.toString());

    // 3. OXORollup
    console.log("\n3/3 OXORollup deploy ediliyor...");
    const OXORollup = await ethers.getContractFactory("OXORollup");
    const rollup = await OXORollup.deploy(oxoBTCAddress, verifierAddress, initialRoot);
    await rollup.waitForDeployment();
    const rollupAddress = await rollup.getAddress();
    console.log("    OXORollup  :", rollupAddress);

    // Sequencer rolunu deployer'da birak (kullanici sonra degistirebilir)
    // Deployer zaten constructor'dan SEQUENCER_ROLE + DEFAULT_ADMIN_ROLE alir
    console.log("\n    Sequencer rolunu kontrol ediyorum...");
    const SEQUENCER_ROLE = await rollup.SEQUENCER_ROLE();
    const hasRole = await rollup.hasRole(SEQUENCER_ROLE, deployer.address);
    console.log("    Deployer SEQUENCER_ROLE:", hasRole ? "VAR" : "YOK");

    // Ozet
    const summary = `
════════════════════════════════════════
ROLLUP DEPLOYMENT TAMAMLANDI
${new Date().toISOString()}
════════════════════════════════════════
.env dosyaniza su satirlari ekleyin:

ZKVERIFIER_ADDRESS=${verifierAddress}
ROLLUP_CONTRACT_ADDRESS=${rollupAddress}

Sequencer baslatmak icin:
  node zk/sequencer/index.js
════════════════════════════════════════
`;
    console.log(summary);

    // deployment-rollup.txt'e kaydet
    const logPath = path.join(__dirname, "../deployment-rollup.txt");
    fs.writeFileSync(logPath, `ROLLUP DEPLOYMENT — ${new Date().toISOString()}
NETWORK          : ${(await ethers.provider.getNetwork()).name}
DEPLOYER         : ${deployer.address}
OXOBTC_TOKEN     : ${oxoBTCAddress}
ZKVERIFIER       : ${verifierAddress}
ROLLUP_CONTRACT  : ${rollupAddress}
INITIAL_STATE_ROOT: ${initialRoot.toString()}
`);
    console.log("Adresler deployment-rollup.txt dosyasina kaydedildi.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
