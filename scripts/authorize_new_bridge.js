// scripts/authorize_new_bridge.js
// Yeni BridgeV3 (0xc54c...) kontratına backend signer yetkisi ver.
// Eski bridge (0x1bff71d8) yerine yeni bridge kullanılmak istendiğinde çalıştırın.
//
// Kullanım:
//   npx hardhat run scripts/authorize_new_bridge.js --network sepolia

const hre = require("hardhat");
const { ethers } = hre;

// Yeni bridge (fee hook'lu, Treasury'ye bağlı)
const NEW_BRIDGE_ADDRESS = "0xc54cDfF5a750b39d31bfB31dC5bbc7d4B6659091";

// OXOBTC token (minter rol verileceği için gerekli)
const OXOBTC_ADDRESS = "0xA6fB891D117ce6C03880168bADE140067ED44D78";

// Backend signer (SIGNER_PRIVATE_KEY'den türetilen adres)
// .env'deki SIGNER_PRIVATE_KEY ile eşleşmeli
const BACKEND_SIGNER = process.env.BACKEND_SIGNER_ADDRESS;

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // BACKEND_SIGNER env'den alınır ya da kullanıcı manuel girer
    let signerAddress = BACKEND_SIGNER;
    if (!signerAddress) {
        // SIGNER_PRIVATE_KEY varsa adresini türet
        const signerKey = process.env.SIGNER_PRIVATE_KEY;
        if (!signerKey) {
            throw new Error("BACKEND_SIGNER_ADDRESS veya SIGNER_PRIVATE_KEY .env'de bulunamadı");
        }
        const signerWallet = new ethers.Wallet(signerKey);
        signerAddress = signerWallet.address;
        console.log("Signer adresi türetildi:", signerAddress);
    } else {
        console.log("Signer adresi (env):", signerAddress);
    }

    const bridge = await ethers.getContractAt("BridgeV3", NEW_BRIDGE_ADDRESS);
    const oxoBTC = await ethers.getContractAt("OXOBTC", OXOBTC_ADDRESS);

    const SIGNER_ROLE  = await bridge.SIGNER_ROLE();
    const MINTER_ROLE  = await oxoBTC.MINTER_ROLE();

    // ─── 1. Mevcut durumu kontrol et ─────────────────────────────
    const hasSigner = await bridge.hasRole(SIGNER_ROLE, signerAddress);
    const hasMinter = await oxoBTC.hasRole(MINTER_ROLE, NEW_BRIDGE_ADDRESS);

    console.log("\nMevcut durum:");
    console.log("  Bridge SIGNER_ROLE (backend):", hasSigner ? "✅ mevcut" : "❌ YOK");
    console.log("  oxoBTC MINTER_ROLE (yeni bridge):", hasMinter ? "✅ mevcut" : "❌ YOK");

    // ─── 2. SIGNER_ROLE ver ───────────────────────────────────────
    if (!hasSigner) {
        console.log("\n[1/2] Bridge'e SIGNER_ROLE veriliyor →", signerAddress);
        const tx = await bridge.grantRole(SIGNER_ROLE, signerAddress);
        await tx.wait();
        console.log("   ✅ SIGNER_ROLE verildi. Tx:", tx.hash);
    } else {
        console.log("\n[1/2] SIGNER_ROLE zaten mevcut, atlandı.");
    }

    // ─── 3. MINTER_ROLE ver ───────────────────────────────────────
    if (!hasMinter) {
        console.log("\n[2/2] oxoBTC'ye MINTER_ROLE veriliyor → yeni bridge");
        const tx2 = await oxoBTC.grantRole(MINTER_ROLE, NEW_BRIDGE_ADDRESS);
        await tx2.wait();
        console.log("   ✅ MINTER_ROLE verildi. Tx:", tx2.hash);
    } else {
        console.log("\n[2/2] MINTER_ROLE zaten mevcut, atlandı.");
    }

    // ─── 4. Doğrulama ─────────────────────────────────────────────
    const signerOk = await bridge.hasRole(SIGNER_ROLE, signerAddress);
    const minterOk = await oxoBTC.hasRole(MINTER_ROLE, NEW_BRIDGE_ADDRESS);

    console.log("\n═══════════════════════════════════════");
    console.log("SONUÇ");
    console.log("═══════════════════════════════════════");
    console.log("Bridge SIGNER_ROLE:", signerOk ? "✅" : "❌ BAŞARISIZ");
    console.log("oxoBTC MINTER_ROLE:", minterOk ? "✅" : "❌ BAŞARISIZ");

    if (signerOk && minterOk) {
        console.log("\n✅ Yeni bridge hazır.");
        console.log("\n⚠  Sonraki adımlar:");
        console.log("   1. Backend .env'ini güncelle:");
        console.log("      BRIDGE_CONTRACT_ADDRESS=" + NEW_BRIDGE_ADDRESS);
        console.log("   2. Frontend CONFIG'i güncelle:");
        console.log("      BRIDGE: \"" + NEW_BRIDGE_ADDRESS + "\"");
        console.log("   3. Backend'i yeniden başlat: cd backend && node server.js");
    } else {
        console.log("\n❌ Bazı adımlar başarısız. Deployer adresinin admin yetkisi var mı kontrol et.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
