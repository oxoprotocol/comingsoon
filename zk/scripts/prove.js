// prove.js — ZK proof üretici yardımcısı
// Kullanım: const { generateProof, computeStateRoot } = require('./prove');

const snarkjs = require("snarkjs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

const BUILD_DIR = path.join(__dirname, "../build");
const WASM_FILE = path.join(BUILD_DIR, "rollup_js", "rollup.wasm");
const ZKEY_FILE = path.join(BUILD_DIR, "rollup_final.zkey");

let poseidon = null;

async function getPoseidon() {
    if (!poseidon) poseidon = await buildPoseidon();
    return poseidon;
}

// Poseidon hash — 8 bakiyenin state root'unu hesapla
async function computeStateRoot(balances) {
    const F = (await getPoseidon()).F;
    const p = await getPoseidon();
    const inputs = balances.map(b => BigInt(b));
    const hash = p(inputs);
    return F.toString(hash);
}

// Batch için ZK proof üret
// transfers: [{from: idx, to: idx, amount: bigint}, ...]  (4 adet)
// balances:  [bigint x 8]  — mevcut bakiyeler
// newBalances: [bigint x 8] — transferlerden sonraki bakiyeler
async function generateProof(balances, newBalances, transfers) {
    if (transfers.length !== 4) throw new Error("Tam olarak 4 transfer gerekli");
    if (balances.length !== 8 || newBalances.length !== 8) throw new Error("8 hesap gerekli");

    const oldRoot = await computeStateRoot(balances);
    const newRoot = await computeStateRoot(newBalances);

    const input = {
        oldRoot,
        newRoot,
        balances:    balances.map(String),
        newBalances: newBalances.map(String),
        froms:   transfers.map(t => String(t.from)),
        tos:     transfers.map(t => String(t.to)),
        amounts: transfers.map(t => String(t.amount)),
    };

    console.log("🔄 Witness hesaplanıyor...");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_FILE, ZKEY_FILE);
    console.log("✅ Proof üretildi");

    // Solidity'e gönderilecek format
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const parsed = JSON.parse(`[${calldata}]`);

    return {
        proof,
        publicSignals,
        // submitBatch(a, b, c, publicSignals) için:
        a: parsed[0],
        b: parsed[1],
        c: parsed[2],
        oldRoot: publicSignals[0],
        newRoot:  publicSignals[1],
    };
}

// Bakiye güncellemesini uygula (off-chain state için)
function applyTransfers(balances, transfers) {
    const updated = [...balances.map(BigInt)];
    for (const tx of transfers) {
        if (updated[tx.from] < BigInt(tx.amount)) throw new Error(`Yetersiz bakiye: hesap ${tx.from}`);
        if (tx.from === tx.to) throw new Error("from == to olamaz");
        updated[tx.from] -= BigInt(tx.amount);
        updated[tx.to]   += BigInt(tx.amount);
    }
    return updated;
}

module.exports = { generateProof, computeStateRoot, applyTransfers, getPoseidon };
