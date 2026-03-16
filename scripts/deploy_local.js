// scripts/deploy_local.js
// Local test için WETH + Factory + Router hepsini deploy eder

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("-----------------------------------");

  // 1. WETH deploy et
  console.log("1/3 WETH deploy ediliyor...");
  const WETH = await hre.ethers.getContractFactory("WETH");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();
  console.log(`✅ WETH: ${weth.target}`);

  // 2. Factory deploy et
  console.log("2/3 UniswapV2Factory deploy ediliyor...");
  const Factory = await hre.ethers.getContractFactory("UniswapV2Factory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  console.log(`✅ Factory: ${factory.target}`);

  // 3. Router deploy et (local WETH adresiyle)
  console.log("3/3 UniswapV2Router02 deploy ediliyor...");
  const Router = await hre.ethers.getContractFactory("UniswapV2Router02");
  const router = await Router.deploy(factory.target, weth.target);
  await router.waitForDeployment();
  console.log(`✅ Router: ${router.target}`);

  console.log("\n════════════════════════════════════════");
  console.log("✅ LOCAL DEPLOYMENT TAMAMLANDI");
  console.log("════════════════════════════════════════");
  console.log(".env dosyanıza şunları ekleyin:\n");
  console.log(`WETH_ADDRESS=${weth.target}`);
  console.log(`OXO_SWAP_FACTORY_ADDRESS=${factory.target}`);
  console.log(`OXO_SWAP_ROUTER_ADDRESS=${router.target}`);
  console.log("════════════════════════════════════════");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
