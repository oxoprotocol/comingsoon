const { ethers } = require('ethers');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);

// Bu, tb1q0fapfj4menlemnv6cdkv69jk6p7hg3su93z7s2 adresini oluşturan Ethereum adresi.
const ethAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Bu da senin için oluşturduğumuz sistem seed phrase'i.
const seedphrase = "orbit canyon whisper lava galaxy stumble ocean horizon quantum journey universe code";

// Deterministic anahtarı oluşturma
const seed = ethers.sha256(ethers.toUtf8Bytes(ethAddress + seedphrase));
const root = bip32.fromSeed(Buffer.from(seed.substring(2), 'hex'));
const path = `m/84'/1'/0'/0/0`;
const child = root.derivePath(path);

// Özel anahtarı WIF formatında yazdır
console.log("Özel Anahtarınız:", child.toWIF());