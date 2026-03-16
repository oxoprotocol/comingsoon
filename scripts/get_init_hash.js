// scripts/get_init_hash.js
const hre = require("hardhat");

async function main() {
  console.log("Hesaplanıyor...");

  // Kendi Pair kontratımızın bytecode'unu alıyoruz
  const pairBytecode = hre.artifacts.readArtifactSync(
    "contracts/oxo_swap_core/UniswapV2Pair.sol:UniswapV2Pair"
  ).bytecode;

  // Bytecode'un keccak256 hash'ini hesaplıyoruz
  const initCodeHash = hre.ethers.keccak256(pairBytecode);

  console.log("----------------------------------------------------");
  console.log("✅ Hesaplama Başarılı!");
  console.log("Yeni INIT_CODE_HASH değeriniz (tırnaklar olmadan kopyalayın):");
  console.log(initCodeHash);
  console.log("----------------------------------------------------");
  console.log("Şimdi bu değeri kopyalayıp UniswapV2Library.sol dosyasındaki 'pairFor' fonksiyonu içine yapıştırın.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});