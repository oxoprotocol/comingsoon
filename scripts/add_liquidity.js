// scripts/add_liquidity.js
// ✅ DÜZELTİLDİ: Slippage koruması + env kontrolleri + WETH .env'den okunuyor

const hre = require("hardhat");

async function main() {
  const tokenA_Address = process.env.OXOBTC_TOKEN_ADDRESS;
  const routerAddress  = process.env.OXO_SWAP_ROUTER_ADDRESS;
  const WETH_ADDRESS   = process.env.WETH_ADDRESS || "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

  if (!tokenA_Address) throw new Error("OXOBTC_TOKEN_ADDRESS .env'de tanımlı değil!");
  if (!routerAddress)  throw new Error("OXO_SWAP_ROUTER_ADDRESS .env'de tanımlı değil!");

  console.log("WETH Adresi:", WETH_ADDRESS);

  // Fiyat: 1 ETH = 0.03373 BTC oranına göre
  const amount_oxoBTC = hre.ethers.parseUnits("0.003", 8);  // 0.003 oxoBTC
  const amount_ETH    = hre.ethers.parseEther("0.08895");    // ~0.08895 ETH

  // ✅ Slippage: %1 koruması
  const amountBTCMin = amount_oxoBTC * 99n / 100n;
  const amountETHMin = amount_ETH    * 99n / 100n;

  const [owner] = await hre.ethers.getSigners();
  console.log("Likidite ekleyen hesap:", owner.address);
  console.log("-----------------------------------");

  const tokenA_Contract = await hre.ethers.getContractAt(
    "contracts/oxo_swap_core/interfaces/IERC20.sol:IERC20",
    tokenA_Address,
    owner
  );

  const routerContract = await hre.ethers.getContractAt(
    "contracts/oxo_swap_core/interfaces/IUniswapV2Router02.sol:IUniswapV2Router02",
    routerAddress,
    owner
  );

  // Approve
  console.log(`Router'a ${hre.ethers.formatUnits(amount_oxoBTC, 8)} OXOBTC harcama izni veriliyor...`);
  const approveTx = await tokenA_Contract.approve(routerAddress, amount_oxoBTC);
  await approveTx.wait();
  console.log("✅ Approve başarılı!");
  console.log("-----------------------------------");

  // Likidite Ekle
  console.log(`Likidite ekleniyor: ${hre.ethers.formatUnits(amount_oxoBTC, 8)} oxoBTC + ${hre.ethers.formatEther(amount_ETH)} ETH`);
  console.log(`Minimum kabul: ${hre.ethers.formatUnits(amountBTCMin, 8)} oxoBTC + ${hre.ethers.formatEther(amountETHMin)} ETH`);

  const addLiquidityTx = await routerContract.addLiquidityETH(
    tokenA_Address,
    amount_oxoBTC,
    amountBTCMin,
    amountETHMin,
    owner.address,
    Math.floor(Date.now() / 1000) + 60 * 10,
    { value: amount_ETH }
  );

  const receipt = await addLiquidityTx.wait();
  console.log("✅ Likidite başarıyla eklendi! TX:", receipt.hash);
  console.log("-----------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
