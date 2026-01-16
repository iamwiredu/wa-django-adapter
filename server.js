// server.js (updated)
// WhatsApp Web (whatsapp-web.js) -> Django forwarder with Render-friendly Express + QR page + persistent auth
// Adds: Chrome profile dir + Singleton lock cleanup + initialize() retry + safer startup logging + chat.sendMessage replies

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const fs = require("fs");

// ----------------------------
// Config
// ----------------------------
const DJANGO_BASE_URL = process.env.DJANGO_BASE_URL || "https://www.grabtexts.shop";
const DJANGO_CHAT_PATH = process.env.DJANGO_CHAT_PATH || "/api/chat/incoming/";
const DJANGO_CHAT_URL = `${DJANGO_BASE_URL.replace(/\/$/, "")}${DJANGO_CHAT_PATH}`;
const DJANGO_AUTH_TOKEN = process.env.DJANGO_AUTH_TOKEN || null;

const PORT = process.env.PORT || 3000;

// ----------------------------
// Express server (START IMMEDIATELY for Render)
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json());

let WA_READY = false;
let LAST_QR_DATAURL = null;

// ----------------------------
// Auth path (Render disk recommended)
// ----------------------------
let AUTH_PATH = process.env.WWEBJS_AUTH_PATH || "/var/data/.wwebjs_auth";

function ensureWritableDir(path) {
  try {
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(`${path}/.write_test`, "ok");
    fs.unlinkSync(`${path}/.write_test`);
    console.log("✅ Auth path writable:", path);
    return true;
  } catch (e) {
    console.error("❌ Auth path NOT writable:", path, e.message || e);
    return false;
  }
}

// If /var/data isn't mounted/writable, fall back to /tmp
if (!ensureWritableDir(AUTH_PATH)) {
  AUTH_PATH = "/tmp/.wwebjs_auth";
  ensureWritableDir(AUTH_PATH);
}

// ----------------------------
// Chrome profile dir (prevents "profile in use" locks)
// ----------------------------
function clearChromeSingletonLocks(profileDir) {
  const files = ["SingletonCookie", "SingletonLock", "SingletonSocket"];
  for (const f of files) {
    try {
      fs.rmSync(`${profileDir}/${f}`, { force: true });
    } catch {}
  }
}

// Use a unique profile dir per process to avoid overlaps during deploy/restarts
const CHROME_PROFILE_DIR =
  process.env.CHROME_PROFILE_DIR || `/tmp/chrome-profile-render-wa-${process.pid}`;

try {
  fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true }); // clean start (recommended on Render)
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  clearChromeSingletonLocks(CHROME_PROFILE_DIR);
  console.log("✅ Chrome profile dir ready:", CHROME_PROFILE_DIR);
} catch (e) {
  console.error("❌ Could not prepare Chrome profile dir:", e?.message || e);
}

// ----------------------------
// Routes
// ----------------------------
app.get("/", (_req, res) => {
  res.send("🤖 WhatsApp adapter running ✅ — visit /qr to scan.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    whatsapp_ready: WA_READY,
    has_qr: !!LAST_QR_DATAURL,
    django_chat_url: DJANGO_CHAT_URL,
    auth_path: AUTH_PATH,
    chrome_profile_dir: CHROME_PROFILE_DIR,
  });
});

app.get("/debug/fs", (_req, res) => {
  try {
    fs.mkdirSync(AUTH_PATH, { recursive: true });
    fs.writeFileSync(`${AUTH_PATH}/_test.txt`, "ok");
    res.json({ ok: true, auth_path: AUTH_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, auth_path: AUTH_PATH, error: String(e) });
  }
});

