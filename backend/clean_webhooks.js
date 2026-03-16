// scripts/clean_webhooks.js
// BlockCypher'daki duplicate ve hatalı webhook'ları temizler

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

const TOKEN = process.env.BLOCKCYPHER_TOKEN;
const NGROK_URL = process.env.NGROK_PUBLIC_URL;
const BASE_URL = `https://api.blockcypher.com/v1/btc/test3/hooks`;

async function main() {
    console.log("Mevcut webhook'lar getiriliyor...");
    const res = await axios.get(`${BASE_URL}?token=${TOKEN}`);
    const hooks = res.data || [];
    console.log(`Toplam ${hooks.length} webhook bulundu.`);

    // Her adres için en iyi (callback_errors=0) webhook'u tut, gerisini sil
    const seen = new Map(); // address -> hook
    const toDelete = [];

    for (const hook of hooks) {
        const key = hook.address;
        if (!seen.has(key)) {
            // İlk kez görüyoruz — hata varsa sil, yoksa tut
            if (hook.callback_errors > 0) {
                toDelete.push(hook.id);
            } else {
                seen.set(key, hook.id);
            }
        } else {
            // Duplicate — sil
            toDelete.push(hook.id);
        }
    }

    console.log(`Silinecek ${toDelete.length} webhook var...`);

    for (const id of toDelete) {
        try {
            await axios.delete(`${BASE_URL}/${id}?token=${TOKEN}`);
            console.log(`🗑️  Silindi: ${id}`);
            await new Promise(r => setTimeout(r, 200)); // rate limit için bekle
        } catch (err) {
            console.error(`❌ Silinemedi ${id}:`, err.message);
        }
    }

    // Kalan webhook'ları göster
    const remaining = await axios.get(`${BASE_URL}?token=${TOKEN}`);
    console.log(`\n✅ Temizlik tamamlandı. Kalan webhook sayısı: ${remaining.data.length}`);
    remaining.data.forEach(h => {
        console.log(`  ${h.address} → errors: ${h.callback_errors}`);
    });
}

main().catch(console.error);
