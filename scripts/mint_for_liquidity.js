// scripts/mint_for_liquidity.js
// Deploy hesabına test için oxoBTC mint eder

const hre = require("hardhat");

async function main() {
  const oxobtcAddress = process.env.OXOBTC_TOKEN_ADDRESS;
  const bridgeAddress = process.env.BRIDGE_CONTRACT_ADDRESS;

  if (!oxobtcAddress || !bridgeAddress) {
    throw new Error("OXOBTC_TOKEN_ADDRESS veya BRIDGE_CONTRACT_ADDRESS .env'de tanımlı değil!");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const OXOBTC_ABI = [
    "function mint(address to, uint256 amount) external",
    "function balanceOf(address) view returns (uint256)",
    "function grantRole(bytes32 role, address account) external",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ];

  const oxobtc = await hre.ethers.getContractAt(OXOBTC_ABI, oxobtcAddress, deployer);

  // Deployer'a geçici MINTER_ROLE ver
  const MINTER_ROLE = hre.ethers.id("MINTER_ROLE");
  const hasMinterRole = await oxobtc.hasRole(MINTER_ROLE, deployer.address);

  if (!hasMinterRole) {
    console.log("Deployer'a MINTER_ROLE veriliyor...");
    const tx = await oxobtc.grantRole(MINTER_ROLE, deployer.address);
    await tx.wait();
    console.log("✅ MINTER_ROLE verildi.");
  } else {
    console.log("✅ Deployer zaten MINTER_ROLE'e sahip.");
  }

  // 0.01 oxoBTC mint et (8 decimal, likidite için yeterli)
  const mintAmount = hre.ethers.parseUnits("0.01", 8);
  console.log(`Mint ediliyor: ${hre.ethers.formatUnits(mintAmount, 8)} oxoBTC → ${deployer.address}`);
  const mintTx = await oxobtc.mint(deployer.address, mintAmount);
  await mintTx.wait();

  const balance = await oxobtc.balanceOf(deployer.address);
  console.log(`✅ Mint başarılı! Bakiye: ${hre.ethers.formatUnits(balance, 8)} oxoBTC`);
  console.log("\nŞimdi add_liquidity.js çalıştırabilirsin.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