app.get("/debug/django", async (_req, res) => {
  try {
    const r = await axios.get(DJANGO_BASE_URL, { timeout: 8000 });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Optional: verify Chrome can launch (useful when diagnosing Render)
app.get("/debug/browser", async (_req, res) => {
  try {
    const puppeteer = require("puppeteer");
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
      ],
    });
    const page = await browser.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const title = await page.title();
    await browser.close();
    res.json({ ok: true, title });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/qr", (_req, res) => {
  if (WA_READY) return res.send("✅ WhatsApp connected. No QR needed.");
  if (!LAST_QR_DATAURL) return res.status(404).send("❌ No QR yet. Wait or check logs.");
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 20px;">
        <h2>Scan this QR with WhatsApp</h2>
        <p>WhatsApp → Linked devices → Link a device</p>
        <img src="${LAST_QR_DATAURL}" style="width:320px;height:320px;" />
        <p>Refresh this page if it expires.</p>
        <hr/>
        <p><b>Status:</b> WA_READY=${WA_READY}</p>
        <p><b>AUTH_PATH:</b> ${AUTH_PATH}</p>
        <p><b>Chrome profile:</b> ${CHROME_PROFILE_DIR}</p>
        <p><b>Django URL:</b> ${DJANGO_CHAT_URL}</p>
      </body>
    </html>
  `);
});

// IMPORTANT for Render: bind 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 Express server running on port ${PORT}`);
  console.log(`➡️ Django chat URL: ${DJANGO_CHAT_URL}`);
  console.log(`🗄️ Auth path: ${AUTH_PATH}`);
});

// ----------------------------
// WhatsApp client
// ----------------------------
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "render-wa",
    dataPath: AUTH_PATH,
  }),

  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,

  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
    ],
  },
});

client.on("loading_screen", (percent, message) => {
  console.log(`⏳ loading_screen: ${percent}%`, message || "");
});

client.on("change_state", (state) => console.log("🔁 WA state:", state));
client.on("remote_session_saved", () => console.log("💾 Remote session saved"));

client.on("qr", async (qr) => {
  console.log("📲 QR RECEIVED (also available at /qr)");
  qrcodeTerminal.generate(qr, { small: true });

  try {
    LAST_QR_DATAURL = await QRCode.toDataURL(qr);
  } catch (e) {
    console.error("❌ Failed to generate QR image:", e.message || e);
  }
});

client.on("authenticated", () => console.log("✅ WhatsApp authenticated"));
client.on("auth_failure", (m) => console.error("❌ Auth failure:", m));

client.on("ready", () => {
  WA_READY = true;
  LAST_QR_DATAURL = null;
  console.log("✅ WhatsApp client is ready!");
});

client.on("disconnected", (reason) => {
  WA_READY = false;
  console.warn("⚠️ WhatsApp disconnected:", reason);
});

// ----------------------------
// Helper endpoints (optional)
// ----------------------------
app.post("/send-payment-confirmation", async (req, res) => {
  try {
    if (!WA_READY) return res.status(503).json({ success: false, error: "WhatsApp not ready yet" });

    const { phone, order_id } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "Missing phone" });

    const fullNumber = `${String(phone).replace(/\D/g, "")}@c.us`;
    const trackingUrl = `https://wa.me/+233559665774`;

    const message =
      `✅ Payment received for your order #${order_id}!\n` +
      `We will give you a call in a sec.\n` +
      `Contact support at ${trackingUrl}`;

    await client.sendMessage(fullNumber, message);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err?.response?.data || err.message || err);
    return res.status(500).json({ success: false, error: "Failed to send message" });
  }
});

app.post("/start-address-flow", async (req, res) => {
  try {
    if (!WA_READY) return res.status(503).json({ success: false, error: "WhatsApp not ready yet" });

    const { phone, item, quantity, addons } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: "Missing phone" });

    const fullNumber = `${String(phone).replace(/\D/g, "")}@c.us`;
    const addonList = (addons || []).map((a) => a.name).join(", ");

    const message =
      `🧾 Order Summary:\n${quantity} x ${item}\n` +
      (addonList ? `➕ Add-ons: ${addonList}\n` : "") +
      `\n\n📍 Please type your *delivery address* to continue.`;

    await client.sendMessage(fullNumber, message);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Error sending WhatsApp address message:", err?.response?.data || err.message || err);
    return res.status(500).json({ success: false, error: "Failed to send address request" });
  }
});

