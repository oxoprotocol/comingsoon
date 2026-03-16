// OXO ZK Rollup Sequencer
// Çalıştır: node zk/sequencer/index.js

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const express  = require("express");
const cors     = require("cors");
const { ethers } = require("ethers");
const snarkjs  = require("snarkjs");
const path     = require("path");
const fs       = require("fs");

const { RollupState, BATCH_SIZE } = require("./state");

// ── Config ──────────────────────────────────────────────────────────────────
const PORT       = process.env.ROLLUP_PORT || 3002;
const WASM_FILE  = path.join(__dirname, "../build/rollup_js/rollup.wasm");
const ZKEY_FILE  = path.join(__dirname, "../build/rollup_final.zkey");

const ROLLUP_ABI = [
    "function submitBatch(uint256 oldRoot, uint256 newRoot, uint[2] a, uint[2][2] b, uint[2] c) external",
    "function withdraw(address user, uint256 amount) external",
    "function registerAccount(address user) external returns (uint8)",
    "function stateRoot() view returns (uint256)",
    "function batchId() view returns (uint256)",
    "function deposit(uint256 amount) external",
];

const provider     = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const sequencerWallet = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY, provider);
const rollupContract  = process.env.ROLLUP_CONTRACT_ADDRESS
    ? new ethers.Contract(process.env.ROLLUP_CONTRACT_ADDRESS, ROLLUP_ABI, sequencerWallet)
    : null;

const state = new RollupState();

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "OXO Rollup Sequencer aktif", port: PORT }));

// Rollup durumu
app.get("/state", async (req, res) => {
    res.json(state.summary());
});

// Bakiye sorgula
app.get("/balance/:address", (req, res) => {
    const bal = state.getBalance(req.params.address);
    res.json({ address: req.params.address, balance: bal.toString() });
});

// Deposit bildir (L1 event'inden tetiklenir veya manuel test)
app.post("/deposit", async (req, res) => {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: "address ve amount gerekli" });
    try {
        state.addDeposit(address, amount);
        res.json({ success: true, balance: state.getBalance(address).toString() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Transfer isteği
app.post("/transfer", async (req, res) => {
    const { from, to, amount } = req.body;
    if (!from || !to || !amount) return res.status(400).json({ error: "from, to, amount gerekli" });

    try {
        const queueLen = state.addTransfer(from, to, amount);
        const info = { success: true, queueLength: queueLen, batchSize: BATCH_SIZE };

        // 4 tx biriktiyse otomatik batch gönder
        if (queueLen >= BATCH_SIZE) {
            info.batchTriggered = true;
            // async olarak gönder, hemen cevap dön
            submitNextBatch().catch(e => console.error("[Batch Hata]", e.message));
        }

        res.json(info);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// L2 → L1 çekim
app.post("/withdraw", async (req, res) => {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: "address ve amount gerekli" });

    let deducted = false;
    try {
        state.deductBalance(address, amount);
        deducted = true;

        if (!rollupContract) {
            console.log(`[Withdraw] Simülasyon: ${address} ${amount}`);
            return res.json({ success: true, txHash: "0x_simulated", simulated: true });
        }

        console.log(`[Withdraw] ${address} için ${amount} çekiliyor...`);
        const tx = await rollupContract.withdraw(address, BigInt(amount));
        const receipt = await tx.wait();
        console.log(`✅ [Withdraw] TX: ${receipt.hash}`);
        res.json({ success: true, txHash: receipt.hash });
    } catch (e) {
        if (deducted) state.addDeposit(address, amount); // on-chain hata → L2 bakiyeyi geri yükle
        res.status(400).json({ error: e.message });
    }
});

// Manuel batch tetikleme (test/admin)
app.post("/force-batch", async (req, res) => {
    // Eksik tx'leri boş (no-op) ile doldur
    const pending = state.pendingTxs.length;
    const needed  = BATCH_SIZE - pending;
    if (needed > 0 && state.accountCount >= 2) {
        // Sıfır miktarlı no-op transferler ekle (from==0, to==1, amount==0)
        // NOT: circuit amount>0 zorunlu kılıyor, bu yüzden gerçek no-op için
        // ayrı bir circuit gerekir. Bu endpoint sadece full batch durumunda çalışır.
        return res.status(400).json({
            error: `Batch için ${BATCH_SIZE} tx gerekli, şu an ${pending} var`,
            pending
        });
    }
    try {
        const txHash = await submitNextBatch();
        res.json({ success: true, txHash });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Batch Submit ─────────────────────────────────────────────────────────────
async function submitNextBatch() {
    const batch = await state.prepareBatch();
    if (!batch) throw new Error("Yeterli tx yok");

    console.log(`\n[Batch #${state.batchId}] Proof üretiliyor...`);

    const input = {
        oldRoot:     batch.oldRoot,
        newRoot:     batch.newRoot,
        balances:    batch.oldBalances,
        newBalances: batch.newBalances,
        froms:       batch.transfers.map(t => String(t.from)),
        tos:         batch.transfers.map(t => String(t.to)),
        amounts:     batch.transfers.map(t => String(t.amount)),
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_FILE, ZKEY_FILE);
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [a, b, c] = JSON.parse(`[${calldata}]`);

    if (!rollupContract) {
        console.log("[Batch] ROLLUP_CONTRACT_ADDRESS tanımlı değil — proof sadece loglandı");
        console.log("  oldRoot:", batch.oldRoot);
        console.log("  newRoot:", batch.newRoot);
        return "0x_simulated";
    }

    console.log("[Batch] On-chain gönderiliyor...");
    const tx = await rollupContract.submitBatch(
        batch.oldRoot,
        batch.newRoot,
        a, b, c
    );
    const receipt = await tx.wait();
    console.log(`✅ [Batch #${state.batchId}] TX: ${receipt.hash}`);
    return receipt.hash;
}

// ── Başlat ──────────────────────────────────────────────────────────────────
async function start() {
    await state.init();

    if (!fs.existsSync(WASM_FILE)) {
        console.warn("⚠️  WASM dosyası bulunamadı. Önce: node zk/scripts/setup.js");
    }

    app.listen(PORT, () => {
        console.log(`\n🚀 OXO Rollup Sequencer: http://localhost:${PORT}`);
        console.log(`   Batch boyutu: ${BATCH_SIZE} transfer`);
        if (rollupContract) {
            console.log(`   Rollup contract: ${process.env.ROLLUP_CONTRACT_ADDRESS}`);
        } else {
            console.log("   ⚠️  ROLLUP_CONTRACT_ADDRESS tanımlı değil (simülasyon modu)");
        }
    });
}

start().catch(e => { console.error(e); process.exit(1); });
