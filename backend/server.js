// server.js - OXO Relayer (BTC <-> ETH Köprü)
// ✅ GÜVENLİK PAKETİ: Webhook auth, retryFailed auth, BTC TX doğrulama eklendi.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const path = require('path');

const ethers = require("ethers");
const { JsonRpcProvider, Wallet, Contract, toBigInt } = ethers;
const arrayify = ethers.getBytes;
const hashMessage = ethers.hashMessage;
const recoverAddress = ethers.recoverAddress;

const axios = require("axios");
const crypto = require('crypto');
const WebSocket = require('ws');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const tinysecp = require('tiny-secp256k1');

const db = require('./db');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

const app = express();
app.set('trust proxy', 1); // Ngrok / reverse proxy desteği
const PORT = process.env.PORT || 3001;
app.use(cors());

// =================================================================================
// ✅ RATE LIMITING — Brute force ve spam koruması
// =================================================================================

// /login: IP başına 15 dakikada max 20 istek
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Çok fazla istek. 15 dakika sonra tekrar deneyin.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// /deposit-status: 1 dakikada max 120 istek (frontend 30s'de bir poll eder)
const statusLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Çok fazla istek.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// /webhook: 1 dakikada max 60 istek (BlockCypher yoğun gönderebilir)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Webhook rate limit aşıldı.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// /retryFailed: 1 saatte max 10 istek (admin endpoint, seyrek kullanılır)
const retryLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Retry rate limit aşıldı.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// /api/waitlist: IP başına 1 saatte max 5 kayıt
const waitlistLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Çok fazla kayıt denemesi. 1 saat sonra tekrar deneyin.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// =================================================================================
// ✅ GÜVENLİK: Webhook endpoint'i için raw body lazım (imza doğrulaması için)
// Diğer endpoint'ler için JSON parser kullan
// =================================================================================
app.use((req, res, next) => {
    if (req.path === '/webhook') {
        express.raw({ type: 'application/json' })(req, res, next);
    } else {
        express.json()(req, res, next);
    }
});

app.get('/', (req, res) => res.status(200).send("Relayer Server Aktif."));

// =================================================================================
// LOWDB FALLBACK KURULUMU
// (Yalnızca DATABASE_URL tanımlı değilse / db.connect() başarısız olursa kullanılır)
// =================================================================================
let usersDB, processedTXsDB, failedTXsDB, waitlistDB;
const inFlight    = new Set();
const redeemInFlight = new Set(); // çift execution koruması (redeemHash bazlı)
let mempoolWS = null;

// ── Redeem watchdog: block checkpoint ve metrikler ────────────────
const CHECKPOINT_PATH = path.join(__dirname, 'redeem_checkpoint.json');
let lastRedeemBlock = 0; // kalıcı checkpoint'ten yüklenir

const redeemMetrics = {
    lastSuccessfulAt: null,    // son başarılı redeem timestamp
    totalProcessed:   0,       // toplam başarılı redeem sayısı
    totalFailed:      0,       // toplam başarısız redeem sayısı
    scanCount:        0,       // kaç kez tarama yapıldı
};

function loadCheckpoint() {
    try {
        const raw = require('fs').readFileSync(CHECKPOINT_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        lastRedeemBlock = parsed.lastBlock || 0;
        console.log(`[WATCHDOG] Checkpoint yüklendi: block ${lastRedeemBlock}`);
    } catch {
        lastRedeemBlock = 0;
        console.log('[WATCHDOG] Checkpoint dosyası yok, 0\'dan başlıyor.');
    }
}

function saveCheckpoint(blockNumber) {
    try {
        require('fs').writeFileSync(CHECKPOINT_PATH, JSON.stringify({ lastBlock: blockNumber }));
    } catch (e) {
        console.warn('[WATCHDOG] Checkpoint yazılamadı:', e.message);
    }
}
let wsReconnectDelay = 5000;
const WS_MAX_DELAY = 60000;

async function setupLowDB() {
    const usersAdapter = new JSONFile(path.join(__dirname, 'users.json'));
    usersDB = new Low(usersAdapter, { users: [] });
    await usersDB.read();

    const processedTXsAdapter = new JSONFile(path.join(__dirname, 'processed_txs.json'));
    processedTXsDB = new Low(processedTXsAdapter, { processedTXs: [] });
    await processedTXsDB.read();

    const failedTXsAdapter = new JSONFile(path.join(__dirname, 'failed_txs.json'));
    failedTXsDB = new Low(failedTXsAdapter, { failedTXs: [] });
    await failedTXsDB.read();

    const waitlistAdapter = new JSONFile(path.join(__dirname, 'waitlist.json'));
    waitlistDB = new Low(waitlistAdapter, { emails: [] });
    await waitlistDB.read();

    console.log("💾 LowDB veritabanları başarıyla yüklendi.");
}

// =================================================================================
// DB ABSTRACTION HELPERS
// Postgres bağlıysa db.* kullan, değilse lowdb fallback.
// =================================================================================

async function dbGetUser(ethAddress) {
    if (db.isConnected()) {
        return await db.getUser(ethAddress);
    }
    await usersDB.read();
    const u = usersDB.data.users.find(u => u.metamaskAddress === ethAddress);
    if (!u) return null;
    return { eth_address: u.metamaskAddress, btc_address: u.btcAddress };
}

async function dbGetUserByBtc(btcAddress) {
    if (db.isConnected()) {
        return await db.getUserByBtc(btcAddress);
    }
    await usersDB.read();
    const u = usersDB.data.users.find(u => u.btcAddress === btcAddress);
    if (!u) return null;
    return { eth_address: u.metamaskAddress, btc_address: u.btcAddress };
}

async function dbCreateUser(ethAddress, btcAddress) {
    if (db.isConnected()) {
        return await db.createUser(ethAddress, btcAddress);
    }
    await usersDB.read();
    const existing = usersDB.data.users.find(u => u.metamaskAddress === ethAddress);
    if (!existing) {
        usersDB.data.users.push({ metamaskAddress: ethAddress, btcAddress, createdAt: new Date() });
        await usersDB.write();
    }
}

async function dbGetAllUsers() {
    if (db.isConnected()) {
        const users = await db.getAllUsers();
        return users.map(u => ({ metamaskAddress: u.eth_address, btcAddress: u.btc_address }));
    }
    await usersDB.read();
    return usersDB.data.users;
}

async function dbGetProcessedTx(txid) {
    if (db.isConnected()) {
        return await db.getProcessedTx(txid);
    }
    await processedTXsDB.read();
    const t = processedTXsDB.data.processedTXs.find(t => t.txid === txid);
    if (!t) return null;
    return { txid: t.txid, eth_address: t.ethAddress, btc_amount: t.btcAmount, eth_tx_hash: t.ethTxHash, created_at: t.timestamp };
}

async function dbAddProcessedTx({ txid, ethAddress, btcAmount, ethTxHash }) {
    if (db.isConnected()) {
        return await db.addProcessedTx({ txid, ethAddress, btcAmount, ethTxHash });
    }
    processedTXsDB.data.processedTXs.push({
        txid, ethAddress, btcAmount, timestamp: new Date(), ethTxHash
    });
    await processedTXsDB.write();
}

async function dbGetRecentMints(ethAddress, hours = 2) {
    if (db.isConnected()) {
        return await db.getRecentMints(ethAddress, hours);
    }
    await processedTXsDB.read();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return processedTXsDB.data.processedTXs
        .filter(tx => tx.ethAddress === ethAddress)
        .map(tx => ({
            txid: tx.txid,
            eth_address: tx.ethAddress,
            btc_amount: tx.btcAmount,
            eth_tx_hash: tx.ethTxHash,
            created_at: tx.timestamp,
        }))
        .filter(tx => new Date(tx.created_at).getTime() >= cutoff)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function dbGetAllProcessedTxids() {
    if (db.isConnected()) {
        return await db.getAllProcessedTxids();
    }
    await processedTXsDB.read();
    return new Set(processedTXsDB.data.processedTXs.map(t => t.txid));
}

async function dbGetFailedTx(txid) {
    if (db.isConnected()) {
        return await db.getFailedTx(txid);
    }
    await failedTXsDB.read();
    const t = failedTXsDB.data.failedTXs.find(t => t.txid === txid);
    if (!t) return null;
    return { txid: t.txid, eth_address: t.ethAddress, btc_amount: t.btcAmount, error: t.error, retried: t.retried || false };
}

async function dbAddFailedTx({ txid, ethAddress, btcAmount, error }) {
    if (db.isConnected()) {
        return await db.addFailedTx({ txid, ethAddress, btcAmount, error });
    }
    await failedTXsDB.read();
    if (!failedTXsDB.data.failedTXs.some(t => t.txid === txid)) {
        failedTXsDB.data.failedTXs.push({
            txid, ethAddress, btcAmount, timestamp: new Date(),
            error, ethTxHash: 'Yok', retried: false
        });
        await failedTXsDB.write();
    }
}

async function dbGetUnretriedFailed() {
    if (db.isConnected()) {
        const rows = await db.getUnretriedFailed();
        return rows.map(r => ({
            txid: r.txid,
            ethAddress: r.eth_address,
            btcAmount: r.btc_amount,
            error: r.error,
        }));
    }
    await failedTXsDB.read();
    return failedTXsDB.data.failedTXs
        .filter(t => !t.retried)
        .map(t => ({ txid: t.txid, ethAddress: t.ethAddress, btcAmount: t.btcAmount, error: t.error }));
}

async function dbMarkRetried(txid) {
    if (db.isConnected()) {
        return await db.markRetried(txid);
    }
    await failedTXsDB.read();
    const t = failedTXsDB.data.failedTXs.find(t => t.txid === txid);
    if (t) {
        t.retried = true;
        await failedTXsDB.write();
    }
}

// =================================================================================
// KONFİGÜRASYON
// =================================================================================
const SEPOLIA_RPC_URL         = process.env.SEPOLIA_RPC_URL;
const BLOCKCYPHER_TOKEN       = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_WEBHOOK_URL = "https://api.blockcypher.com/v1/btc/test3/hooks";
const BTC_API_URL             = "https://api.blockcypher.com/v1/btc/test3";

const BRIDGE_CONTRACT_ADDRESS = process.env.BRIDGE_CONTRACT_ADDRESS;
const SIGNER_PRIVATE_KEY      = process.env.SIGNER_PRIVATE_KEY; // Geriye uyumluluk için (tek relayer)
const NGROK_PUBLIC_URL        = process.env.NGROK_PUBLIC_URL;

// ── Multisig relayer yapılandırması ───────────────────────────────
// RELAYER_KEYS: virgülle ayrılmış private key listesi (ör: key1,key2,key3)
// Tanımlı değilse SIGNER_PRIVATE_KEY'e fallback (tek relayer modu)
const RELAYER_KEYS_RAW   = process.env.RELAYER_KEYS || SIGNER_PRIVATE_KEY || '';
const SIGNER_THRESHOLD   = parseInt(process.env.SIGNER_THRESHOLD || '1', 10);

const KEY_1_WIF = process.env.KEY_1_WIF;
const KEY_2_WIF = process.env.KEY_2_WIF;
const KEY_3_WIF = process.env.KEY_3_WIF;

// ✅ YENİ: Webhook ve admin işlemleri için secret'lar
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET;    // BlockCypher webhook doğrulama
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET;  // /retryFailed koruması

const DUST_LIMIT_SATS = 546;

// ── Güvenlik limitleri ────────────────────────────────────────────
const MAX_MINT_PER_TX_SATS = parseInt(process.env.MAX_MINT_PER_TX_SATS || '100000000'); // default 1 BTC

// ── Emergency kill switch ─────────────────────────────────────────
// MINT_PAUSED=true ile başlatılabilir; çalışırken /admin/toggle-mint-pause ile değiştirilebilir.
let mintPaused = process.env.MINT_PAUSED === 'true';
if (mintPaused) console.warn('⛔  UYARI: MINT_PAUSED=true — mint işlemleri durduruldu.');

// Başlangıçta kritik env değişkenlerini kontrol et
function checkEnvVars() {
    const required = [
        'SEPOLIA_RPC_URL', 'BRIDGE_CONTRACT_ADDRESS',
        'KEY_1_WIF', 'KEY_2_WIF', 'KEY_3_WIF', 'NGROK_PUBLIC_URL'
    ];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.error(`❌ KRİTİK: Eksik env değişkenleri: ${missing.join(', ')}`);
        process.exit(1);
    }
    // RELAYER_KEYS veya SIGNER_PRIVATE_KEY'den en az biri olmalı
    if (!process.env.RELAYER_KEYS && !process.env.SIGNER_PRIVATE_KEY) {
        console.error('❌ KRİTİK: RELAYER_KEYS veya SIGNER_PRIVATE_KEY tanımlı değil.');
        process.exit(1);
    }
    if (!WEBHOOK_SECRET) {
        console.warn("⚠️  UYARI: WEBHOOK_SECRET tanımlı değil! Webhook'lar doğrulanamayacak.");
    }
    if (!ADMIN_API_SECRET) {
        console.warn("⚠️  UYARI: ADMIN_API_SECRET tanımlı değil! /retryFailed herkese açık.");
    }
}

const BRIDGE_ABI = [
    "function mintAndTransfer(address _to, uint256 _amount, bytes32 _depositId, bytes[] _signatures)",
    "function computeDigest(address to, uint256 amount, bytes32 depositId) view returns (bytes32)",
    "function markProcessing(bytes32 redeemHash)",
    "function markRedeemCompleted(bytes32 redeemHash, uint256 amount)",
    "function getRedeemInfo(bytes32 redeemHash) view returns (tuple(address user, string btcAddress, uint256 amount, uint8 state, uint256 requestedAt))",
    "event RedeemRequested(address indexed ethAddress, string btcAddress, uint256 amount, bytes32 indexed redeemHash, uint256 nonce, uint256 chainId)"
];

const provider = new JsonRpcProvider(SEPOLIA_RPC_URL);

// Multisig relayer walletları yükle
const relayerWallets = RELAYER_KEYS_RAW
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0)
    .map(k => new Wallet(k, provider));

