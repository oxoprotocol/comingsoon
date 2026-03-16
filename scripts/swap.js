// scripts/swap.js
// ✅ DÜZELTİLDİ: Slippage koruması + env kontrolleri eklendi

const hre = require("hardhat");

async function main() {
  const amountETH_In   = hre.ethers.parseEther("0.0001");
  const routerAddress  = process.env.OXO_SWAP_ROUTER_ADDRESS;
  const oxoBTC_Address = process.env.OXOBTC_TOKEN_ADDRESS;
  const WETH_Address   = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

  if (!routerAddress)  throw new Error("OXO_SWAP_ROUTER_ADDRESS .env'de tanımlı değil!");
  if (!oxoBTC_Address) throw new Error("OXOBTC_TOKEN_ADDRESS .env'de tanımlı değil!");

  const [owner] = await hre.ethers.getSigners();
  console.log("Swap yapan hesap:", owner.address);
  console.log("-----------------------------------");

  const routerContract = await hre.ethers.getContractAt(
    "contracts/oxo_swap_core/interfaces/IUniswapV2Router02.sol:IUniswapV2Router02",
    routerAddress,
    owner
  );

  const path = [WETH_Address, oxoBTC_Address];

  // ✅ Slippage koruması: önce beklenen çıktıyı sorgula
  const amountsOut   = await routerContract.getAmountsOut(amountETH_In, path);
  const expectedOut  = amountsOut[amountsOut.length - 1];
  const amountOutMin = expectedOut * 99n / 100n; // %1 tolerans
  console.log(`Beklenen oxoBTC (min): ${hre.ethers.formatUnits(amountOutMin, 8)}`);

  console.log(`Swapping ${hre.ethers.formatEther(amountETH_In)} ETH → oxoBTC...`);

  const swapTx = await routerContract.swapExactETHForTokens(
    amountOutMin,
    path,
    owner.address,
    Math.floor(Date.now() / 1000) + 60 * 10,
    { value: amountETH_In }
  );

  const receipt = await swapTx.wait();
  console.log("✅ Swap başarılı! TX:", receipt.hash);
  console.log("-----------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
