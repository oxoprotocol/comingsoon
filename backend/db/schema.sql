-- OXO Protocol — PostgreSQL Schema
-- Neon, Supabase veya herhangi bir PostgreSQL'de çalışır

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    eth_address     VARCHAR(42) NOT NULL UNIQUE,
    btc_address     VARCHAR(64) NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_txs (
    id              SERIAL PRIMARY KEY,
    txid            VARCHAR(64) NOT NULL UNIQUE,
    eth_address     VARCHAR(42) NOT NULL,
    btc_amount      BIGINT NOT NULL,          -- satoshi
    eth_tx_hash     VARCHAR(66),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS failed_txs (
    id              SERIAL PRIMARY KEY,
    txid            VARCHAR(64) NOT NULL UNIQUE,
    eth_address     VARCHAR(42),
    btc_amount      BIGINT,
    error           TEXT,
    retried         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- İndeksler
CREATE INDEX IF NOT EXISTS idx_users_eth         ON users(eth_address);
CREATE INDEX IF NOT EXISTS idx_users_btc         ON users(btc_address);
CREATE INDEX IF NOT EXISTS idx_processed_eth     ON processed_txs(eth_address);
CREATE INDEX IF NOT EXISTS idx_processed_created ON processed_txs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_retried    ON failed_txs(retried);