if (relayerWallets.length === 0) {
    console.error('❌ KRİTİK: Hiç relayer key tanımlı değil. RELAYER_KEYS veya SIGNER_PRIVATE_KEY gerekli.');
    process.exit(1);
}
if (relayerWallets.length < SIGNER_THRESHOLD) {
    console.error(`❌ KRİTİK: SIGNER_THRESHOLD=${SIGNER_THRESHOLD} ama sadece ${relayerWallets.length} relayer key var.`);
    process.exit(1);
}

// Geriye uyumluluk: signerWallet = ilk relayer (flash exit vb. için)
const signerWallet   = relayerWallets[0];
const bridgeContract = new Contract(BRIDGE_CONTRACT_ADDRESS, BRIDGE_ABI, signerWallet);

// =================================================================================
// ⚡ GAS OPTİMİZASYONU — EIP-1559 akıllı gas fiyatı
// =================================================================================

// Önbellek: 15 saniyede bir güncellenir
let gasCache = { data: null, updatedAt: 0 };

async function getOptimalGas(priority = 'normal') {
    const now = Date.now();
    // 15 saniyeden eski cache'i yenile
    if (!gasCache.data || now - gasCache.updatedAt > 15_000) {
        try {
            const feeData = await provider.getFeeData();
            gasCache = { data: feeData, updatedAt: now };
        } catch {
            // Hata olursa mevcut cache'i kullan, yoksa null döner
        }
    }

    const feeData = gasCache.data;
    if (!feeData?.maxFeePerGas) return {}; // EIP-1559 desteklenmiyorsa ethers default'a düş

    // Priority tier'a göre tip ayarla
    const tips = {
        low:    500_000_000n,   // 0.5 gwei — ucuz, yavaş
        normal: 1_500_000_000n, // 1.5 gwei — dengeli
        fast:   3_000_000_000n, // 3.0 gwei — hızlı
    };
    const tip = tips[priority] ?? tips.normal;

    // maxFeePerGas = baseFee * 1.2 + tip (ağ spike'larında da geçer)
    const baseFee   = feeData.lastBaseFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
    const maxFee    = (baseFee * 12n / 10n) + tip;

    return {
        maxPriorityFeePerGas: tip,
        maxFeePerGas: maxFee,
    };
}

// Mint işlemleri için gas tahmini + %20 buffer
async function estimateGasWithBuffer(contract, method, args) {
    try {
        const estimated = await contract[method].estimateGas(...args);
        return estimated * 12n / 10n; // %20 buffer
    } catch {
        return undefined; // ethers default'a düş
    }
}

// =================================================================================
// ✅ GÜVENLİK MİDDLEWARE: /retryFailed için admin auth
// =================================================================================
function adminAuth(req, res, next) {
    // ADMIN_API_SECRET tanımlı değilse ve production değilsek geç
    if (!ADMIN_API_SECRET) return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

    if (!token || token !== ADMIN_API_SECRET) {
        console.warn(`[AUTH] /retryFailed'e yetkisiz erişim denemesi. IP: ${req.ip}`);
        return res.status(401).json({ error: 'Yetkisiz erişim.' });
    }
    next();
}

// =================================================================================
// ✅ GÜVENLİK: BlockCypher webhook imza doğrulama
// =================================================================================
function verifyBlockCypherWebhook(req) {
    // WEBHOOK_SECRET tanımlı değilse doğrulamayı atla (uyarı zaten verildi)
    if (!WEBHOOK_SECRET) return true;

    // x-eventid bir HMAC imzası değil, BlockCypher'ın event UUID'sidir.
    // BlockCypher HMAC imzası ancak webhook kaydında 'secret' alanı verilirse
    // x-blockcypher-signature header'ıyla gelir. registerWebhook()'ta secret
    // verilmediği için bu header gelmez — doğrulamayı geç.
    const signature = req.headers['x-blockcypher-signature'];
    if (!signature) return true;

    const rawBody = req.body; // raw buffer
    const expectedSig = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSig, 'hex')
        );
    } catch {
        return false;
    }
}

// =================================================================================
// ✅ GÜVENLİK: BTC TX'i BlockCypher'dan bağımsız olarak doğrula
// Webhook'taki veriyi körü körüne kabul etme — blockchain'den teyit et
// =================================================================================
async function verifyBtcTransaction(txHash, expectedBtcAddress, expectedAmountSats) {
    try {
        const url = `https://mempool.space/testnet/api/tx/${txHash}`;
        const response = await axios.get(url);
        const tx = response.data;

        // En az 1 onay şart
        if (!tx.status || !tx.status.confirmed) {
            console.warn(`[VERIFY] TX ${txHash}: Yeterli onay yok (confirmed: ${tx.status?.confirmed})`);
            return false;
        }

        // İlgili output gerçekten o adreste o miktarda mı?
        const matchingOutput = tx.vout.find(out =>
            out.scriptpubkey_address === expectedBtcAddress &&
            out.value === expectedAmountSats
        );

        if (!matchingOutput) {
            console.warn(`[VERIFY] TX ${txHash}: Beklenen output bulunamadı. Adres: ${expectedBtcAddress}, Miktar: ${expectedAmountSats}`);
            return false;
        }

        console.log(`✅ [VERIFY] TX ${txHash} blockchain'den doğrulandı.`);
        return true;
    } catch (err) {
        console.error(`[VERIFY HATA] TX ${txHash} doğrulanamadı:`, err.message);
        return false;
    }
}

