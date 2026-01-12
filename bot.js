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
// Express
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
  res.json({ 
    ok: true, 
    whatsapp_ready: WA_READY, 
    django_chat_url: DJANGO_CHAT_URL,
    timestamp: new Date().toISOString()
  });
});

app.get("/qr", (req, res) => {
  if (WA_READY) return res.send("✅ WhatsApp connected. No QR needed.");
  if (!LAST_QR_DATAURL) return res.status(404).send("❌ No QR yet. Wait or check logs.");
  res.send(`
    <html>
      <body style="font-family:Arial;padding:20px;text-align:center">
        <h2>📱 Scan WhatsApp QR Code</h2>
        <p>1. Open WhatsApp on your phone</p>
        <p>2. Tap <strong>⋮ → Linked devices → Link a device</strong></p>
        <p>3. Scan this QR code:</p>
        <img src="${LAST_QR_DATAURL}" style="width:320px;height:320px;border:1px solid #ccc" />
        <p><small>Refresh if QR expires (expires every 60 seconds)</small></p>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 Express server running on port ${PORT}`);
  console.log(`➡️ Django endpoint: ${DJANGO_CHAT_URL}`);
  console.log(`📱 QR available at: http://localhost:${PORT}/qr`);
});

// ----------------------------
// WhatsApp Client Configuration for Render
// ----------------------------
console.log("🔄 Configuring WhatsApp client for Render...");

// Use these EXACT settings for Render
const puppeteerOptions = {
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=site-per-process',
    '--window-size=1920,1080'
  ],
  headless: true,
  ignoreHTTPSErrors: true,
  // DO NOT set executablePath - let puppeteer find Chrome automatically
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
    clientId: "render-client"
  }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html"
  }
});

// ----------------------------
// WhatsApp Event Handlers
// ----------------------------
client.on("loading_screen", (percent, message) => {
  console.log(`🔄 Loading: ${percent}% - ${message}`);
});

client.on("qr", async (qr) => {
  console.log("📲 QR Code received");
  qrcodeTerminal.generate(qr, { small: true });
  
  try {
    LAST_QR_DATAURL = await QRCode.toDataURL(qr);
    console.log("✅ QR image generated for web interface");
  } catch (e) {
    console.error("❌ Failed to generate QR image:", e.message);
  }
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated successfully");
});

client.on("auth_failure", (msg) => {
  console.error("❌ WhatsApp authentication failed:", msg);
});

client.on("ready", () => {
  WA_READY = true;
  LAST_QR_DATAURL = null;
  console.log("✅✅✅ WhatsApp client is READY!");
  console.log("📱 You can now send messages to this number");
});

client.on("disconnected", (reason) => {
  WA_READY = false;
  console.log("⚠️ WhatsApp disconnected:", reason);
  console.log("🔄 Restart the app to reconnect");
});

// ----------------------------
// Helper Functions
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
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (DJANGO_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${DJANGO_AUTH_TOKEN}`;
  }

  const payload = { 
    external_id, 
    text, 
    provider_message_id, 
    raw 
  };

  try {
    console.log(`📤 Forwarding message to Django: ${text.substring(0, 50)}...`);
    const response = await axios.post(DJANGO_CHAT_URL, payload, { 
      headers, 
      timeout: 10000 
    });
    
    return response.data.reply_text || response.data.reply || "Thanks for your message!";
  } catch (error) {
    console.error("❌ Django API error:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    return "⚠️ Our system is processing your request. Please try again in a moment.";
  }
}

// ----------------------------
// Message Handler
// ----------------------------
client.on("message", async (msg) => {
  try {
    if (!WA_READY) {
      console.log("⚠️ WhatsApp not ready yet, ignoring message");
      return;
    }
    
    // Skip group messages
    if (isGroupChat(msg.from)) {
      console.log("ℹ️ Ignoring group message");
      return;
    }
    
    // Get message details
    const external_id = extractExternalIdFromMsg(msg);
    const provider_message_id = getProviderMessageId(msg);
    const text = (msg.body || "").trim();
    
    if (!external_id || !text) {
      console.log("⚠️ Skipping message - no external_id or text");
      return;
    }
    
    console.log(`📥 Incoming message from ${external_id}: "${text}"`);
    
    // Prepare raw data
    const raw = {
      from: msg.from,
      timestamp: msg.timestamp,
      hasMedia: msg.hasMedia,
      type: msg.type,
      isForwarded: msg.isForwarded,
      location: msg.location
    };
    
    // Forward to Django
    const replyText = await forwardToDjango({ 
      external_id, 
      text, 
      provider_message_id, 
      raw 
    });
    
    // Send reply
    const finalReply = replyText.trim() || "Thanks for your message!";
    await client.sendMessage(msg.from, finalReply);
    console.log(`📤 Sent reply to ${external_id}`);
    
  } catch (error) {
    console.error("❌ Error processing message:", error.message);
    console.error(error.stack);
  }
});

// ----------------------------
// Initialize with Error Handling
// ----------------------------
async function initializeWhatsApp() {
  console.log("🔄 Initializing WhatsApp Web...");
  
  try {
    await client.initialize();
    console.log("✅ WhatsApp initialization started");
  } catch (error) {
    console.error("❌ CRITICAL: Failed to initialize WhatsApp:");
    console.error("Error message:", error.message);
    console.error("\n💡 TROUBLESHOOTING TIPS:");
    console.error("1. Make sure Render has Chrome installed");
    console.error("2. Check the Render logs for build errors");
    console.error("3. Try removing node_modules and rebuilding");
    console.error("4. Consider using a different WhatsApp library");
    
    // Don't crash - keep the web server running for QR display
    console.log("⚠️ WhatsApp failed but web server remains running");
  }
}

// Start initialization
setTimeout(() => {
  initializeWhatsApp();
}, 2000); // Give Express time to start first

// ----------------------------
// Graceful Shutdown
// ----------------------------
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  if (client) await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  if (client) await client.destroy();
  process.exit(0);
});