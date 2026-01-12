const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
const fs = require("fs");

// ----------------------------
// Configuration
// ----------------------------
const DJANGO_BASE_URL = process.env.DJANGO_BASE_URL || "https://www.grabtexts.shop";
const DJANGO_CHAT_PATH = process.env.DJANGO_CHAT_PATH || "/api/chat/incoming/";
const DJANGO_CHAT_URL = `${DJANGO_BASE_URL.replace(/\/$/, "")}${DJANGO_CHAT_PATH}`;
const DJANGO_AUTH_TOKEN = process.env.DJANGO_AUTH_TOKEN || null;
const PORT = process.env.PORT || 3000;

// ----------------------------
// Express Server
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json());

let WA_READY = false;
let LAST_QR_DATAURL = null;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
        .container { max-width: 600px; margin: 0 auto; }
        .status { padding: 20px; border-radius: 10px; margin: 20px 0; }
        .ready { background: #d4edda; color: #155724; }
        .waiting { background: #fff3cd; color: #856404; }
        .error { background: #f8d7da; color: #721c24; }
        .btn { 
          display: inline-block; 
          padding: 12px 24px; 
          background: #25D366; 
          color: white; 
          text-decoration: none; 
          border-radius: 5px; 
          font-weight: bold; 
          margin: 10px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 WhatsApp Bot</h1>
        <div class="status ${WA_READY ? 'ready' : 'waiting'}">
          ${WA_READY ? '✅ WhatsApp Connected' : '⌛ Waiting for WhatsApp Connection'}
        </div>
        <p>
          <a href="/qr" class="btn">📱 Scan QR Code</a>
          <a href="/health" class="btn" style="background: #007bff;">🩺 Health Check</a>
        </p>
        <p>Connect your WhatsApp to start receiving messages.</p>
      </div>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    whatsapp_ready: WA_READY,
    timestamp: new Date().toISOString(),
    django_endpoint: DJANGO_CHAT_URL
  });
});

app.get("/qr", (req, res) => {
  if (WA_READY) {
    return res.send("✅ WhatsApp is already connected!");
  }
  
  if (!LAST_QR_DATAURL) {
    return res.send("⌛ QR code not generated yet. Please wait...");
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Scan WhatsApp QR Code</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial, sans-serif; padding: 30px; text-align: center; }
        .container { max-width: 500px; margin: 0 auto; }
        .instructions { 
          background: #f8f9fa; 
          padding: 20px; 
          border-radius: 10px; 
          margin: 20px 0; 
          text-align: left;
        }
        ol { margin: 15px 0; padding-left: 20px; }
        li { margin: 8px 0; }
        .qr-box { margin: 30px; padding: 20px; border: 2px dashed #ccc; display: inline-block; }
        .status { 
          padding: 10px; 
          border-radius: 5px; 
          margin: 20px 0; 
          font-weight: bold;
        }
        .loading { background: #fff3cd; color: #856404; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📱 Connect WhatsApp</h1>
        <div class="instructions">
          <p><strong>Follow these steps:</strong></p>
          <ol>
            <li>Open WhatsApp on your phone</li>
            <li>Tap <strong>⋮ (Menu)</strong> → <strong>Linked devices</strong></li>
            <li>Tap <strong>Link a device</strong></li>
            <li>Scan the QR code below</li>
          </ol>
        </div>
        <div class="status loading">⚠️ This page auto-refreshes every 5 seconds</div>
        <div class="qr-box">
          <img src="${LAST_QR_DATAURL}" width="300" height="300" alt="WhatsApp QR Code">
        </div>
        <p><small>QR code expires every 60 seconds. Refresh page if it stops working.</small></p>
        <p><a href="/">← Back to Home</a></p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Web server running on port ${PORT}`);
  console.log(`🌐 Home page: http://localhost:${PORT}`);
  console.log(`📱 QR page: http://localhost:${PORT}/qr`);
});

// ----------------------------
// WhatsApp Client Configuration
// ----------------------------
console.log("🔄 Configuring WhatsApp for Render...");

// Create auth directory if it doesn't exist
const authDir = "./.wwebjs_auth";
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
  console.log(`✅ Created auth directory: ${authDir}`);
}

// Configure puppeteer for Render
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
    '--window-size=1280,720'
  ],
  headless: "new",
  ignoreHTTPSErrors: true,
  // Use puppeteer's installed Chrome
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/render/.cache/puppeteer/chrome/linux-143.0.7499.192/chrome-linux64/chrome'
};