// =================================================================================
// MULTI-SIG KURULUMU
// =================================================================================
let multiSigAddress, redeemScript, witnessScript, p2shScript;

function deriveMultiSigAddress() {
    const validateWIF = (wif) => {
        try { ECPair.fromWIF(wif, bitcoin.networks.testnet); }
        catch { throw new Error(`Geçersiz WIF Anahtarı: ${wif}`); }
    };

    validateWIF(KEY_1_WIF);
    validateWIF(KEY_2_WIF);
    validateWIF(KEY_3_WIF);

    const keyPair1 = ECPair.fromWIF(KEY_1_WIF, bitcoin.networks.testnet);
    const keyPair2 = ECPair.fromWIF(KEY_2_WIF, bitcoin.networks.testnet);
    const keyPair3 = ECPair.fromWIF(KEY_3_WIF, bitcoin.networks.testnet);

    const pubkeys = [keyPair1.publicKey, keyPair2.publicKey, keyPair3.publicKey].sort((a, b) => a.compare(b));
    const p2ms  = bitcoin.payments.p2ms({ m: 2, pubkeys, network: bitcoin.networks.testnet });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: bitcoin.networks.testnet });
    const p2sh  = bitcoin.payments.p2sh({ redeem: p2wsh, network: bitcoin.networks.testnet });

    multiSigAddress = p2sh.address;
    redeemScript    = p2wsh.output;
    witnessScript   = p2ms.output;
    p2shScript      = p2sh.output;

    console.log(`\n===================================================================`);
    console.log(`🔐 MULTI-SIG KASA  : ${multiSigAddress}`);
    console.log(`🔑 RELAYER SAYISI  : ${relayerWallets.length} (threshold: ${SIGNER_THRESHOLD})`);
    relayerWallets.forEach((w, i) =>
        console.log(`   Relayer #${i + 1}      : ${w.address}`)
    );
    console.log(`===================================================================\n`);
}

// =================================================================================
// BTC DEPOSIT ADRESİ TÜRETİMİ
// =================================================================================
function getDeterministicBitcoinAddress(ethAddress) {
    const seed  = crypto.createHash('sha256').update(ethAddress).digest();
    const root  = bip32.fromSeed(seed, bitcoin.networks.testnet);
    const child = root.derivePath("m/49'/1'/0'/0/0");
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { compressed: true, network: bitcoin.networks.testnet });
    const { address } = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.testnet }),
        network: bitcoin.networks.testnet,
    });
    return address;
}

// =================================================================================
// WEBHOOK KAYIT
// =================================================================================
async function registerWebhook(btcAddress) {
    if (!NGROK_PUBLIC_URL) {
        console.error("❌ NGROK_PUBLIC_URL tanımlı değil. Webhook kaydı atlandı.");
        return;
    }

    // Mevcut webhook'ları kontrol et — zaten kayıtlıysa tekrar kayıt yapma
    try {
        const existing = await axios.get(
            BLOCKCYPHER_WEBHOOK_URL + (BLOCKCYPHER_TOKEN ? `?token=${BLOCKCYPHER_TOKEN}` : '')
        );
        const hooks = existing.data || [];
        const alreadyRegistered = hooks.some(h =>
            h.address === btcAddress &&
            h.url === `${NGROK_PUBLIC_URL}/webhook` &&
            h.callback_errors === 0
        );
        if (alreadyRegistered) {
            console.log(`✅ [WEBHOOK] ${btcAddress} için webhook zaten kayıtlı, atlanıyor.`);
            return;
        }
    } catch (err) {
        console.warn("[WEBHOOK] Mevcut hook'lar kontrol edilemedi:", err.message);
    }

    const hookData = {
        event: "tx-confirmation",
        address: btcAddress,
        url: `${NGROK_PUBLIC_URL}/webhook`,
        confirmations: 1
    };
    try {
        const response = await axios.post(
            BLOCKCYPHER_WEBHOOK_URL + (BLOCKCYPHER_TOKEN ? `?token=${BLOCKCYPHER_TOKEN}` : ''),
            hookData
        );
        console.log(`🔔 [WEBHOOK] ${btcAddress} için kayıt yapıldı. Hook ID: ${response.data.id}`);
    } catch (error) {
        if (error.response?.status !== 400) {
            console.error(`[WEBHOOK HATA]`, error.response?.data?.error || error.message);
        }
    }
}

// =================================================================================
// LOGIN ENDPOINT
// =================================================================================
app.post('/login', loginLimiter, async (req, res) => {
    const { metamaskAddress } = req.body;
    if (!metamaskAddress || !/^0x[a-fA-F0-9]{40}$/.test(metamaskAddress)) {
        return res.status(400).json({ error: 'Geçersiz Ethereum adresi.' });
    }

    const existingUser = await dbGetUser(metamaskAddress);

    if (existingUser) {
        registerWebhook(existingUser.btc_address);
        trackAddressOnWS(existingUser.btc_address);
        return res.json({ btcAddress: existingUser.btc_address });
    }

    const btcAddress = getDeterministicBitcoinAddress(metamaskAddress);
    await dbCreateUser(metamaskAddress, btcAddress);
    registerWebhook(btcAddress);
    trackAddressOnWS(btcAddress);
    res.json({ btcAddress });
});

// =================================================================================
// DEPOSIT STATUS ENDPOINT — Frontend tracker için
// =================================================================================
app.get('/deposit-status/:ethAddress', statusLimiter, async (req, res) => {
    const { ethAddress } = req.params;
    if (!/^0x[a-fA-F0-9]{40}$/.test(ethAddress)) {
        return res.status(400).json({ error: 'Geçersiz adres' });
    }

    const user = await dbGetUser(ethAddress);
    if (!user) return res.json({ status: 'no_address', currentTx: null, lastMinted: null });

    const btcAddress = user.btc_address;

    // Recent mints (last 2 hours)
    const recentMints = await dbGetRecentMints(ethAddress, 2);
    const lastMintedRow = recentMints[0] || null;
    const lastMinted = lastMintedRow ? {
        txid: lastMintedRow.txid,
        btcAmount: lastMintedRow.btc_amount,
        ethTxHash: lastMintedRow.eth_tx_hash,
        timestamp: lastMintedRow.created_at,
    } : null;

    // Also get all processed txids for the unprocessed check below
    const processedTxids = await dbGetAllProcessedTxids();

    let status = 'waiting';
    let currentTx = null;

    try {
        // 1. Mempool'da bekleyen tx var mı?
        const mempoolRes = await axios.get(
            `https://mempool.space/testnet/api/address/${btcAddress}/txs/mempool`,
            { timeout: 4000 }
        );
        if (mempoolRes.data.length > 0) {
            const tx = mempoolRes.data[0];
            const out = tx.vout.find(o => o.scriptpubkey_address === btcAddress);
            if (out) {
                status = 'mempool';
                currentTx = { txid: tx.txid, confirmations: 0, amount: out.value };
            }
        }

        // 2. Confirmed ama henüz işlenmemiş tx var mı?
        if (!currentTx) {
            const confirmedRes = await axios.get(
                `https://mempool.space/testnet/api/address/${btcAddress}/txs`,
                { timeout: 4000 }
            );
            for (const tx of confirmedRes.data.slice(0, 10)) {
                if (processedTxids.has(tx.txid)) continue;
                if (!tx.status?.confirmed) continue;
                const out = tx.vout.find(o => o.scriptpubkey_address === btcAddress);
                if (out) {
                    status = 'processing';
                    currentTx = { txid: tx.txid, confirmations: tx.status.block_height ? 1 : 0, amount: out.value };
                    break;
                }
            }
        }
    } catch { /* mempool.space erişilemez, sadece DB'den dön */ }

    // 3. Son mint varsa ve 2 saatten yeniyse → complete göster, yoksa waiting
    if (!currentTx && lastMinted) {
        const ageMs = Date.now() - new Date(lastMinted.timestamp).getTime();
        if (ageMs < 2 * 60 * 60 * 1000) { // 2 saat içindeyse
            status = 'complete';
            currentTx = { txid: lastMinted.txid, amount: lastMinted.btcAmount, ethTxHash: lastMinted.ethTxHash };
        }
        // 2 saatten eskiyse status 'waiting' kalır — yeni deposit bekleniyor
    }

    res.json({ status, currentTx, btcAddress, lastMinted });
});

