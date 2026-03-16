/**
 * Telegram <-> Claude Code köprüsü
 * Mesaj gelince anında `claude -p` ile cevap üretir.
 */

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OUTBOX = path.join(__dirname, "telegram_outbox.json");
const PROJECT_DIR = path.resolve(__dirname);

if (!TOKEN || !ALLOWED_CHAT_ID) {
  console.error("TELEGRAM_TOKEN ve TELEGRAM_CHAT_ID gerekli!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
if (!fs.existsSync(OUTBOX)) fs.writeFileSync(OUTBOX, "[]");

const SYSTEM = `Sen OXO Protocol projesinin asistanısın. Kullanıcı seninle Telegram üzerinden konuşuyor ve bilgisayarını uzaktan yönetiyor.
Proje: Bitcoin'i yield üreten varlığa dönüştüren DeFi protokolü. Sepolia testnet'te canlı. 100/100 test geçiyor.
Kısa ve net cevaplar ver. Türkçe konuş. Emoji kullanma.`;

function askClaude(message) {
  return new Promise((resolve) => {
    const prompt = `${SYSTEM}\n\nKullanıcı mesajı: ${message}`;
    execFile("claude", ["-p", prompt], { timeout: 30000, maxBuffer: 1024 * 512 }, (err, stdout) => {
      if (err) resolve(`Hata: ${err.message.slice(0, 200)}`);
      else resolve((stdout || "").trim());
    });
  });
}

function sendToTelegram(text) {
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    bot.sendMessage(ALLOWED_CHAT_ID, text.slice(i, i + MAX)).catch(console.error);
  }
}

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId !== String(ALLOWED_CHAT_ID)) return;

  const text = (msg.text || "").trim();
  if (!text || text === "/start") return;

  console.log(`📥 ${text}`);
  bot.sendChatAction(ALLOWED_CHAT_ID, "typing");

  const reply = await askClaude(text);
  console.log(`📤 ${reply.slice(0, 80)}...`);
  sendToTelegram(reply);
});

bot.getMe().then((me) => {
  console.log(`✅ Köprü başladı: @${me.username}`);
  bot.sendMessage(ALLOWED_CHAT_ID, "Sistem hazir. Mesaj yazabilirsin.");
});
