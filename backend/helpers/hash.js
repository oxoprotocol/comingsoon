// helpers/hash.js
const { AbiCoder, keccak256 } = require("ethers");

/**
 * Ethereum kontratının beklediği veriyi (adres ve miktar) ABI kodlayıp Keccak-256 hash'ini hesaplar.
 * @param {string} address - Alıcının Ethereum adresi.
 * @param {bigint} amount - Mint edilecek token miktarı (BigInt).
 * @returns {string} Kontratın beklediği hash (digest).
 */
function getDepositDigest(address, amount) {
  // 1. Veriyi ABI kurallarına göre encode et
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    [address, amount]
  );
  // 2. Encode edilmiş verinin Keccak-256 hash'ini al
  return keccak256(encoded);
}

module.exports = { getDepositDigest };