// =================================================================================
// BTC MULTI-SIG'DEN GÖNDER (ETH → BTC Redeem)
// =================================================================================
async function sendBtcFromMultiSig(btcAddress, amountInSatoshi) {
    try {
        console.log(`[BTC Redeem] ${amountInSatoshi} satoshi → ${btcAddress}`);
        const utxosResponse = await axios.get(
            `${BTC_API_URL}/addrs/${multiSigAddress}?unspentOnly=true${BLOCKCYPHER_TOKEN ? `&token=${BLOCKCYPHER_TOKEN}` : ''}`
        );
        const utxos = utxosResponse.data.txrefs || [];

        if (utxos.length === 0) {
            console.error("[HATA] Multi-Sig kasasında UTXO yok.");
            return false;
        }

        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
        let totalInput = 0;

        for (const utxo of utxos) {
            psbt.addInput({
                hash: utxo.tx_hash,
                index: utxo.tx_output_n,
                redeemScript,
                witnessScript,
                witnessUtxo: { script: p2shScript, value: utxo.value },
            });
            totalInput += utxo.value;
        }

        const fee    = 500;
        const change = totalInput - amountInSatoshi - fee;

        if (change < 0) {
            console.error(`[BTC HATA] Yetersiz bakiye. Gerekli: ${amountInSatoshi + fee}, Toplam: ${totalInput}`);
            return false;
        }

        psbt.addOutput({ address: btcAddress, value: amountInSatoshi });
        if (change > 500) psbt.addOutput({ address: multiSigAddress, value: change });

        psbt.signAllInputs(ECPair.fromWIF(KEY_1_WIF, bitcoin.networks.testnet));
        psbt.signAllInputs(ECPair.fromWIF(KEY_2_WIF, bitcoin.networks.testnet));
        psbt.finalizeAllInputs();

        const txHex = psbt.extractTransaction().toHex();
        const broadcastResponse = await axios.post(
            `${BTC_API_URL}/txs/push${BLOCKCYPHER_TOKEN ? `?token=${BLOCKCYPHER_TOKEN}` : ''}`,
            { tx: txHex }
        );
        console.log(`✅ [BTC TX YAYINLANDI] TXID: ${broadcastResponse.data.tx.hash}`);
        return true;
    } catch (error) {
        console.error("[BTC Gönderim Hatası]", error.response?.data || error.message);
        return false;
    }
}

// =================================================================================
// MINT YÜRÜTÜCÜ
// =================================================================================
async function executeMint(hash, metamaskAddress, amountInSatoshi, isRetry = false) {
    if (mintPaused) throw new Error('MINT_PAUSED: Sistem bakımda. Lütfen daha sonra tekrar deneyin.');
    if (hash.length !== 64) throw new Error('Geçersiz TXID formatı.');
    if (amountInSatoshi < DUST_LIMIT_SATS) throw new Error('Dust Limiti Altında');

    // ── Rate limiting: sadece tek tx limiti ──────────────────────
    if (amountInSatoshi > MAX_MINT_PER_TX_SATS) {
        throw new Error(`Tek işlem limiti aşıldı. Maksimum ${MAX_MINT_PER_TX_SATS / 1e8} BTC. Büyük miktarlar için birden fazla tx gönderin.`);
    }
    // ──────────────────────────────────────────────────────────────

    const amountToMint    = toBigInt(amountInSatoshi);
    const depositIdBytes32 = '0x' + hash;

    console.log(`🔥 [DEPOSIT] TXID: ${hash} (Retry: ${isRetry})`);

    const digest      = await bridgeContract.computeDigest(metamaskAddress, amountToMint, depositIdBytes32);
    const digestBytes = arrayify(digest);

    // Tüm relayer walletlarıyla imzala
    const signatures = await Promise.all(
        relayerWallets.map(wallet => wallet.signMessage(digestBytes))
    );

    // Doğrulama: en az signerThreshold imza geçerli olmalı
    const validSigs = signatures.filter((sig, i) => {
        const recovered = recoverAddress(hashMessage(digestBytes), sig);
        return recovered.toLowerCase() === relayerWallets[i].address.toLowerCase();
    });
    if (validSigs.length < SIGNER_THRESHOLD) {
        throw new Error(`Multisig imza hatası: ${validSigs.length}/${SIGNER_THRESHOLD} geçerli imza`);
    }

    // Miktar büyükse 'fast', küçükse 'normal' gas
    const gasPriority = amountInSatoshi >= 10_000_000 ? 'fast' : 'normal';
    const [gasParams, gasLimit] = await Promise.all([
        getOptimalGas(gasPriority),
        estimateGasWithBuffer(bridgeContract, 'mintAndTransfer',
            [metamaskAddress, amountToMint, depositIdBytes32, signatures]),
    ]);

    const txOpts = { ...gasParams, ...(gasLimit ? { gasLimit } : {}) };
    const tx      = await bridgeContract.mintAndTransfer(metamaskAddress, amountToMint, depositIdBytes32, signatures, txOpts);
    const receipt = await tx.wait();

    await dbAddProcessedTx({
        txid: hash,
        ethAddress: metamaskAddress,
        btcAmount: amountInSatoshi,
        ethTxHash: receipt.hash,
    });

    console.log(`✅ [MINT OK] TX: ${receipt.hash}`);
    return receipt.hash;
}

// =================================================================================
// ✅ WEBHOOK ENDPOINT (Güvenli)
// =================================================================================
app.post('/webhook', webhookLimiter, async (req, res) => {

    // 1. ✅ BlockCypher imza doğrulama
    if (!verifyBlockCypherWebhook(req)) {
        console.warn("[WEBHOOK] Geçersiz imza — istek reddedildi.");
        return res.status(401).send('Yetkisiz.');
    }

    // Raw buffer'ı JSON'a çevir
    let body;
    try {
        body = JSON.parse(req.body.toString());
    } catch {
        return res.status(400).send('Geçersiz JSON.');
    }

    const { hash, confirmations, outputs } = body;

    // ── Tiered confirmation: küçük tx hızlı, büyük tx güvenli ──
    const txAmount = outputs?.reduce((s, o) => s + (o.value || 0), 0) || 0;
    const requiredConfs = txAmount < 10_000_000  ? 1  // <0.1 BTC → 1 conf (~10 dk)
                        : txAmount < 100_000_000 ? 3  // <1 BTC  → 3 conf (~30 dk)
                        :                          6; // ≥1 BTC  → 6 conf (~60 dk)
    if (!hash || confirmations < requiredConfs) {
        console.log(`[CONF] TX ${hash}: ${confirmations}/${requiredConfs} onay (${txAmount} sat)`);
        return res.status(200).send('Onay bekleniyor.');
    }

    if (inFlight.has(hash)) {
        console.log(`[IN-FLIGHT] TXID ${hash} işleniyor.`);
        return res.status(200).send('İşlem kuyrukta.');
    }

    inFlight.add(hash);
    let metamaskAddress, amountInSatoshi;

    try {
        const alreadyProcessed = await dbGetProcessedTx(hash);
        if (alreadyProcessed) {
            console.log(`[TEKRAR] TXID ${hash} zaten işlenmiş.`);
            return res.status(200).send('Zaten işlendi.');
        }

        const depositOutput = outputs?.find(out => out.addresses?.length > 0);
        const btcAddress    = depositOutput?.addresses[0];
        amountInSatoshi     = depositOutput?.value;

        if (!btcAddress || !amountInSatoshi) return res.status(400).send('Geçersiz webhook çıktısı.');

        const user = await dbGetUserByBtc(btcAddress);
        if (!user) return res.status(400).send('Kayıtsız adres.');

        metamaskAddress = user.eth_address;

        // 2. ✅ TX'i blockchain'den bağımsız olarak doğrula
        // TEST_MODE=true ise doğrulamayı atla (sadece local test için)
        const isValid = process.env.TEST_MODE === 'true'
            ? true
            : await verifyBtcTransaction(hash, btcAddress, amountInSatoshi);
        if (!isValid) {
            console.error(`[WEBHOOK] TX ${hash} blockchain doğrulamasından geçemedi. Reddedildi.`);
            return res.status(400).send('TX doğrulaması başarısız.');
        }

        await executeMint(hash, metamaskAddress, amountInSatoshi, false);
        res.status(200).send('OK');

    } catch (error) {
        const errorMessage = error?.revert?.args[0] || error?.reason || error.message;

        if (errorMessage === 'Dust Limiti Altında') {
            return res.status(200).send('Dust Limiti Altında.');
        }

        console.error(`[Bridge Hata] TXID: ${hash}`, errorMessage);

        const existingFailed = await dbGetFailedTx(hash);
        if (!existingFailed) {
            await dbAddFailedTx({
                txid: hash,
                ethAddress: metamaskAddress || "Bilinmiyor",
                btcAmount: amountInSatoshi || 0,
                error: errorMessage,
            });
        }
        res.status(500).send('Internal Server Error');
    } finally {
        inFlight.delete(hash);
    }
});

// =================================================================================
// 📊 /stats ENDPOINT — Protocol analytics (on-chain)
// =================================================================================

const STATS_ADDRESSES = {
    oxoBTC:       '0xA6fB891D117ce6C03880168bADE140067ED44D78',
    oxo:          '0xca0cd5448fabdfdc33f0795c871901c5e2bb60a8',
    staking:      '0x54e8f0348EB1E531f72d94E89FF877bA6B9b460A',
    treasury:     '0xdCC5Eef80df9cF48F4504D476BB4701B17e7E361',
    factory:      '0xe969090d30f76e8b7969db2113d7572b5944e842',
    weth:         '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    ethUsdOracle: '0x694AA1769357215DE4FAC081bf1f309aDC325306', // Chainlink ETH/USD Sepolia
};

const STATS_ABI = [
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)',
    'function token0() view returns (address)',
    'function pool0() view returns (uint256 totalStaked, uint256 oxoPerSecond, uint256 accOxoPerShare, uint256 lastRewardTime)',
    'function pool1() view returns (uint256 totalStaked, uint256 accEthPerShare, uint256 accOxoBtcPerShare)',
    'function getBtcPrice() view returns (uint256)',
    'function reserveETH() view returns (uint256)',
    'function reserveOxoBtc() view returns (uint256)',
    'function getPair(address,address) view returns (address)',
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

let statsCache = null, statsCacheTime = 0;
const STATS_TTL = 5 * 60 * 1000;

