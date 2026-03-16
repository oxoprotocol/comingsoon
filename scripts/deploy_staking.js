// scripts/deploy_staking.js
// Deploy: ProtocolTreasury + OXOStaking + BridgeV3 fee hook bağlantısı
//
// Kullanım:
//   npx hardhat run scripts/deploy_staking.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;

// ─── Mevcut deploy edilmiş adresler ───────────────────────────────
const OXOBTC_ADDRESS  = "0xA6fB891D117ce6C03880168bADE140067ED44D78";
const OXO_ADDRESS     = "0xca0cd5448fabdfdc33f0795c871901c5e2bb60a8";
const BRIDGE_ADDRESS  = "0x1bff71d8Eb29666DE2238A52E296320d2E98645D";
const ROUTER_ADDRESS  = "0xb898537873ab341557963db261563092c784e725";
const WETH_ADDRESS    = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

// Sepolia Chainlink BTC/USD Price Feed
const BTC_USD_ORACLE  = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";

// OXO emisyon hızı: 0.1 OXO/saniye = 8,640 OXO/gün
// 10M OXO ile ~3.17 yıl
const OXO_PER_SECOND  = ethers.parseUnits("0.1", 18); // 0.1e18

// Bridge fee: %0.1
const BRIDGE_FEE_BPS  = 10;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ─── 1. OXOStaking deploy ────────────────────────────────────────
  console.log("1/3 OXOStaking deploy ediliyor...");
  const Staking = await ethers.getContractFactory("OXOStaking");
  const staking = await Staking.deploy(
    OXOBTC_ADDRESS,
    OXO_ADDRESS,
    OXO_PER_SECOND,
    BTC_USD_ORACLE,
    deployer.address
  );
  await staking.waitForDeployment();
  const STAKING_ADDRESS = await staking.getAddress();
  console.log("   OXOStaking:", STAKING_ADDRESS);

  // ─── 2. ProtocolTreasury deploy ──────────────────────────────────
  console.log("\n2/3 ProtocolTreasury deploy ediliyor...");
  const Treasury = await ethers.getContractFactory("ProtocolTreasury");
  const treasury = await Treasury.deploy(
    OXOBTC_ADDRESS,
    STAKING_ADDRESS,
    ROUTER_ADDRESS,
    WETH_ADDRESS,
    deployer.address
  );
  await treasury.waitForDeployment();
  const TREASURY_ADDRESS = await treasury.getAddress();
  console.log("   ProtocolTreasury:", TREASURY_ADDRESS);

  // ─── 3. Bağlantıları kur ────────────────────────────────────────
  console.log("\n3/3 Bağlantılar kuruluyor...");

  // Staking → Treasury'ye TREASURY_ROLE ver
  let tx = await staking.setTreasury(TREASURY_ADDRESS);
  await tx.wait();
  console.log("   Staking: TREASURY_ROLE →", TREASURY_ADDRESS);

  // Treasury → Bridge'e FEEDER_ROLE ver
  tx = await treasury.addFeeder(BRIDGE_ADDRESS);
  await tx.wait();
  console.log("   Treasury: FEEDER_ROLE → Bridge");

  // Bridge → Treasury'yi set et + fee'yi aç
  const bridge = await ethers.getContractAt("BridgeV3", BRIDGE_ADDRESS);
  tx = await bridge.setTreasury(TREASURY_ADDRESS, BRIDGE_FEE_BPS);
  await tx.wait();
  tx = await bridge.setFeeEnabled(true);
  await tx.wait();
  console.log("   Bridge: treasury set, fee %0.1 aktif");

  // ─── 4. OXO emisyon fonunu yükle (opsiyonel — admin manuel yapabilir) ─
  // 10M OXO → staking contract'a
  // const oxo = await ethers.getContractAt("OXO", OXO_ADDRESS);
  // await oxo.approve(STAKING_ADDRESS, ethers.parseUnits("10000000", 18));
  // await staking.fundOxoRewards(ethers.parseUnits("10000000", 18));
  // console.log("   10M OXO emisyon fonu yüklendi");

  // ─── Özet ───────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("DEPLOY TAMAMLANDI");
  console.log("═══════════════════════════════════════");
  console.log("STAKING  :", STAKING_ADDRESS);
  console.log("TREASURY :", TREASURY_ADDRESS);
  console.log("Bridge fee: %0.1 aktif");
  console.log("\n⚠  Emisyon başlatmak için:");
  console.log("   OXO token'dan Staking'e approve + fundOxoRewards() çağır");
  console.log("⚠  Router'a FEEDER_ROLE vermek için:");
  console.log("   treasury.addFeeder(ROUTER_ADDRESS)");

  // deployment-staking.txt'ye kaydet
  const fs = require("fs");
  const output = `STAKING_ADDRESS=${STAKING_ADDRESS}\nTREASURY_ADDRESS=${TREASURY_ADDRESS}\n`;
  fs.writeFileSync("deployment-staking.txt", output);
  console.log("\ndeployment-staking.txt güncellendi.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