// ----------------------------
// Django forwarding helpers
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
  const headers = { "Content-Type": "application/json" };
  if (DJANGO_AUTH_TOKEN) headers["Authorization"] = `Bearer ${DJANGO_AUTH_TOKEN}`;

  const payload = { external_id, text, provider_message_id, raw };

  const resp = await axios.post(DJANGO_CHAT_URL, payload, {
    headers,
    timeout: 15000,
  });

  return resp.data.reply_text || resp.data.reply || "";
}

// ----------------------------
// Debug: message events
// ----------------------------
client.on("message_create", (msg) => {
  console.log("🟣 message_create:", {
    from: msg.from,
    to: msg.to,
    fromMe: msg.fromMe,
    body: msg.body,
    type: msg.type,
  });
});

client.on("message", (msg) => {
  console.log("🟢 message received:", {
    from: msg.from,
    fromMe: msg.fromMe,
    body: msg.body,
    type: msg.type,
  });
});

// ----------------------------
// Inbound WhatsApp → Django → Reply
// ----------------------------
client.on("message", async (msg) => {
  try {
    console.log("🔥 inbound handler hit", { WA_READY, from: msg.from, body: msg.body });

    if (!WA_READY) return;
    if (msg.fromMe) return;
    if (isGroupChat(msg.from)) return;

    const external_id = extractExternalIdFromMsg(msg);
    const provider_message_id = getProviderMessageId(msg);
    const text = (msg.body || "").trim();
    if (!external_id || !text) return;

    const raw = {
      from: msg.from,
      timestamp: msg.timestamp,
      hasMedia: !!msg.hasMedia,
      type: msg.type,
    };

    console.log("➡️ Forwarding to Django", { external_id, provider_message_id, text, url: DJANGO_CHAT_URL });

    let replyText = "";
    try {
      replyText = await forwardToDjango({ external_id, text, provider_message_id, raw });
      console.log("✅ Django replied:", replyText);
    } catch (e) {
      console.error("❌ Django error:", e?.response?.status, e?.response?.data || e.message);
      replyText = "";
    }

    const finalReply =
      replyText && String(replyText).trim().length > 0
        ? replyText
        : "⚠️ Sorry — I couldn’t process that. Please try again.";

    console.log("📤 Sending reply to chat:", msg.from, finalReply);

    try {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
      await new Promise((r) => setTimeout(r, 400));
      await chat.clearState();
      await chat.sendMessage(finalReply);
      console.log("✅ Reply sent");
    } catch (sendErr) {
      console.error("❌ Send failed:", sendErr?.message || sendErr);
    }
  } catch (err) {
    console.error("❌ Inbound error:", err?.response?.data || err.message || err);
    try {
      const chat = await msg.getChat();
      await chat.sendMessage("⚠️ System is busy. Please try again.");
    } catch {}
  }
});

// ----------------------------
// Init + shutdown safety (with retry + lock cleanup)
// ----------------------------
async function initWhatsApp() {
  console.log("🚀 Initializing WhatsApp client...");
  try {
    await client.initialize();
    console.log("✅ client.initialize() started");
    return;
  } catch (e) {
    console.error("❌ First initialize failed:", e?.message || e);

    // clear profile locks and retry once
    try {
      clearChromeSingletonLocks(CHROME_PROFILE_DIR);
      console.log("🧹 Cleared Chrome Singleton locks, retrying initialize...");
    } catch {}

    try {
      await client.initialize();
      console.log("✅ client.initialize() started after retry");
      return;
    } catch (e2) {
      console.error("❌ Second initialize failed:", e2?.message || e2);
      process.exit(1);
    }
  }
}

initWhatsApp();

async function shutdown(signal) {
  console.log(`🛑 Received ${signal}, shutting down...`);
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("🔥 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});