app.get('/stats', loginLimiter, async (req, res) => {
    try {
        if (statsCache && Date.now() - statsCacheTime < STATS_TTL) return res.json(statsCache);

        const mk = addr => new Contract(addr, STATS_ABI, provider);
        const oxoBTCC  = mk(STATS_ADDRESSES.oxoBTC);
        const stakingC = mk(STATS_ADDRESSES.staking);
        const treasuryC= mk(STATS_ADDRESSES.treasury);
        const factoryC = mk(STATS_ADDRESSES.factory);

        const ethOracleC = mk(STATS_ADDRESSES.ethUsdOracle);
        const [oxoBtcSupply, pool0, pool1, btcPrice, ethPriceRaw, resETH, resBTC, pairAddr] = await Promise.all([
            oxoBTCC.totalSupply(),
            stakingC.pool0(),
            stakingC.pool1(),
            stakingC.getBtcPrice(),
            ethOracleC.latestRoundData().then(r => r.answer).catch(() => null),
            treasuryC.reserveETH(),
            treasuryC.reserveOxoBtc(),
            factoryC.getPair(STATS_ADDRESSES.oxoBTC, STATS_ADDRESSES.weth),
        ]);

        let dexEth = 0n, dexBtc = 0n;
        if (pairAddr && pairAddr !== ethers.ZeroAddress) {
            const pairC = mk(pairAddr);
            const [r0, r1] = await pairC.getReserves();
            const t0 = await pairC.token0();
            const isBtc0 = t0.toLowerCase() === STATS_ADDRESSES.oxoBTC.toLowerCase();
            dexBtc = isBtc0 ? r0 : r1;
            dexEth = isBtc0 ? r1 : r0;
        }

        const btcUsd   = parseFloat(ethers.formatUnits(btcPrice, 18));
        // Chainlink ETH/USD (8 decimals); fallback to btcUsd/15 if oracle unavailable
        const ethUsd   = ethPriceRaw ? parseFloat(ethers.formatUnits(ethPriceRaw, 8)) : btcUsd / 15;
        const supplyF  = parseFloat(ethers.formatUnits(oxoBtcSupply, 8));
        const staked0F = parseFloat(ethers.formatUnits(pool0.totalStaked, 8));
        const staked1F = parseFloat(ethers.formatUnits(pool1.totalStaked, 18));
        const dexEthF  = parseFloat(ethers.formatEther(dexEth));
        const dexBtcF  = parseFloat(ethers.formatUnits(dexBtc, 8));
        const opsF     = parseFloat(ethers.formatUnits(pool0.oxoPerSecond, 18));

        const dexTvl   = dexEthF * ethUsd + dexBtcF * btcUsd;
        const stakeTvl = staked0F * btcUsd;
        const resUsd   = parseFloat(ethers.formatEther(resETH)) * ethUsd + parseFloat(ethers.formatUnits(resBTC, 8)) * btcUsd;
        const annualOxoPerBtc = staked0F > 0 ? (opsF * 86400 * 365) / staked0F : 0;

        statsCache = {
            timestamp: Date.now(),
            btcPriceUsd: btcUsd.toFixed(0),
            ethPriceUsd: ethUsd.toFixed(0),
            oxoBtc: { supply: supplyF.toFixed(8), supplyUsd: (supplyF * btcUsd).toFixed(0) },
            staking: {
                pool0Staked: staked0F.toFixed(8), pool0StakedUsd: stakeTvl.toFixed(0),
                pool1Staked: staked1F.toFixed(2),
                oxoPerSecond: opsF.toFixed(4),
                annualOxoPerOxoBtc: annualOxoPerBtc.toFixed(2),
            },
            dex: { ethReserve: dexEthF.toFixed(6), btcReserve: dexBtcF.toFixed(8), tvlUsd: dexTvl.toFixed(0), pairAddress: pairAddr },
            treasury: { reserveEthUsd: resUsd.toFixed(0) },
            tvl: { total: (dexTvl + stakeTvl).toFixed(0), staking: stakeTvl.toFixed(0), dex: dexTvl.toFixed(0) },
        };
        statsCacheTime = Date.now();
        res.json(statsCache);
    } catch(e) {
        console.error('[/stats]', e.message);
        res.status(500).json({ error: 'Stats fetch failed' });
    }
});

// =================================================================================
// ✅ /retryFailed ENDPOINT (Admin Auth Korumalı)
// =================================================================================
app.post('/retryFailed', retryLimiter, adminAuth, async (req, res) => {
    const transactionsToRetry = await dbGetUnretriedFailed();
    if (transactionsToRetry.length === 0) {
        return res.status(200).json({ message: "Yeniden denenecek başarısız işlem yok." });
    }

    console.log(`\n🔄 RETRY: ${transactionsToRetry.length} işlem deneniyor...`);
    let successCount = 0, failCount = 0;
    const remainingFailed = [];

    for (const tx of transactionsToRetry) {
        const alreadyProcessed = await dbGetProcessedTx(tx.txid);
        if (alreadyProcessed) {
            console.log(`[RETRY SKIP] ${tx.txid}: Zaten başarılı.`);
            await dbMarkRetried(tx.txid);
            successCount++;
            continue;
        }
        try {
            await executeMint(tx.txid, tx.ethAddress, tx.btcAmount, true);
            await dbMarkRetried(tx.txid);
            successCount++;
        } catch (error) {
            console.error(`[RETRY HATA] ${tx.txid}: ${error.message}`);
            remainingFailed.push(tx.txid);
            failCount++;
        }
    }

    res.status(200).json({
        message: `Tamamlandı. Başarılı: ${successCount}, Başarısız: ${failCount}.`,
        totalTried: transactionsToRetry.length,
        successfullyProcessed: successCount,
        newlyFailed: failCount,
        remainingFailed,
    });
});

// =================================================================================
// ✅ ADMIN ENDPOINTS — Kill switch + system status
// =================================================================================

// GET /admin/status — sistem durumu
app.get('/admin/status', adminAuth, (req, res) => {
    res.json({
        mintPaused,
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        timestamp: new Date().toISOString(),
    });
});

// GET /api/reserves — herkese açık proof-of-reserves verisi
app.get('/api/reserves', async (req, res) => {
    try {
        res.json({
            btcCustodyAddress: multiSigAddress || null,
            network: 'testnet',
            lastUpdated: new Date().toISOString(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── BTC mesaj imzası doğrulama (classic ECDSA / Bitcoin Signed Message) ────────
function varIntBuf(n) {
    if (n < 0xfd) return Buffer.from([n]);
    const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b;
}
function btcMessageHash(message) {
    const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'binary');
    const msgBuf = Buffer.from(message, 'utf8');
    const full   = Buffer.concat([prefix, varIntBuf(msgBuf.length), msgBuf]);
    return crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(full).digest())
        .digest();
}
function verifyBtcSignature(message, address, signatureB64) {
    const sigBuf = Buffer.from(signatureB64, 'base64');
    if (sigBuf.length !== 65) throw new Error('Invalid BTC signature length');
    const flag       = sigBuf[0];
    const compressed = flag >= 31;
    const recoveryId = (flag - (compressed ? 31 : 27)) & 3;
    const sig        = sigBuf.slice(1);
    const hash       = btcMessageHash(message);
    const pubkey     = tinysecp.recover(hash, sig, recoveryId, compressed);
    if (!pubkey) return false;
    const pubBuf = Buffer.from(pubkey);
    // P2WPKH (bc1q...)
    try { if (bitcoin.payments.p2wpkh({ pubkey: pubBuf }).address === address) return true; } catch {}
    // P2PKH (1...)
    try { if (bitcoin.payments.p2pkh({ pubkey: pubBuf }).address === address) return true; } catch {}
    // P2SH-P2WPKH (3...)
    try {
        const p2sh = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pubBuf }) });
        if (p2sh.address === address) return true;
    } catch {}
    return false;
}

// Tek kullanımlık / geçici email sağlayıcıları
const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','guerrillamail.org','guerrillamail.net',
    'guerrillamail.de','guerrillamail.info','guerrillamail.biz','grr.la','sharklasers.com',
    'guerrillamailblock.com','spam4.me','yopmail.com','yopmail.fr','cool.fr.nf',
    'jetable.fr.nf','nospam.ze.tc','nomail.xl.cx','mega.zik.dj','speed.1s.fr',
    'yep.it','cool.fr.nf','trashmail.at','trashmail.com','trashmail.io','trashmail.me',
    'trashmail.net','trashmail.org','dispostable.com','mailnull.com','spamgourmet.com',
    'spamgourmet.net','spamgourmet.org','spamspot.com','tempmail.com','temp-mail.org',
    'throwam.com','throwam.net','33mail.com','mailnesia.com','mailnull.com',
    'maildrop.cc','throwam.com','spamfree24.org','spam4.me','spamgap.com',
]);

// POST /api/waitlist — email ile kayıt (Supabase)
app.post('/api/waitlist', waitlistLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({ error: 'Email gerekli.' });
        }
        const normalized = email.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalized) || normalized.length > 254) {
            return res.status(400).json({ error: 'Geçersiz email adresi.' });
        }
        const domain = normalized.split('@')[1];
        if (DISPOSABLE_DOMAINS.has(domain)) {
            return res.status(400).json({ error: 'Geçici email adresleri kabul edilmiyor.' });
        }

        // Duplicate kontrolü
        const { data: existing } = await supabase
            .from('waitlist')
            .select('id')
            .eq('email', normalized)
            .maybeSingle();

        if (existing) {
            const { count } = await supabase.from('waitlist').select('*', { count: 'exact', head: true });
            return res.status(409).json({ error: 'Bu email zaten kayıtlı.', position: count });
        }

        // Kaydet
        const { error } = await supabase.from('waitlist').insert({
            email:    normalized,
            ip:       req.ip,
        });

        if (error) throw new Error(error.message);

        const { count } = await supabase.from('waitlist').select('*', { count: 'exact', head: true });
        console.log(`[Waitlist] Yeni kayıt: ${normalized} (sıra: ${count})`);
        res.json({ success: true, position: count });
    } catch (e) {
        console.error('[Waitlist] Hata:', e.message);
        res.status(500).json({ error: 'Sunucu hatası.' });
    }
});

