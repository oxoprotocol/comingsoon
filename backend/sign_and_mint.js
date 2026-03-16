// sign_and_mint.js - Tek seferlik imza üret + mintAndTransfer çağrısı (ethers v6)

require('dotenv').config();
const { ethers } = require("ethers");
const { JsonRpcProvider, Wallet, Contract, getBytes, hashMessage, recoverAddress } = ethers;

// ==== KULLANICI GİRDİLERİ (senin verilerin) ====
const TO = "0xF74869853ca0675c28a1a68E7796F10d495Ff3AC";      // alıcı (platform) adresi
const AMOUNT = 4400n;                                      // sats -> BigInt (n ile)
const DEPOSIT_ID = "0xe4e9765b6ca094142c6555368e9f3496a6301ade04d831e1faefea5e2bd95b87"; // BTC TXID (bytes32)

// ==== ORTAM ====
const RPC = process.env.SEPOLIA_RPC_URL;                   // .env'den
const BRIDGE_ADDR = process.env.BRIDGE_CONTRACT_ADDRESS;   // .env'den
const PK = process.env.SIGNER_PRIVATE_KEY;                 // SIGNER_ROLE sahibi private key

// BridgeV3 ABI (gerekli fonksiyonlar)
const BRIDGE_ABI = [
  "function mintAndTransfer(address _to, uint256 _amount, bytes32 _depositId, bytes _signature)",
  "function computeDigest(address to, uint256 amount, bytes32 depositId) view returns (bytes32)"
];

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(PK, provider);
  const bridge = new Contract(BRIDGE_ADDR, BRIDGE_ABI, wallet);

  console.log("Signer:", wallet.address);
  console.log("Bridge:", BRIDGE_ADDR);

  // 1) Kontrattan digest’i hesapla (kontratla %100 aynı formül olduğundan en güvenlisi bu)
  const digest = await bridge.computeDigest(TO, AMOUNT, DEPOSIT_ID);
  console.log("Digest (computeDigest):", digest);

  // 2) Bu digest’i EIP-191 şeklinde imzala (ethers v6: signMessage + getBytes)
  const signature = await wallet.signMessage(getBytes(digest));
  console.log("Signature:", signature);

  // 3) İmzanın gerçekten SIGNER tarafından mı üretildiğini lokalde doğrula
  const recovered = recoverAddress(hashMessage(getBytes(digest)), signature);
  console.log("Recovered signer:", recovered);
  if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("Signer doğrulaması başarısız! (recovered != wallet.address)");
  }

  // 4) mintAndTransfer çağrısını gönder
  console.log("Sending mintAndTransfer...");
  const tx = await bridge.mintAndTransfer(TO, AMOUNT, DEPOSIT_ID, signature);
  const receipt = await tx.wait();
  console.log("✅ Mint tx mined:", receipt.hash);
}

main().catch(err => {
  console.error("HATA:", err);
  process.exit(1);
});
