// scripts/deploy_oxo.js

const hre = require("hardhat");

async function main() {
  console.log("Deploying OXO token contract...");

  // Kontratın "fabrikasını" alıyoruz. Bu, Hardhat'in kontratı derleyip
  // dağıtıma hazırlamasını sağlar.
  const OXO = await hre.ethers.getContractFactory("OXO");

  // Kontratı dağıtma işlemini başlatıyoruz.
  const oxo = await OXO.deploy();

  // Dağıtımın tamamlanmasını bekliyoruz.
  await oxo.waitForDeployment();

  // Dağıtım tamamlandığında, kontratın adresini terminale yazdırıyoruz.
  // Bu adrese daha sonra ihtiyacımız olacak.
  console.log(`✅ OXO Token deployed successfully to: ${oxo.target}`);
}

// Script'i çalıştır ve olası hataları yakala.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});