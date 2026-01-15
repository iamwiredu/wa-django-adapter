// bot.js
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode"); // npm i qrcode
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
// Express server (START IMMEDIATELY for Render)
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json());

let WA_READY = false;
let LAST_QR_DATAURL = null;

app.get("/", (req, res) => {
  res.send("🤖 WhatsApp adapter running ✅ — visit /qr to scan.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whatsapp_ready: WA_READY,
    has_qr: !!LAST_QR_DATAURL,
    django_chat_url: DJANGO_CHAT_URL,
  });
});

// Browser QR page (helpful on Render)
app.get("/qr", (req, res) => {
  if (WA_READY) return res.send("✅ WhatsApp connected. No QR needed.");
  if (!LAST_QR_DATAURL) return res.status(404).send("❌ No QR yet. Wait or check logs.");
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 20px;">
        <h2>Scan this QR with WhatsApp</h2>
        <p>WhatsApp → Linked devices → Link a device</p>
        <img src="${LAST_QR_DATAURL}" style="width:320px;height:320px;" />
        <p>Refresh this page if it expires.</p>
      </body>
    </html>
  `);
});

// IMPORTANT for Render: bind 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 Express server running on port ${PORT}`);
  console.log(`➡️ Django chat URL: ${DJANGO_CHAT_URL}`);
});

// ----------------------------
// WhatsApp client
// ----------------------------
// NOTE: If you deploy with Docker+Chromium, set PUPPETEER_EXECUTABLE_PATH
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || "/var/data/.wwebjs_auth";

const client = new Client({
  authStrategy: new LocalAuth({
  clientId: "render-wa",
  dataPath: AUTH_PATH,
}),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // leave undefined locally
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

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
    console.error("❌ Error sending WhatsApp message:", err);
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
    console.error("❌ Error sending WhatsApp address message:", err);
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
// Inbound WhatsApp → Django → Reply
// ----------------------------
client.on("message", async (msg) => {
  try {
    if (!WA_READY) return;
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

    const replyText = await forwardToDjango({ external_id, text, provider_message_id, raw });

    const finalReply =
      replyText && String(replyText).trim().length > 0
        ? replyText
        : "⚠️ Sorry — I couldn’t process that. Please try again.";

    await client.sendMessage(msg.from, finalReply);
  } catch (err) {
    console.error("❌ Inbound error:", err?.response?.data || err.message || err);
    try {
      await client.sendMessage(msg.from, "⚠️ System is busy. Please try again.");
    } catch {}
  }
});

client.initialize();