console.log("📦 Puppeteer options:", JSON.stringify(puppeteerOptions, null, 2));

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: authDir,
    clientId: "render-bot"
  }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html"
  }
});

// ----------------------------
// Event Handlers
// ----------------------------
client.on("loading_screen", (percent, message) => {
  console.log(`🔄 Loading: ${percent}% - ${message}`);
});

client.on("qr", async (qrCode) => {
  console.log("📲 QR Code received");
  qrcodeTerminal.generate(qrCode, { small: true });
  
  try {
    LAST_QR_DATAURL = await qrcode.toDataURL(qrCode);
    console.log("✅ QR code image generated");
  } catch (err) {
    console.error("❌ Failed to generate QR code image:", err.message);
  }
});

client.on("authenticated", () => {
  console.log("✅ WhatsApp authenticated");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failed:", msg);
});

client.on("ready", () => {
  WA_READY = true;
  LAST_QR_DATAURL = null;
  console.log("✅✅✅ WhatsApp client is READY!");
  console.log("📱 Bot is now active and can receive messages");
});

client.on("disconnected", (reason) => {
  WA_READY = false;
  console.log("⚠️ WhatsApp disconnected:", reason);
});

// ----------------------------
// Helper Functions
// ----------------------------
function extractPhoneNumber(from) {
  if (!from) return '';
  return from.split('@')[0] || '';
}

async function sendToDjango(phoneNumber, message, messageId) {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (DJANGO_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${DJANGO_AUTH_TOKEN}`;
  }
  
  const payload = {
    external_id: phoneNumber,
    text: message,
    provider_message_id: messageId,
    raw: {
      timestamp: Date.now(),
      platform: "whatsapp"
    }
  };
  
  try {
    console.log(`📤 Sending to Django: "${message.substring(0, 50)}..."`);
    const response = await axios.post(DJANGO_CHAT_URL, payload, { 
      headers, 
      timeout: 15000 
    });
    
    return response.data?.reply_text || response.data?.reply || "Thank you for your message!";
  } catch (error) {
    console.error("❌ Django API error:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    }
    return "I received your message. Our system is processing it.";
  }
}

// ----------------------------
// Message Handler
// ----------------------------
client.on("message", async (msg) => {
  try {
    if (!WA_READY) {
      console.log("⚠️ Ignoring message - WhatsApp not ready");
      return;
    }
    
    // Skip group messages
    if (msg.from.includes("@g.us")) {
      console.log("ℹ️ Ignoring group message");
      return;
    }
    
    const phoneNumber = extractPhoneNumber(msg.from);
    const messageText = msg.body?.trim() || "";
    
    if (!phoneNumber || !messageText) {
      console.log("⚠️ Skipping empty message");
      return;
    }
    
    console.log(`📥 Message from ${phoneNumber}: "${messageText.substring(0, 50)}..."`);
    
    // Get reply from Django
    const replyText = await sendToDjango(phoneNumber, messageText, msg.id?._serialized);
    
    // Send reply
    await client.sendMessage(msg.from, replyText);
    console.log(`📤 Replied to ${phoneNumber}`);
    
  } catch (error) {
    console.error("❌ Error processing message:", error.message);
  }
});

// ----------------------------
// Initialize WhatsApp
// ----------------------------
async function initializeWhatsApp() {
  console.log("🚀 Initializing WhatsApp...");
  
  try {
    await client.initialize();
    console.log("✅ WhatsApp initialization started");
  } catch (error) {
    console.error("❌ Failed to initialize WhatsApp:");
    console.error("Error:", error.message);
    
    // Provide helpful debugging info
    console.log("\n🔧 TROUBLESHOOTING:");
    console.log("1. Check if Chrome is installed:");
    console.log("   Command: which google-chrome");
    console.log("2. Check puppeteer cache path:");
    console.log("   Path: /opt/render/.cache/puppeteer");
    console.log("3. Try installing Chrome manually in build script");
    
    // Keep server running for QR display
    console.log("\n⚠️ WhatsApp failed, but web server is still running");
  }
}

// Start WhatsApp after a short delay
setTimeout(() => {
  initializeWhatsApp();
}, 3000);

// ----------------------------
// Graceful Shutdown
// ----------------------------
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...');
  if (client) await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM');
  if (client) await client.destroy();
  process.exit(0);
});