// setup.js — Tek seferlik ZK kurulum scripti
// Çalıştır: node zk/scripts/setup.js
// Çıktı: zk/build/ altında r1cs, wasm, zkey, verification_key.json
//        contracts/ZKVerifier.sol (Solidity verifier)

const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const https = require("https");

const CIRCUIT_DIR = path.join(__dirname, "../circuits");
const BUILD_DIR = path.join(__dirname, "../build");
const CONTRACTS_DIR = path.join(__dirname, "../../contracts");
const CIRCUIT_NAME = "rollup";
const PTAU_FILE = path.join(BUILD_DIR, "ptau12.ptau");
const PTAU_URL = "https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau";

// Circom binary yolu
const CIRCOM_BIN = process.env.CIRCOM_BIN ||
    path.join(process.env.USERPROFILE || process.env.HOME, "bin", "circom.exe") ||
    "circom";

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) {
            const size = fs.statSync(dest).size;
            if (size > 1_000_000) {
                console.log(`✅ ${path.basename(dest)} zaten mevcut (${(size / 1e6).toFixed(1)} MB)`);
                return resolve();
            }
        }
        console.log(`⬇️  İndiriliyor: ${url}`);
        const file = fs.createWriteStream(dest);
        const get = (u) => https.get(u, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
            const total = parseInt(res.headers["content-length"] || "0");
            let received = 0;
            res.on("data", (chunk) => {
                received += chunk.length;
                if (total) process.stdout.write(`\r   ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`);
            });
            res.pipe(file);
            file.on("finish", () => { file.close(); console.log("\n"); resolve(); });
        }).on("error", reject);
        get(url);
    });
}

async function main() {
    fs.mkdirSync(BUILD_DIR, { recursive: true });

    // 1. ptau indir
    await downloadFile(PTAU_URL, PTAU_FILE);

    // 2. Circom ile compile
    console.log("🔧 Circuit derleniyor...");
    const circuitFile = path.join(CIRCUIT_DIR, `${CIRCUIT_NAME}.circom`);
    const circomCmd = `"${CIRCOM_BIN}" "${circuitFile}" --r1cs --wasm --sym -o "${BUILD_DIR}"`;
    console.log(`   ${circomCmd}`);
    execSync(circomCmd, { stdio: "inherit" });
    console.log("✅ Circuit derlendi");

    const r1csFile = path.join(BUILD_DIR, `${CIRCUIT_NAME}.r1cs`);
    const zkeyFile0 = path.join(BUILD_DIR, `${CIRCUIT_NAME}_0000.zkey`);
    const zkeyFinal = path.join(BUILD_DIR, `${CIRCUIT_NAME}_final.zkey`);
    const vkeyFile  = path.join(BUILD_DIR, "verification_key.json");

    // 3. Trusted setup (phase 2)
    console.log("🔐 Trusted setup (phase 2) başlatılıyor...");
    await snarkjs.zKey.newZKey(r1csFile, PTAU_FILE, zkeyFile0);
    console.log("✅ Initial zkey oluşturuldu");

    // 4. Beacon ile finalize (gerçek ceremony için daha güçlü entropy kullanılmalı)
    console.log("🎲 Beacon uygulanıyor...");
    const beacon = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    await snarkjs.zKey.beacon(zkeyFile0, zkeyFinal, "OXO Rollup Beacon", beacon, 10, console);
    console.log("✅ Final zkey hazır");

    // 5. Verification key export
    console.log("📤 Verification key export ediliyor...");
    const vKey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
    fs.writeFileSync(vkeyFile, JSON.stringify(vKey, null, 2));
    console.log("✅ verification_key.json oluşturuldu");

    // 6. Solidity verifier üret
    console.log("📝 Solidity verifier üretiliyor...");
    const templatePath = path.join(
        path.dirname(require.resolve("snarkjs")),
        "../templates/verifier_groth16.sol.ejs"
    );
    const solidityVerifier = await snarkjs.zKey.exportSolidityVerifier(zkeyFinal, {
        groth16: fs.readFileSync(templatePath, "utf8")
    });
    const verifierPath = path.join(CONTRACTS_DIR, "ZKVerifier.sol");
    fs.writeFileSync(verifierPath, solidityVerifier);
    console.log(`✅ ZKVerifier.sol → ${verifierPath}`);

    // 7. r1cs bilgisi
    const r1csInfo = await snarkjs.r1cs.info(r1csFile, console);
    console.log(`\n📊 Circuit istatistikleri:`);
    console.log(`   Kısıtlama sayısı: ${r1csInfo.nConstraints}`);
    console.log(`   Sinyal sayısı: ${r1csInfo.nVars}`);

    console.log("\n🎉 Setup tamamlandı!");
    console.log("   Sonraki adım: npx hardhat compile && npx hardhat test test/OXORollup.js");
}

main().catch((e) => { console.error(e); process.exit(1); });
