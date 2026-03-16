// scripts/deploy_swap.js

const hre = require("hardhat");

async function main() {
  // Sepolia ağındaki standart WETH kontrat adresi. Bu, Router için zorunludur.
  const WETH_ADDRESS = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

  // Deploy işlemini yapacak olan cüzdanın adresini alıyoruz.
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("-----------------------------------");

  // 1. UniswapV2Factory Kontratını Dağıt
  console.log("Deploying UniswapV2Factory...");
  const Factory = await hre.ethers.getContractFactory("UniswapV2Factory");
  // Factory kontratı, kurucu (constructor) olarak bir "feeToSetter" adresi ister.
  // Bu, gelecekte işlem ücretlerinin kime gideceğini belirleme yetkisine sahip olan adrestir.
  // Başlangıçta bu yetkiyi, kontratı dağıtan kişiye (bize) veriyoruz.
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  console.log(`✅ UniswapV2Factory deployed to: ${factory.target}`);
  console.log("-----------------------------------");


  // 2. UniswapV2Router02 Kontratını Dağıt
  console.log("Deploying UniswapV2Router02...");
  const Router = await hre.ethers.getContractFactory("UniswapV2Router02");
  // Router kontratı, kurucu (constructor) olarak iki adres ister:
  // - Az önce dağıttığımız Factory kontratının adresi.
  // - Çalışacağı ağdaki WETH kontratının adresi.
  const router = await Router.deploy(factory.target, WETH_ADDRESS);
  await router.waitForDeployment();
  console.log(`✅ UniswapV2Router02 deployed to: ${router.target}`);
  console.log("-----------------------------------");

  console.log("Deployment complete! Please save these addresses.");
}

// Script'i çalıştır ve olası hataları yakala.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});