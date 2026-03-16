/**
 * OXO Protocol - Telegram Remote Control Bot
 * Normal mesajlar → Claude AI
 * /run, /test, /backend, /status → Shell komutları
 */

const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { exec, spawn } = require("child_process");
const path = require("path");

// ─── AYARLAR ────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PROJECT_DIR = path.resolve(__dirname);
// ─────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !ALLOWED_CHAT_ID) {
  console.error("❌ TELEGRAM_TOKEN ve TELEGRAM_CHAT_ID gerekli!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Konuşma geçmişi
const chatHistory = [];

// Çalışan process'ler
const processes = {};

function send(chatId, text) {
  const MAX = 4000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  return chunks.reduce((p, chunk) => p.then(() =>
    bot.sendMessage(chatId, chunk).catch(() => bot.sendMessage(chatId, chunk.replace(/[`*_[\]()~>#+=|{}.!-]/g, "\\$&")))
  ), Promise.resolve());
}

function sendCode(chatId, text) {
  return send(chatId, "```\n" + text.slice(0, 3800) + "\n```");
}

function runCommand(cmd, cwd = PROJECT_DIR) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 120000, maxBuffer: 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr || "");
      resolve({ ok: !err, output: out.trim() || (err ? err.message : "Çıktı yok") });
    });
  });
}

async function askClaude(userMessage) {
  if (!anthropic) {
    return "Claude API anahtarı yok. ANTHROPIC_API_KEY ortam değişkenini ayarla.";
  }

  chatHistory.push({ role: "user", content: userMessage });

  // Son 20 mesajı tut
  if (chatHistory.length > 20) chatHistory.splice(0, chatHistory.length - 20);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `Sen OXO Protocol projesinin asistanısın. Kullanıcı seninle Telegram üzerinden konuşuyor.
Proje: Bitcoin'i yield üreten varlığa dönüştüren DeFi protokolü. Sepolia testnet'te canlı.
Kısa ve net cevaplar ver. Türkçe konuş.`,
      messages: chatHistory,
    });

    const reply = response.content[0].text;
    chatHistory.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    return `Claude API hatası: ${err.message}`;
  }
}

// ─── MESAJ İŞLEYİCİ ─────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  if (chatId !== String(ALLOWED_CHAT_ID)) {
    bot.sendMessage(msg.chat.id, "⛔ Yetkisiz erişim.");
    return;
  }

  const text = (msg.text || "").trim();
  console.log(`[${new Date().toISOString()}] ${text}`);

  // ── Shell komutları ──
  if (text === "/help" || text === "/start") {
    send(chatId, `OXO Remote Bot 🤖

Normal mesaj yaz → Claude AI cevaplar
/run <komut> → Shell komutu çalıştır
/test → Hardhat testleri
/backend → Backend başlat
/stopbackend → Backend durdur
/frontend → Frontend başlat
/stopfrontend → Frontend durdur
/status → Servis durumları
/clear → Konuşma geçmişini temizle`);
    return;
  }

  if (text === "/clear") {
    chatHistory.length = 0;
    send(chatId, "🧹 Konuşma geçmişi temizlendi.");
    return;
  }

  if (text === "/status") {
    send(chatId, `Bot: ✅ Çalışıyor\nBackend: ${processes.backend ? "✅ Açık" : "❌ Kapalı"}\nFrontend: ${processes.frontend ? "✅ Açık" : "❌ Kapalı"}\nClaude API: ${anthropic ? "✅ Bağlı" : "❌ API key yok"}`);
    return;
  }

  if (text === "/test") {
    send(chatId, "⏳ Testler çalışıyor...");
    const result = await runCommand("npx hardhat test 2>&1");
    sendCode(chatId, result.output.slice(-3500));
    return;
  }

  if (text === "/backend") {
    if (processes.backend) { send(chatId, "Backend zaten çalışıyor."); return; }
    const proc = spawn("node", ["server.js"], { cwd: path.join(PROJECT_DIR, "backend") });
    processes.backend = proc;
    proc.on("exit", (code) => { delete processes.backend; send(chatId, `Backend kapandı (kod: ${code})`); });
    setTimeout(() => send(chatId, `✅ Backend başladı (PID: ${proc.pid})`), 2000);
    return;
  }

  if (text === "/stopbackend") {
    if (!processes.backend) { send(chatId, "Backend zaten kapalı."); return; }
    processes.backend.kill(); delete processes.backend;
    send(chatId, "✅ Backend durduruldu.");
    return;
  }

  if (text === "/frontend") {
    if (processes.frontend) { send(chatId, "Frontend zaten çalışıyor."); return; }
    const proc = spawn("npx", ["serve", "-l", "8080", "."], { cwd: path.join(PROJECT_DIR, "frontend"), shell: true });
    processes.frontend = proc;
    proc.on("exit", (code) => { delete processes.frontend; send(chatId, `Frontend kapandı (kod: ${code})`); });
    setTimeout(() => send(chatId, `✅ Frontend başladı → http://localhost:8080`), 2000);
    return;
  }

  if (text === "/stopfrontend") {
    if (!processes.frontend) { send(chatId, "Frontend zaten kapalı."); return; }
    processes.frontend.kill(); delete processes.frontend;
    send(chatId, "✅ Frontend durduruldu.");
    return;
  }

  if (text.startsWith("/run ")) {
    const cmd = text.slice(5).trim();
    const blocked = ["rm -rf /", "format", "shutdown", "reboot"];
    if (blocked.some((b) => cmd.toLowerCase().includes(b))) { send(chatId, "⛔ Engellendi."); return; }
    send(chatId, `⏳ ${cmd}`);
    const result = await runCommand(cmd);
    sendCode(chatId, (result.ok ? "✅ " : "❌ ") + result.output);
    return;
  }

  // ── Normal mesaj → Claude ──
  bot.sendChatAction(chatId, "typing");
  const reply = await askClaude(text);
  send(chatId, reply);
});

// Başlat
bot.getMe().then((me) => {
  console.log(`✅ Bot başladı: @${me.username}`);
  bot.sendMessage(ALLOWED_CHAT_ID, `🟢 Bot yeniden başladı!\nArtık normal mesaj yazarsan Claude cevaplar.\nKomutlar için /help`);
}).catch((err) => { console.error(err.message); process.exit(1); });

process.on("SIGINT", () => {
  Object.values(processes).forEach((p) => p.kill());
  bot.sendMessage(ALLOWED_CHAT_ID, "🔴 Bot kapatıldı.").finally(() => process.exit(0));
});