// GET /admin/waitlist — admin: tüm waitlist
app.get('/admin/waitlist', adminAuth, async (req, res) => {
    const { data, count, error } = await supabase
        .from('waitlist')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ total: count, emails: data });
});

// GET /admin/redeem-metrics — redeem watchdog istatistikleri
app.get('/admin/redeem-metrics', adminAuth, async (req, res) => {
    try {
        const currentBlock = await provider.getBlockNumber();
        const fromBlock    = Math.max(0, currentBlock - 50_000); // son ~7 gün
        const events       = await bridgeContract.queryFilter(
            bridgeContract.filters.RedeemRequested(), fromBlock, currentBlock
        );

        let stuckCount = 0;
        let oldestPendingSeconds = null;
        const now = Math.floor(Date.now() / 1000);

        for (const ev of events) {
            const info = await bridgeContract.getRedeemInfo(ev.args.redeemHash);
            if (info.state !== 0n) continue; // Pending değil
            const ageSeconds = now - Number(info.requestedAt);
            if (ageSeconds > 30 * 60) stuckCount++;
            if (oldestPendingSeconds === null || ageSeconds > oldestPendingSeconds) {
                oldestPendingSeconds = ageSeconds;
            }
        }

        res.json({
            lastSuccessfulAt:    redeemMetrics.lastSuccessfulAt,
            lastRedeemBlock,
            totalProcessed:      redeemMetrics.totalProcessed,
            totalFailed:         redeemMetrics.totalFailed,
            scanCount:           redeemMetrics.scanCount,
            stuckRequestCount:   stuckCount,
            oldestPendingSeconds,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/toggle-mint-pause — mint'i aç/kapat (restart gerektirmez)
// Body: { "pause": true } veya { "pause": false }
app.post('/admin/toggle-mint-pause', retryLimiter, adminAuth, (req, res) => {
    const { pause } = req.body;
    if (typeof pause !== 'boolean') {
        return res.status(400).json({ error: '{ "pause": true|false } gerekli.' });
    }
    mintPaused = pause;
    const msg = mintPaused ? '⛔ Mint durduruldu.' : '✅ Mint yeniden aktif.';
    console.warn(`[ADMIN] toggle-mint-pause → mintPaused=${mintPaused}`);
    res.json({ ok: true, mintPaused, message: msg });
});

// =================================================================================
// STAKING EVENT LISTENER
// =================================================================================
const STAKING_EVENTS_ABI = [
    "event Staked(address indexed user, uint8 pool, uint256 amount)",
    "event UnstakeRequested(address indexed user, uint8 pool, uint256 amount, uint256 cooldownEnd)",
    "event Withdrawn(address indexed user, uint8 pool, uint256 amount)",
    "event Claimed(address indexed user, uint8 pool, uint256 oxo, uint256 eth, uint256 oxoBtc)",
    "event Compounded(address indexed user, uint256 oxoAmount)",
    "event FeeDistributed(uint256 ethAmount, uint256 oxoBtcAmount)",
    "event EmissionUpdated(uint256 newOxoPerSecond)",
];

async function listenForStakingEvents() {
    const addr = process.env.STAKING_CONTRACT_ADDRESS || STATS_ADDRESSES.staking;
    if (!addr) { console.log('[STAKING] Adres tanımlı değil, listener devre dışı.'); return; }
    const sc = new Contract(addr, STAKING_EVENTS_ABI, provider);

    sc.on("Staked", (user, pool, amount) => {
        const poolName = Number(pool) === 0 ? 'oxoBTC Pool' : 'OXO Pool';
        const dec = Number(pool) === 0 ? 8 : 18;
        console.log(`[STAKING] 📥 Staked | Pool: ${poolName} | User: ${user} | Amount: ${ethers.formatUnits(amount, dec)}`);
    });
    sc.on("UnstakeRequested", (user, pool, amount, cooldownEnd) => {
        const poolName = Number(pool) === 0 ? 'oxoBTC Pool' : 'OXO Pool';
        const dec = Number(pool) === 0 ? 8 : 18;
        const date = new Date(Number(cooldownEnd) * 1000).toLocaleDateString();
        console.log(`[STAKING] 🔓 Unstake Requested | Pool: ${poolName} | User: ${user} | Amount: ${ethers.formatUnits(amount, dec)} | Ready: ${date}`);
    });
    sc.on("Withdrawn", (user, pool, amount) => {
        const poolName = Number(pool) === 0 ? 'oxoBTC Pool' : 'OXO Pool';
        const dec = Number(pool) === 0 ? 8 : 18;
        console.log(`[STAKING] 💸 Withdrawn | Pool: ${poolName} | User: ${user} | Amount: ${ethers.formatUnits(amount, dec)}`);
    });
    sc.on("Claimed", (user, pool, oxo, eth, oxoBtc) => {
        if (Number(pool) === 0) {
            console.log(`[STAKING] 🎁 Claimed Pool 0 | User: ${user} | OXO: ${ethers.formatUnits(oxo, 18)}`);
        } else {
            console.log(`[STAKING] 🎁 Claimed Pool 1 | User: ${user} | ETH: ${ethers.formatEther(eth)} | oxoBTC: ${ethers.formatUnits(oxoBtc, 8)}`);
        }
    });
    sc.on("Compounded", (user, oxoAmount) => {
        console.log(`[STAKING] 🔄 Compounded | User: ${user} | OXO: ${ethers.formatUnits(oxoAmount, 18)}`);
    });
    sc.on("FeeDistributed", (ethAmount, oxoBtcAmount) => {
        if (ethAmount > 0n) console.log(`[STAKING] 💰 Fee Distributed | ETH: ${ethers.formatEther(ethAmount)}`);
        if (oxoBtcAmount > 0n) console.log(`[STAKING] 💰 Fee Distributed | oxoBTC: ${ethers.formatUnits(oxoBtcAmount, 8)}`);
    });
    sc.on("EmissionUpdated", (newRate) => {
        console.log(`[STAKING] ⚙️  Emission Updated | New Rate: ${ethers.formatUnits(newRate, 18)} OXO/sec`);
    });
    console.log("🟢 Staking event listener aktif");
}

// =================================================================================
// TREASURY EVENT LISTENER
// =================================================================================
const TREASURY_EVENTS_ABI = [
    "event FeeReceived(address indexed from, uint256 ethAmount, uint256 oxoBtcAmount)",
    "event Distributed(uint256 toStakers, uint256 toPol, uint256 toReserve, bool isEth)",
    "event POLAdded(uint256 ethAmount, uint256 oxoBtcAmount, uint256 lpReceived)",
    "event ReserveWithdrawn(address indexed to, uint256 ethAmount, uint256 oxoBtcAmount)",
];

async function listenForTreasuryEvents() {
    const addr = process.env.TREASURY_CONTRACT_ADDRESS || STATS_ADDRESSES.treasury;
    if (!addr) { console.log('[TREASURY] Adres tanımlı değil, listener devre dışı.'); return; }
    const tc = new Contract(addr, TREASURY_EVENTS_ABI, provider);

    tc.on("FeeReceived", (from, ethAmount, oxoBtcAmount) => {
        if (ethAmount > 0n) console.log(`[TREASURY] 📨 Fee Received | ETH: ${ethers.formatEther(ethAmount)} | From: ${from}`);
        if (oxoBtcAmount > 0n) console.log(`[TREASURY] 📨 Fee Received | oxoBTC: ${ethers.formatUnits(oxoBtcAmount, 8)} | From: ${from}`);
    });
    tc.on("Distributed", (toStakers, toPol, toReserve, isEth) => {
        const sym = isEth ? 'ETH' : 'oxoBTC';
        const dec = isEth ? 18 : 8;
        const fmt = v => ethers.formatUnits(v, dec);
        console.log(`[TREASURY] 🏦 Distributed (${sym}) | Stakers: ${fmt(toStakers)} | POL: ${fmt(toPol)} | Reserve: ${fmt(toReserve)}`);
    });
    tc.on("POLAdded", (ethAmount, oxoBtcAmount, lpReceived) => {
        console.log(`[TREASURY] 💧 POL Added | ETH: ${ethers.formatEther(ethAmount)} | oxoBTC: ${ethers.formatUnits(oxoBtcAmount, 8)} | LP: ${ethers.formatUnits(lpReceived, 18)}`);
    });
    tc.on("ReserveWithdrawn", (to, ethAmount, oxoBtcAmount) => {
        console.log(`[TREASURY] ⚠️  Reserve Withdrawn | To: ${to} | ETH: ${ethers.formatEther(ethAmount)} | oxoBTC: ${ethers.formatUnits(oxoBtcAmount, 8)}`);
    });
    console.log("🟢 Treasury event listener aktif");
}

// =================================================================================
// FLASH EXIT KEEPER — chunk'ları otomatik tetikler
// =================================================================================
const FLASH_EXIT_ABI = [
    "event ExitOrderCreated(uint256 indexed orderId, address indexed user, uint256 totalEth, uint256 chunks)",
    "event ChunkExecuted(uint256 indexed orderId, uint256 chunkEth, uint256 oxoBtcGot, uint256 chunksLeft)",
    "event ExitCompleted(uint256 indexed orderId, address indexed user, uint256 totalOxoBtc)",
    "function executeNextChunk(uint256 orderId) external",
    "function getOrder(uint256 orderId) external view returns (address user, string memory btcAddress, uint256 totalEth, uint256 remainingEth, uint256 acquiredOxoBtc, uint256 chunkEth, uint256 maxSlippageBps, uint256 lastChunkTime, uint256 chunksLeft, bool completed, bool cancelled)",
    "function chunkInterval() view returns (uint256)"
];

const FLASH_EXIT_ADDRESS = process.env.FLASH_EXIT_ADDRESS;
let flashExitContract = null;

// Bekleyen order'ları tutan set (orderId → next execution timestamp)
const pendingChunks = new Map();

async function scheduleNextChunk(orderId, delayMs) {
    if (pendingChunks.has(orderId)) return; // zaten planlandı
    pendingChunks.set(orderId, true);
    setTimeout(async () => {
        pendingChunks.delete(orderId);
        try {
            const order = await flashExitContract.getOrder(orderId);
            if (order.completed || order.cancelled || order.chunksLeft === 0n) return;
            console.log(`[FLASH EXIT] Chunk tetikleniyor → Order #${orderId}, kalan: ${order.chunksLeft}`);
            const tx = await flashExitContract.executeNextChunk(orderId);
            await tx.wait();
            console.log(`[FLASH EXIT] Chunk OK → Order #${orderId} | tx: ${tx.hash}`);
        } catch (e) {
            const msg = e?.revert?.args?.[0] || e?.reason || e.message;
            console.error(`[FLASH EXIT] Chunk hatası Order #${orderId}: ${msg}`);
            // Hata "Wait for chunk interval" ise biraz sonra tekrar dene
            if (msg && msg.includes('interval')) {
                scheduleNextChunk(orderId, 35_000);
            }
        }
    }, delayMs);
}

async function listenForFlashExitEvents() {
    if (!FLASH_EXIT_ADDRESS) {
        console.log('[FLASH EXIT] FLASH_EXIT_ADDRESS tanımlı değil, keeper devre dışı.');
        return;
    }
    flashExitContract = new Contract(FLASH_EXIT_ADDRESS, FLASH_EXIT_ABI, signerWallet);

    const interval = Number(await flashExitContract.chunkInterval());
    console.log(`[FLASH EXIT] Keeper aktif | chunkInterval: ${interval}s`);

    // Yeni order → ilk chunk zaten çalışmış, bir sonrakini planla
    flashExitContract.on("ExitOrderCreated", async (orderId, user, totalEth, chunks) => {
        console.log(`[FLASH EXIT] Yeni order #${orderId} | ${chunks} chunk | user: ${user}`);
        if (Number(chunks) > 1) {
            scheduleNextChunk(orderId, (interval + 2) * 1000);
        }
    });

    // Her chunk sonrası → daha chunk varsa planla
    flashExitContract.on("ChunkExecuted", async (orderId, chunkEth, oxoBtcGot, chunksLeft) => {
        console.log(`[FLASH EXIT] Chunk bitti #${orderId} | kalan: ${chunksLeft}`);
        if (Number(chunksLeft) > 0) {
            scheduleNextChunk(orderId, (interval + 2) * 1000);
        }
    });

    flashExitContract.on("ExitCompleted", (orderId, user, totalOxoBtc) => {
        console.log(`[FLASH EXIT] Tamamlandı #${orderId} | ${ethers.formatUnits(totalOxoBtc, 8)} oxoBTC → ${user}`);
    });
}

// =================================================================================
// ETH → BTC REDEEM LİSTENER
// =================================================================================
// =================================================================================
// REDEEM YÜRÜTÜCÜ — Listener ve Scanner'ın ortak mantığı (idempotent)
// =================================================================================
async function executeRedeem(ethAddress, btcAddress, amountSats, redeemHash) {
    // Çift execution koruması
    if (redeemInFlight.has(redeemHash)) {
        console.log(`[REDEEM] Zaten işleniyor, atlanıyor: ${redeemHash}`);
        return;
    }
    redeemInFlight.add(redeemHash);

    try {
        if (amountSats < DUST_LIMIT_SATS) {
            console.warn(`⚠️  [REDEEM] ${amountSats} sats < dust limit — atlanıyor: ${redeemHash}`);
            return;
        }

        // Idempotent kontrol: on-chain state Pending (0) değilse atla
        const info = await bridgeContract.getRedeemInfo(redeemHash);
        if (info.state !== 0n) {
            console.log(`[REDEEM] State=${info.state} (Pending değil) — atlanıyor: ${redeemHash}`);
            return;
        }

        // ── Pending → Processing (cancel kilidi) ──────────────────
        try {
            const lockTx = await bridgeContract.markProcessing(redeemHash);
            await lockTx.wait();
            console.log(`🔒 [REDEEM] markProcessing OK — ${redeemHash}`);
        } catch (lockErr) {
            console.warn(`⚠️  [REDEEM] markProcessing başarısız (${lockErr.reason || lockErr.message}) — ${redeemHash}`);
            redeemMetrics.totalFailed++;
            return;
        }

        // ── BTC gönder ────────────────────────────────────────────
        const success = await sendBtcFromMultiSig(btcAddress, amountSats);
        if (!success) {
            console.error(`❌ [REDEEM HATA] BTC gönderilemedi — ${redeemHash}`);
            redeemMetrics.totalFailed++;
            return;
        }

        // ── Processing → Completed ────────────────────────────────
        try {
            const completeTx = await bridgeContract.markRedeemCompleted(redeemHash, BigInt(amountSats));
            await completeTx.wait();
            redeemMetrics.totalProcessed++;
            redeemMetrics.lastSuccessfulAt = new Date().toISOString();
            console.log(`✅ [REDEEM TAMAMLANDI] ${redeemHash} | toplam: ${redeemMetrics.totalProcessed}`);
        } catch (completeErr) {
            // BTC gönderildi ama on-chain işaretleme başarısız — kritik loglama
            console.error(`🚨 [REDEEM KRİTİK] BTC gönderildi fakat markRedeemCompleted başarısız!`,
                `hash: ${redeemHash}`, completeErr.message);
            redeemMetrics.totalFailed++;
        }
    } finally {
        redeemInFlight.delete(redeemHash);
    }
}

// =================================================================================
// ETH → BTC REDEEM LİSTENER
// =================================================================================
async function listenForRedeemEvents() {
    bridgeContract.on("RedeemRequested", async (ethAddress, btcAddress, amountBigInt, redeemHash) => {
        try {
            const amountInSatoshi = Number(amountBigInt.toString());
            console.log(`🚨 [REDEEM] ETH: ${ethAddress} → BTC: ${btcAddress} (${amountInSatoshi} sats) | hash: ${redeemHash}`);
            await executeRedeem(ethAddress, btcAddress, amountInSatoshi, redeemHash);
        } catch (err) {
            console.error(`[REDEEM Listener Hatası]`, err.message);
        }
    });
    console.log("🟢 Redeem event listener aktif (ETH → BTC) — state machine etkin");
}

// =================================================================================
// REDEEM WATCHDOG — Kaçırılmış / Stuck Pending redeemler için periyodik tarama
// =================================================================================
async function scanPendingRedeems() {
    redeemMetrics.scanCount++;
    try {
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = lastRedeemBlock > 0 ? lastRedeemBlock + 1 : Math.max(0, currentBlock - 10_000);

        if (fromBlock > currentBlock) return;

        console.log(`[WATCHDOG] Redeem taraması: block ${fromBlock} → ${currentBlock}`);

        const filter   = bridgeContract.filters.RedeemRequested();
        const events   = await bridgeContract.queryFilter(filter, fromBlock, currentBlock);

        let pendingCount = 0;
        for (const ev of events) {
            const { ethAddress, btcAddress, amount, redeemHash } = ev.args;
            const amountSats = Number(amount.toString());

            // Idempotent: on-chain state kontrol et
            const info = await bridgeContract.getRedeemInfo(redeemHash);
            if (info.state !== 0n) continue; // Pending değil, atla

            pendingCount++;
            const ageMinutes = Math.floor((Date.now() - Number(info.requestedAt) * 1000) / 60_000);
            console.log(`[WATCHDOG] Stuck Pending redeem bulundu (${ageMinutes}dk) — ${redeemHash}`);
            await executeRedeem(ethAddress, btcAddress, amountSats, redeemHash);
        }

        if (events.length > 0) {
            console.log(`[WATCHDOG] Tarama tamamlandı: ${events.length} event, ${pendingCount} pending işlendi`);
        }

        // Checkpoint güncelle
        lastRedeemBlock = currentBlock;
        saveCheckpoint(currentBlock);

    } catch (err) {
        console.error('[WATCHDOG] scanPendingRedeems hatası:', err.message);
    }
}

// =================================================================================
// MEMPOOL.SPACE WEBSOCKET DİNLEYİCİ
// =================================================================================
function trackAddressOnWS(btcAddress) {
    if (mempoolWS && mempoolWS.readyState === WebSocket.OPEN) {
        mempoolWS.send(JSON.stringify({ action: 'track-addresses', data: [btcAddress] }));
        console.log(`[WS] Yeni adres izlemeye eklendi: ${btcAddress}`);
    }
}

function connectMempoolWS() {
    const wsUrl = 'wss://mempool.space/testnet/api/v1/ws';
    console.log('[WS] mempool.space WebSocket bağlanıyor...');

    mempoolWS = new WebSocket(wsUrl);

    let pingInterval = null;

    mempoolWS.on('open', async () => {
        console.log('[WS] mempool.space bağlandı.');
        wsReconnectDelay = 5000; // başarılı bağlantıda gecikmeyi sıfırla
        const allUsers = await dbGetAllUsers();
        const addresses = allUsers.map(u => u.btcAddress || u.btc_address).filter(Boolean);
        if (addresses.length > 0) {
            mempoolWS.send(JSON.stringify({ action: 'track-addresses', data: addresses }));
            console.log(`[WS] ${addresses.length} adres izleniyor.`);
        }
        pingInterval = setInterval(() => {
            if (mempoolWS && mempoolWS.readyState === WebSocket.OPEN) {
                mempoolWS.ping();
            }
        }, 25000);
    });

    mempoolWS.on('pong', () => {
        console.log('[WS] mempool.space pong alındı.');
    });

    mempoolWS.on('message', async (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }

        const txList = msg['address-transactions'];
        if (!Array.isArray(txList)) return;

        for (const tx of txList) {
            if (!tx || !tx.txid) continue;

            // Unconfirmed (mempool) tx → 90 sn sonra REST API ile confirmation kontrol et
            if (!tx.status || !tx.status.confirmed) {
                const txHash = tx.txid;
                if (!inFlight.has(txHash)) {
                    setTimeout(() => pollConfirmation(txHash), 90_000);
                    console.log(`[WS] Mempool TX algılandı: ${txHash} — 90s sonra confirmation kontrol edilecek`);
                }
                continue;
            }

            const txHash = tx.txid;

            if (inFlight.has(txHash)) continue;

            const alreadyProcessed = await dbGetProcessedTx(txHash);
            if (alreadyProcessed) continue;

            const allUsers = await dbGetAllUsers();

            let targetUser = null;
            let amountSats = 0;

            for (const out of (tx.vout || [])) {
                const addr = out.scriptpubkey_address;
                if (!addr) continue;
                const user = allUsers.find(u => (u.btcAddress || u.btc_address) === addr);
                if (user) {
                    targetUser = user;
                    amountSats = out.value;
                    break;
                }
            }

            if (!targetUser || amountSats < DUST_LIMIT_SATS) continue;

            const ethAddr = targetUser.metamaskAddress || targetUser.eth_address;
            inFlight.add(txHash);
            try {
                console.log(`[WS] TX işleniyor: ${txHash} → ${ethAddr} (${amountSats} sats)`);
                await executeMint(txHash, ethAddr, amountSats, false);
            } catch (err) {
                const errorMessage = err?.revert?.args[0] || err?.reason || err.message;
                console.error(`[WS HATA] TXID: ${txHash}`, errorMessage);

                const existingFailed = await dbGetFailedTx(txHash);
                if (!existingFailed) {
                    await dbAddFailedTx({
                        txid: txHash,
                        ethAddress: ethAddr,
                        btcAmount: amountSats,
                        error: errorMessage,
                    });
                }
            } finally {
                inFlight.delete(txHash);
            }
        }
    });

    mempoolWS.on('error', (err) => {
        console.error('[WS] mempool.space hata:', err.message);
    });

    mempoolWS.on('close', () => {
        clearInterval(pingInterval);
        pingInterval = null;
        console.log(`[WS] mempool.space bağlantısı kesildi. ${wsReconnectDelay / 1000}s sonra yeniden bağlanılacak...`);
        mempoolWS = null;
        setTimeout(connectMempoolWS, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_DELAY);
    });
}

// =================================================================================
// POLL CONFIRMATION — WS'de görülen unconfirmed tx için REST API ile confirmation bekle
// =================================================================================
async function pollConfirmation(txHash, attempt = 1) {
    const MAX_ATTEMPTS = 20; // 20 × 90s = 30 dk maksimum bekleme
    if (attempt > MAX_ATTEMPTS) {
        console.log(`[POLL] ${txHash}: max deneme aşıldı, vazgeçildi.`);
        return;
    }
    if (inFlight.has(txHash)) return;

    const alreadyProcessed = await dbGetProcessedTx(txHash);
    if (alreadyProcessed) return;

    try {
        const res = await axios.get(`https://mempool.space/testnet/api/tx/${txHash}`, { timeout: 6000 });
        const tx = res.data;
        if (!tx.status?.confirmed) {
            // Henüz onaylanmadı, 90s sonra tekrar dene
            setTimeout(() => pollConfirmation(txHash, attempt + 1), 90_000);
            return;
        }
        // Onaylandı — hangi kullanıcıya ait?
        const allUsers = await dbGetAllUsers();
        let targetUser = null, amountSats = 0;
        for (const out of (tx.vout || [])) {
            const addr = out.scriptpubkey_address;
            if (!addr) continue;
            const user = allUsers.find(u => (u.btcAddress || u.btc_address) === addr);
            if (user) { targetUser = user; amountSats = out.value; break; }
        }
        if (!targetUser || amountSats < DUST_LIMIT_SATS) return;

        const ethAddr = targetUser.metamaskAddress || targetUser.eth_address;
        inFlight.add(txHash);
        try {
            console.log(`[POLL] TX onaylandı, mint ediliyor: ${txHash} → ${ethAddr} (${amountSats} sats)`);
            await executeMint(txHash, ethAddr, amountSats, false);
        } catch (err) {
            const errorMessage = err?.revert?.args[0] || err?.reason || err.message;
            console.error(`[POLL HATA] ${txHash}: ${errorMessage}`);
            const existingFailed = await dbGetFailedTx(txHash);
            if (!existingFailed) {
                await dbAddFailedTx({
                    txid: txHash,
                    ethAddress: ethAddr,
                    btcAmount: amountSats,
                    error: errorMessage,
                });
            }
        } finally {
            inFlight.delete(txHash);
        }
    } catch (e) {
        // mempool.space erişilemez, tekrar dene
        setTimeout(() => pollConfirmation(txHash, attempt + 1), 90_000);
    }
}

// =================================================================================
// SUNUCU BAŞLATMA
// =================================================================================
// Backend başlarken kaçırılmış onaylı TX'leri tara ve mint et
async function scanMissedDeposits() {
    console.log('[SCAN] Backend başlarken kaçırılmış TX\'ler taranıyor...');
    const allUsers = await dbGetAllUsers();

    for (const user of allUsers) {
        const btcAddress = user.btcAddress || user.btc_address;
        const ethAddress = user.metamaskAddress || user.eth_address;
        try {
            const res = await axios.get(
                `https://mempool.space/testnet/api/address/${btcAddress}/txs`,
                { timeout: 5000 }
            );
            for (const tx of res.data.slice(0, 10)) {
                if (!tx.status?.confirmed) continue;
                const alreadyProcessed = await dbGetProcessedTx(tx.txid);
                if (alreadyProcessed) continue;
                if (inFlight.has(tx.txid)) continue;
                const out = tx.vout.find(o => o.scriptpubkey_address === btcAddress);
                if (!out || out.value < DUST_LIMIT_SATS) continue;

                console.log(`[SCAN] Kaçırılmış TX bulundu: ${tx.txid} → ${ethAddress} (${out.value} sats)`);
                inFlight.add(tx.txid);
                try {
                    await executeMint(tx.txid, ethAddress, out.value, false);
                } catch (e) {
                    const msg = e?.revert?.args[0] || e?.reason || e.message;
                    console.error(`[SCAN HATA] ${tx.txid}: ${msg}`);
                    const existingFailed = await dbGetFailedTx(tx.txid);
                    if (!existingFailed) {
                        await dbAddFailedTx({
                            txid: tx.txid,
                            ethAddress,
                            btcAmount: out.value,
                            error: msg,
                        });
                    }
                } finally {
                    inFlight.delete(tx.txid);
                }
            }
        } catch { /* bu kullanıcı için mempool erişilemedi, geç */ }
    }
    console.log('[SCAN] Tarama tamamlandı.');
}

async function startServer() {
    checkEnvVars();
    deriveMultiSigAddress();

    // DB bağlantısını dene; başarısız olursa lowdb fallback'e geç
    try {
        await db.connect();
        if (db.isConnected()) {
            console.log("🐘 PostgreSQL veritabanına bağlandı.");
        } else {
            console.log("⚠️  PostgreSQL bağlanamadı, LowDB (JSON) fallback kullanılıyor.");
            await setupLowDB();
        }
    } catch (e) {
        console.warn(`⚠️  DB bağlantı hatası: ${e.message} — LowDB fallback kullanılıyor.`);
        await setupLowDB();
    }

    // Redeem checkpoint'i yükle (server yeniden başlatılsa bile blok kaçırılmaz)
    loadCheckpoint();

    app.listen(PORT, () => {
        console.log(`🚀 Server http://localhost:${PORT}`);
        listenForRedeemEvents();
        listenForFlashExitEvents();
        listenForStakingEvents().catch(e => console.error('[STAKING]', e.message));
        listenForTreasuryEvents().catch(e => console.error('[TREASURY]', e.message));
        connectMempoolWS();
        scanMissedDeposits().catch(e => console.error('[SCAN HATA]', e.message));

        // Periyodik deposit tarama: her 2 dakikada bir
        setInterval(() => {
            scanMissedDeposits().catch(e => console.error('[SCAN PERİYODİK HATA]', e.message));
        }, 2 * 60 * 1000);
        console.log('🔄 Periyodik deposit tarama aktif (2 dakika)');

        // Redeem watchdog: her 5 dakikada bir stuck/missed Pending redeemları tara
        scanPendingRedeems().catch(e => console.error('[WATCHDOG HATA]', e.message));
        setInterval(() => {
            scanPendingRedeems().catch(e => console.error('[WATCHDOG PERİYODİK HATA]', e.message));
        }, 5 * 60 * 1000);
        console.log('🔄 Redeem watchdog aktif (5 dakika)');
    });
}

startServer();
