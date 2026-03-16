// scripts/fund_rewards.js
// OXO Staking emisyon fonunu yükler: 10M OXO → OXOStaking contract
//
// Kullanım:
//   npx hardhat run scripts/fund_rewards.js --network sepolia

const { ethers } = require("hardhat");

const OXO_ADDRESS     = "0xca0cd5448fabdfdc33f0795c871901c5e2bb60a8";
const STAKING_ADDRESS = "0x54e8f0348EB1E531f72d94E89FF877bA6B9b460A";
const FUND_AMOUNT     = ethers.parseUnits("10000000", 18); // 10M OXO

const OXO_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)"
];
const STAKING_ABI = [
    "function fundOxoRewards(uint256 amount) external",
    "function pool0() view returns (uint256 totalStaked, uint256 oxoPerSecond, uint256 accOxoPerShare, uint256 lastRewardTime)"
];

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("ETH Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    const oxo     = new ethers.Contract(OXO_ADDRESS, OXO_ABI, deployer);
    const staking = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, deployer);

    // Bakiye kontrolü
    const oxoBal = await oxo.balanceOf(deployer.address);
    console.log("OXO Balance:", ethers.formatUnits(oxoBal, 18), "OXO");
    if (oxoBal < FUND_AMOUNT) {
        console.error("HATA: Yeterli OXO yok. Gereken: 10,000,000 OXO");
        process.exit(1);
    }

    // Approve
    console.log("\n1/2 Approve ediliyor (10M OXO → Staking)...");
    const allowance = await oxo.allowance(deployer.address, STAKING_ADDRESS);
    if (allowance < FUND_AMOUNT) {
        const tx = await oxo.approve(STAKING_ADDRESS, FUND_AMOUNT);
        await tx.wait();
        console.log("   Approve OK");
    } else {
        console.log("   Zaten yeterli allowance mevcut, skip.");
    }

    // Fund
    console.log("\n2/2 fundOxoRewards çağrılıyor...");
    const tx = await staking.fundOxoRewards(FUND_AMOUNT);
    await tx.wait();
    console.log("   10M OXO Staking contract'a yüklendi!");

    // Doğrulama
    const pool = await staking.pool0();
    const rate = ethers.formatUnits(pool.oxoPerSecond, 18);
    console.log("\n═══════════════════════════════════════");
    console.log("EMİSYON AKTIF");
    console.log("═══════════════════════════════════════");
    console.log("Emisyon hızı :", rate, "OXO/saniye");
    console.log("Günlük ödül  :", (parseFloat(rate) * 86400).toFixed(0), "OXO/gün");
    console.log("Toplam fon   : 10,000,000 OXO");
    console.log("Tahmini süre :", (10_000_000 / (parseFloat(rate) * 86400)).toFixed(1), "gün");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
