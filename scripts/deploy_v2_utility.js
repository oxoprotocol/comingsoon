// scripts/deploy_v2_utility.js
// Yeni BridgeV3 (OXO fee discount) + Yeni OXOLending (OXO LTV boost) deploy et
//
// Kullanım:
//   npx hardhat run scripts/deploy_v2_utility.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;

const OXOBTC_ADDRESS   = "0xA6fB891D117ce6C03880168bADE140067ED44D78";
const TREASURY_ADDRESS = "0xdCC5Eef80df9cF48F4504D476BB4701B17e7E361";
const STAKING_ADDRESS  = "0x54e8f0348EB1E531f72d94E89FF877bA6B9b460A";
const BTC_USD_ORACLE   = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
const ETH_USD_ORACLE   = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const BRIDGE_FEE_BPS   = 10; // %0.1

async function main() {
  const [deployer] = await ethers.getSigners();
  const signerKey  = process.env.SIGNER_PRIVATE_KEY;
  const signerAddr = new ethers.Wallet(signerKey).address;

  console.log("Deployer:", deployer.address);
  console.log("Backend signer:", signerAddr);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ─── 1. BridgeV3 deploy ───────────────────────────────────────────
  console.log("[1/6] BridgeV3 deploy ediliyor...");
  const Bridge = await ethers.getContractFactory("BridgeV3");
  const bridge = await Bridge.deploy(OXOBTC_ADDRESS);
  await bridge.waitForDeployment();
  console.log("  ✅ BridgeV3:", bridge.target);

  // ─── 2. OXOLending deploy ─────────────────────────────────────────
  console.log("[2/6] OXOLending deploy ediliyor...");
  const Lending = await ethers.getContractFactory("OXOLending");
  const lending = await Lending.deploy(OXOBTC_ADDRESS, BTC_USD_ORACLE, ETH_USD_ORACLE);
  await lending.waitForDeployment();
  console.log("  ✅ OXOLending:", lending.target);

  // ─── 3. Bridge ayarları ───────────────────────────────────────────
  console.log("[3/6] Bridge ayarlanıyor...");
  const SIGNER_ROLE = await bridge.SIGNER_ROLE();
  await (await bridge.grantRole(SIGNER_ROLE, signerAddr)).wait();
  await (await bridge.setTreasury(TREASURY_ADDRESS, BRIDGE_FEE_BPS)).wait();
  await (await bridge.setFeeEnabled(true)).wait();
  await (await bridge.setOxoStaking(STAKING_ADDRESS)).wait();
  console.log("  ✅ SIGNER_ROLE, Treasury, feeEnabled, oxoStaking set edildi");

  // ─── 4. OXOBTC'ye yeni bridge'e MINTER_ROLE ver ───────────────────
  console.log("[4/6] OXOBTC MINTER_ROLE veriliyor...");
  const oxoBTC = await ethers.getContractAt("OXOBTC", OXOBTC_ADDRESS);
  const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
  await (await oxoBTC.grantRole(MINTER_ROLE, bridge.target)).wait();
  console.log("  ✅ MINTER_ROLE verildi →", bridge.target);

  // ─── 5. Lending ayarları ──────────────────────────────────────────
  console.log("[5/6] Lending ayarlanıyor...");
  await (await lending.setOxoStaking(STAKING_ADDRESS)).wait();
  console.log("  ✅ oxoStaking set edildi");

  // ─── 6. Lending'e başlangıç likiditesi ───────────────────────────
  console.log("[6/6] Lending'e 0.05 ETH likidite yükleniyor...");
  await (await deployer.sendTransaction({ to: lending.target, value: ethers.parseEther("0.05") })).wait();
  console.log("  ✅ 0.05 ETH yüklendi");

  // ─── Özet ─────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("DEPLOY TAMAMLANDI");
  console.log("═══════════════════════════════════════════════════");
  console.log("BRIDGE_NEW:  ", bridge.target);
  console.log("LENDING_NEW: ", lending.target);
  console.log("\n⚠  Şimdi yapılacaklar:");
  console.log("   backend/.env → BRIDGE_CONTRACT_ADDRESS=" + bridge.target);
  console.log("   frontend CONFIG → BRIDGE_ADDRESS: \"" + bridge.target + "\"");
  console.log("   frontend CONFIG → LENDING_ADDRESS: \"" + lending.target + "\"");
  console.log("   Backend'i yeniden başlat: cd backend && node server.js");
}

main().catch(e => { console.error(e); process.exit(1); });
