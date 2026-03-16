// JSON dosyalarından PostgreSQL'e tek seferlik migrasyon
// Kullanım: node db/migrate-json-to-pg.js

require('dotenv').config({ path: '../.env' });
const fs   = require('fs');
const path = require('path');
const db   = require('./index');

async function migrate() {
    console.log('🚀 JSON → PostgreSQL migrasyonu başlıyor...');

    const connected = await db.connect();
    if (!connected) {
        console.error('❌ DATABASE_URL tanımlı değil. .env dosyasına ekle.');
        process.exit(1);
    }

    // USERS
    const usersFile = path.join(__dirname, '../users.json');
    if (fs.existsSync(usersFile)) {
        const { users } = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        console.log(`📦 ${users.length} kullanıcı migrate ediliyor...`);
        for (const u of users) {
            try {
                await db.createUser(u.metamaskAddress, u.btcAddress);
            } catch (e) { console.warn('  Skip:', u.metamaskAddress, e.message); }
        }
        console.log('✅ Users OK');
    }

    // PROCESSED TXS
    const ptFile = path.join(__dirname, '../processed_txs.json');
    if (fs.existsSync(ptFile)) {
        const { processedTXs } = JSON.parse(fs.readFileSync(ptFile, 'utf8'));
        console.log(`📦 ${processedTXs.length} işlenmiş TX migrate ediliyor...`);
        for (const tx of processedTXs) {
            try {
                await db.addProcessedTx({
                    txid       : tx.txid,
                    ethAddress : tx.ethAddress,
                    btcAmount  : tx.btcAmount,
                    ethTxHash  : tx.ethTxHash,
                });
            } catch (e) { console.warn('  Skip TX:', tx.txid, e.message); }
        }
        console.log('✅ Processed TXs OK');
    }

    // FAILED TXS
    const ftFile = path.join(__dirname, '../failed_txs.json');
    if (fs.existsSync(ftFile)) {
        const { failedTXs } = JSON.parse(fs.readFileSync(ftFile, 'utf8'));
        console.log(`📦 ${failedTXs.length} başarısız TX migrate ediliyor...`);
        for (const tx of failedTXs) {
            try {
                await db.addFailedTx({
                    txid       : tx.txid,
                    ethAddress : tx.ethAddress,
                    btcAmount  : tx.btcAmount,
                    error      : tx.error,
                });
            } catch (e) { console.warn('  Skip failed TX:', tx.txid, e.message); }
        }
        console.log('✅ Failed TXs OK');
    }

    console.log('\n🎉 Migrasyon tamamlandı!');
    process.exit(0);
}

migrate().catch(e => { console.error(e); process.exit(1); });
