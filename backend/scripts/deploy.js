const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Kontratlar bu adres üzerinden deploy ediliyor:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Hesap bakiyesi:", hre.ethers.formatEther(balance), "ETH");

  // 1. Yeni OXO Token kontratını deploy edin
  const OXO = await hre.ethers.getContractFactory("OXO");
  const oxoToken = await OXO.deploy();
  await oxoToken.waitForDeployment();
  const oxoTokenAddress = await oxoToken.getAddress();
  console.log("Yeni OXO Token kontratı Sepolia'ya deploy edildi:", oxoTokenAddress);

  // 2. Yeni Bridge kontratını deploy edin
  const Bridge = await hre.ethers.getContractFactory("Bridge");
  const bridge = await Bridge.deploy(oxoTokenAddress, deployer.address);
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log("Yeni Bridge kontratı Sepolia'ya deploy edildi:", bridgeAddress);

  // 3. Yeni OXO Token kontratında Bridge kontratına mint yetkisi verin
  console.log("Bridge kontratına mint yetkisi veriliyor...");
  const tx = await oxoToken.setMinter(bridgeAddress, true);
  await tx.wait();
  console.log("Mint yetkisi başarıyla verildi.");

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });