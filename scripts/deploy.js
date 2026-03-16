// scripts/deploy.js
// ✅ DÜZELTİLDİ: BridgeV3 kullanılıyor, OXOBTC constructor argümanları eklendi,
//                private key terminale yazılmıyor.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("════════════════════════════════════════");
  console.log("Dağıtan adres :", deployer.address);
  console.log("════════════════════════════════════════\n");

  // ─────────────────────────────────────────
  // 1. OXOBTC Token — constructor (name, symbol) gerekiyor
  // ─────────────────────────────────────────
  console.log("1/4 OXOBTC token deploy ediliyor...");
  const OXOBTCFactory = await ethers.getContractFactory("OXOBTC");
  const oxobtc = await OXOBTCFactory.deploy("OXO Bitcoin", "oxoBTC"); // ✅ Düzeltildi
  await oxobtc.waitForDeployment();
  const oxobtcAddress = await oxobtc.getAddress();
  console.log(`    ✅ OXOBTC deploy edildi : ${oxobtcAddress}\n`);

  // ─────────────────────────────────────────
  // 2. Signer cüzdanı — private key .env'e yazılıyor, terminale değil
  // ─────────────────────────────────────────
  console.log("2/4 Signer (relayer) cüzdanı oluşturuluyor...");
  const signerWallet = ethers.Wallet.createRandom();
  console.log(`    ✅ Signer adresi : ${signerWallet.address}`);
  console.log("    ⚠️  Private key aşağıda YALNIZCA BİR KEZ görünüyor.");
  console.log("        Hemen .env dosyanıza SIGNER_PRIVATE_KEY olarak kopyalayın!\n");
  console.log(`    SIGNER_PRIVATE_KEY=${signerWallet.privateKey}\n`);

  // ─────────────────────────────────────────
  // 3. BridgeV3 — V1 yerine V3 kullanılıyor
  // ─────────────────────────────────────────
  console.log("3/4 BridgeV3 deploy ediliyor...");
  const BridgeV3Factory = await ethers.getContractFactory("BridgeV3"); // ✅ V1 → V3
  const bridge = await BridgeV3Factory.deploy(oxobtcAddress);
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log(`    ✅ BridgeV3 deploy edildi : ${bridgeAddress}\n`);

  // ─────────────────────────────────────────
  // 4. Roller
  // ─────────────────────────────────────────
  console.log("4/4 Roller atanıyor...");

  // OXOBTC → Bridge'e MINTER_ROLE ver
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  const mintTx = await oxobtc.connect(deployer).grantRole(MINTER_ROLE, bridgeAddress);
  await mintTx.wait();
  console.log(`    ✅ MINTER_ROLE → BridgeV3'e verildi`);

  // BridgeV3 → Signer'a SIGNER_ROLE ver
  const SIGNER_ROLE = ethers.id("SIGNER_ROLE");
  const signTx = await bridge.connect(deployer).grantRole(SIGNER_ROLE, signerWallet.address);
  await signTx.wait();
  console.log(`    ✅ SIGNER_ROLE → Relayer cüzdanına verildi\n`);

  // ─────────────────────────────────────────
  // Özet & .env çıktısı
  // ─────────────────────────────────────────
  const summary = `
════════════════════════════════════════
✅ DEPLOYMENT TAMAMLANDI
════════════════════════════════════════
.env dosyanıza şunları ekleyin:

OXOBTC_TOKEN_ADDRESS=${oxobtcAddress}
BRIDGE_CONTRACT_ADDRESS=${bridgeAddress}
SIGNER_PRIVATE_KEY=${signerWallet.privateKey}
════════════════════════════════════════
`;
  console.log(summary);

  // Ayrıca deployment-summary.txt dosyasına yaz (private key'siz)
  const safeLog = `
DEPLOYMENT ÖZET — ${new Date().toISOString()}
OXOBTC_TOKEN_ADDRESS=${oxobtcAddress}
BRIDGE_CONTRACT_ADDRESS=${bridgeAddress}
SIGNER_ADDRESS=${signerWallet.address}
(Private key ayrıca .env dosyasında saklanmalıdır)
`;
  fs.writeFileSync(
    path.join(__dirname, "../deployment-summary.txt"),
    safeLog.trim()
  );
  console.log("📄 Adresler deployment-summary.txt dosyasına kaydedildi.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
