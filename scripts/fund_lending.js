// scripts/fund_lending.js
// OXOLending contract'ına Sepolia ETH likiditesi ekler.
// Kontratta receive() fonksiyonu var — direkt ETH transferi yeterli.
//
// Kullanım:
//   npx hardhat run scripts/fund_lending.js --network sepolia
//
// Miktar ayarlamak için FUND_ETH değişkenini değiştir (varsayılan: 0.5 ETH).

const { ethers } = require("hardhat");

const LENDING_ADDRESS = "0x80692E84b4b264ad5607b8F0C716d11Ee1Dc55Aa";
const FUND_ETH        = process.env.FUND_ETH || "0.5";   // göndermek istenen ETH

const LENDING_ABI = [
    "function totalBorrowed() view returns (uint256)",
    "event EthFunded(address indexed funder, uint256 amount)"
];

async function main() {
    const [deployer] = await ethers.getSigners();
    const provider   = ethers.provider;

    console.log("════════════════════════════════════════════");
    console.log("  OXO Lending — ETH Likidite Ekleme");
    console.log("════════════════════════════════════════════");
    console.log(`Gönderen    : ${deployer.address}`);

    // Bakiye kontrolleri
    const deployerBal     = await provider.getBalance(deployer.address);
    const contractBalBefore = await provider.getBalance(LENDING_ADDRESS);

    console.log(`Cüzdan ETH  : ${ethers.formatEther(deployerBal)} ETH`);
    console.log(`Contract ETH (önce): ${ethers.formatEther(contractBalBefore)} ETH`);

    const lending      = new ethers.Contract(LENDING_ADDRESS, LENDING_ABI, deployer);
    const totalBorrowed = await lending.totalBorrowed();
    console.log(`Aktif borç  : ${ethers.formatEther(totalBorrowed)} ETH`);

    const sendAmount = ethers.parseEther(FUND_ETH);

    // Yeterli bakiye kontrolü
    const MIN_RESERVE = ethers.parseEther("0.01"); // gas için bırak
    if (deployerBal < sendAmount + MIN_RESERVE) {
        console.error(`\n❌ Yetersiz bakiye!`);
        console.error(`   Gerekli : ${ethers.formatEther(sendAmount + MIN_RESERVE)} ETH (fon + gas)`);
        console.error(`   Mevcut  : ${ethers.formatEther(deployerBal)} ETH`);
        console.error(`\n   Sepolia faucet: https://sepoliafaucet.com`);
        process.exit(1);
    }

    console.log(`\nGönderilecek: ${FUND_ETH} ETH → ${LENDING_ADDRESS}`);
    console.log("İşlem gönderiliyor...\n");

    // ETH transfer (receive() tetiklenir, EthFunded event yayılır)
    const tx = await deployer.sendTransaction({
        to:    LENDING_ADDRESS,
        value: sendAmount,
    });
    console.log(`Tx hash     : ${tx.hash}`);
    console.log("Onay bekleniyor...");

    const receipt = await tx.wait();
    console.log(`Blok        : ${receipt.blockNumber}`);
    console.log(`Gas kullanılan: ${receipt.gasUsed.toString()}`);

    // Sonuç
    const contractBalAfter = await provider.getBalance(LENDING_ADDRESS);
    const added            = contractBalAfter - contractBalBefore;

    console.log("\n════════════════════════════════════════════");
    console.log("  BAŞARILI ✅");
    console.log("════════════════════════════════════════════");
    console.log(`Contract ETH (önce) : ${ethers.formatEther(contractBalBefore)} ETH`);
    console.log(`Eklenen             : ${ethers.formatEther(added)} ETH`);
    console.log(`Contract ETH (sonra): ${ethers.formatEther(contractBalAfter)} ETH`);
    console.log(`Aktif borç          : ${ethers.formatEther(totalBorrowed)} ETH`);
    console.log(`Kullanılabilir liq. : ${ethers.formatEther(contractBalAfter - totalBorrowed)} ETH`);
    console.log(`\nEtherscan: https://sepolia.etherscan.io/address/${LENDING_ADDRESS}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
