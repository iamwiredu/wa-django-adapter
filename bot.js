const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// ----------------------------
// Config
// ----------------------------
const DJANGO_BASE_URL = process.env.DJANGO_BASE_URL || "https://www.grabtexts.shop";
const DJANGO_CHAT_PATH = process.env.DJANGO_CHAT_PATH || "/api/chat/incoming/";
const DJANGO_CHAT_URL = `${DJANGO_BASE_URL.replace(/\/$/, "")}${DJANGO_CHAT_PATH}`;
const DJANGO_AUTH_TOKEN = process.env.DJANGO_AUTH_TOKEN || null;

const PORT = process.env.PORT || 3000;

// ----------------------------
// Express starts IMMEDIATELY (Render needs an open port)
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json());

let WA_READY = false;
let LAST_QR_DATAURL = null;

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp adapter running ✅. Visit /qr to scan.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, whatsapp_ready: WA_READY, django_chat_url: DJANGO_CHAT_URL });
});

// View QR in browser (best for Render)
app.get("/qr", (req, res) => {
  if (WA_READY) return res.send("✅ WhatsApp connected. No QR needed.");
  if (!LAST_QR_DATAURL) return res.status(404).send("❌ No QR yet. Wait or check logs.");
  res.send(`
    <html>
      <body style="font-family:Arial;padding:20px">
        <h2>Scan WhatsApp QR</h2>
        <p>WhatsApp → Linked devices → Link a device</p>
        <img src="${LAST_QR_DATAURL}" style="width:320px;height:320px" />
        <p>Refresh if it expires.</p>
      </body>
    </html>
  `);
});

// IMPORTANT: bind 0.0.0.0 for Render
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 Express running on :${PORT}`);
  console.log(`➡️ Django chat URL: ${DJANGO_CHAT_URL}`);
});

// ----------------------------
// WhatsApp client - FIXED FOR RENDER
// ----------------------------
const puppeteerOptions = {
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=site-per-process'
  ],
  headless: true,
  ignoreHTTPSErrors: true,
  executablePath: process.env.CHROME_BIN || '/usr/bin/chromium-browser'
};
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth" // Ensure persistent auth storage
  }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: "remote", // Use remote WebWhatsApp version
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html"
  }
});

client.on("loading_screen", (percent, message) => {
  console.log(`🔄 Loading WhatsApp: ${percent}% - ${message}`);
});

client.on("qr", async (qr) => {
  console.log("📲 QR RECEIVED (also at /qr)");
  qrcodeTerminal.generate(qr, { small: true });

  // Generate QR image for /qr route
  try {
    LAST_QR_DATAURL = await QRCode.toDataURL(qr);
  } catch (e) {
    console.error("❌ Failed to generate QR image:", e.message || e);
  }
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated");
  console.log("💾 Auth saved to ./.wwebjs_auth/");
});

client.on("auth_failure", (m) => console.error("❌ Auth failure:", m));

client.on("ready", () => {
  WA_READY = true;
  LAST_QR_DATAURL = null;
  console.log("✅ WhatsApp client ready!");
  console.log("📱 Connected to WhatsApp successfully!");
});

// ----------------------------
// Handle cleanup on exit
// ----------------------------
process.on("SIGINT", async () => {
  console.log("🛑 Shutting down gracefully...");
  await client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🛑 Received SIGTERM, shutting down...");
  await client.destroy();
  process.exit(0);
});

// ----------------------------
// Helpers
// ----------------------------
function isGroupChat(from) {
  return typeof from === "string" && from.endsWith("@g.us");
}

function extractExternalIdFromMsg(msg) {
  const raw = String(msg.from || "");
  const left = raw.split("@")[0] || "";
  return left.replace(/\D/g, "");
}

function getProviderMessageId(msg) {
  if (msg?.id?._serialized) return msg.id._serialized;
  if (msg?.id?.id) return msg.id.id;
  return null;
}

async function forwardToDjango({ external_id, text, provider_message_id, raw }) {
  const headers = {};
  if (DJANGO_AUTH_TOKEN) headers["Authorization"] = `Bearer ${DJANGO_AUTH_TOKEN}`;

  const payload = { external_id, text, provider_message_id, raw };
  try {
    const resp = await axios.post(DJANGO_CHAT_URL, payload, { headers, timeout: 15000 });
    return resp.data.reply_text || resp.data.reply || "";
  } catch (error) {
    console.error("❌ Django API error:", error.response?.data || error.message);
    return "⚠️ Service temporarily unavailable. Please try again later.";
  }
}

// ----------------------------
// Inbound WhatsApp → Django → Reply
// ----------------------------
client.on("message", async (msg) => {
  try {
    if (!WA_READY) return;
    if (isGroupChat(msg.from)) return;
    
    // Ignore system messages
    if (msg.type === 'chat' || msg.type === 'image_caption' || msg.type === 'video') {
      const external_id = extractExternalIdFromMsg(msg);
      const provider_message_id = getProviderMessageId(msg);
      const text = (msg.body || "").trim();
      
      if (!external_id || !text) return;

      const raw = {
        from: msg.from,
        timestamp: msg.timestamp,
        hasMedia: !!msg.hasMedia,
        type: msg.type,
        mediaKey: msg.mediaKey,
      };

      console.log(`📥 Incoming from ${external_id}: ${text.substring(0, 50)}...`);
      
      const replyText = await forwardToDjango({ external_id, text, provider_message_id, raw });
      const finalReply = replyText?.trim() ? replyText : "⚠️ Sorry — I couldn't process that.";

      await client.sendMessage(msg.from, finalReply);
      console.log(`📤 Replied to ${external_id}`);
    }
  } catch (err) {
    console.error("❌ Inbound error:", err?.response?.data || err.message || err);
    try {
      await client.sendMessage(msg.from, "⚠️ System busy. Try again.");
    } catch (sendErr) {
      console.error("❌ Failed to send error message:", sendErr.message);
    }
  }
});

// Initialize with error handling
async function initializeWhatsApp() {
  try {
    console.log("🔄 Initializing WhatsApp Web...");
    await client.initialize();
  } catch (error) {
    console.error("❌ Failed to initialize WhatsApp:", error.message);
    console.log("💡 If this is a Chromium issue, try rebuilding with puppeteer dependencies");
    process.exit(1);
  }
}

initializeWhatsApp();