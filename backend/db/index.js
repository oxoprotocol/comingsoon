'use strict';
// DB abstraction — PostgreSQL (production) veya JSON fallback (dev)

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool = null;

// ── Bağlantı ──────────────────────────────────────────────────────────────────
async function connect() {
    if (!process.env.DATABASE_URL) {
        console.warn('⚠️  DATABASE_URL tanımlı değil — JSON fallback kullanılıyor (dev modu)');
        return false;
    }
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, // Neon/Supabase için
        max: 20,           // pool büyüklüğü
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });
    // Schema kur
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('✅ PostgreSQL bağlandı, schema hazır.');
    return true;
}

function isConnected() { return pool !== null; }

// ── USERS ─────────────────────────────────────────────────────────────────────
async function getUser(ethAddress) {
    if (!pool) return null;
    const { rows } = await pool.query(
        'SELECT * FROM users WHERE eth_address = $1', [ethAddress.toLowerCase()]
    );
    return rows[0] || null;
}

async function getUserByBtc(btcAddress) {
    if (!pool) return null;
    const { rows } = await pool.query(
        'SELECT * FROM users WHERE btc_address = $1', [btcAddress]
    );
    return rows[0] || null;
}

async function createUser(ethAddress, btcAddress) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `INSERT INTO users (eth_address, btc_address)
         VALUES ($1, $2)
         ON CONFLICT (eth_address) DO UPDATE SET btc_address = EXCLUDED.btc_address
         RETURNING *`,
        [ethAddress.toLowerCase(), btcAddress]
    );
    return rows[0];
}

// ── PROCESSED TXS ─────────────────────────────────────────────────────────────
async function getProcessedTx(txid) {
    if (!pool) return null;
    const { rows } = await pool.query(
        'SELECT * FROM processed_txs WHERE txid = $1', [txid]
    );
    return rows[0] || null;
}

async function addProcessedTx({ txid, ethAddress, btcAmount, ethTxHash }) {
    if (!pool) return null;
    const { rows } = await pool.query(
        `INSERT INTO processed_txs (txid, eth_address, btc_amount, eth_tx_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (txid) DO NOTHING
         RETURNING *`,
        [txid, ethAddress.toLowerCase(), btcAmount, ethTxHash]
    );
    return rows[0];
}

async function getRecentMints(ethAddress, hours = 2) {
    if (!pool) return [];
    const { rows } = await pool.query(
        `SELECT * FROM processed_txs
         WHERE eth_address = $1
           AND created_at > NOW() - INTERVAL '${hours} hours'
         ORDER BY created_at DESC
         LIMIT 5`,
        [ethAddress.toLowerCase()]
    );
    return rows;
}

async function getAllProcessedTxids() {
    if (!pool) return new Set();
    const { rows } = await pool.query('SELECT txid FROM processed_txs');
    return new Set(rows.map(r => r.txid));
}

// ── FAILED TXS ────────────────────────────────────────────────────────────────
async function getFailedTx(txid) {
    if (!pool) return null;
    const { rows } = await pool.query(
        'SELECT * FROM failed_txs WHERE txid = $1', [txid]
    );
    return rows[0] || null;
}

async function addFailedTx({ txid, ethAddress, btcAmount, error }) {
    if (!pool) return null;
    await pool.query(
        `INSERT INTO failed_txs (txid, eth_address, btc_amount, error)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (txid) DO NOTHING`,
        [txid, ethAddress || null, btcAmount || null, error]
    );
}

async function getUnretriedFailed() {
    if (!pool) return [];
    const { rows } = await pool.query(
        'SELECT * FROM failed_txs WHERE retried = FALSE ORDER BY created_at'
    );
    return rows;
}

async function markRetried(txid) {
    if (!pool) return;
    await pool.query('UPDATE failed_txs SET retried = TRUE WHERE txid = $1', [txid]);
}

async function getAllUsers() {
    if (!pool) return [];
    const { rows } = await pool.query('SELECT * FROM users');
    return rows;
}

module.exports = {
    connect, isConnected,
    getUser, getUserByBtc, createUser, getAllUsers,
    getProcessedTx, addProcessedTx, getRecentMints, getAllProcessedTxids,
    getFailedTx, addFailedTx, getUnretriedFailed, markRetried,
};
