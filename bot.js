const { create, SocketState } = require('@wppconnect-team/wppconnect');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

// Config
const DJANGO_BASE_URL = process.env.DJANGO_BASE_URL || 'https://www.grabtexts.shop';
const DJANGO_CHAT_PATH = process.env.DJANGO_CHAT_PATH || '/api/chat/incoming/';
const DJANGO_CHAT_URL = `${DJANGO_BASE_URL.replace(/\/$/, '')}${DJANGO_CHAT_PATH}`;
const DJANGO_AUTH_TOKEN = process.env.DJANGO_AUTH_TOKEN || null;
const PORT = process.env.PORT || 3000;

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

let client = null;
let qrCodeUrl = null;
let whatsappReady = false;

// Routes
app.get('/', (req, res) => {
  res.send('🤖 WhatsApp Bot is running. Visit /qr to scan QR code.');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp_ready: whatsappReady,
    has_qr: !!qrCodeUrl
  });
});

app.get('/qr', (req, res) => {
  if (whatsappReady) {
    return res.send('✅ WhatsApp is connected!');
  }
  
  if (!qrCodeUrl) {
    return res.send('⌛ QR code not generated yet. Please wait...');
  }
  
  res.send(`
    <html>
      <head>
        <title>Scan WhatsApp QR Code</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
          .container { max-width: 500px; margin: 0 auto; }
          h2 { color: #333; }
          .instructions { background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0; }
          .qr-container { margin: 30px 0; }
          .steps { text-align: left; margin: 20px auto; max-width: 400px; }
          li { margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>📱 Connect WhatsApp</h2>
          <div class="instructions">
            <div class="steps">
              <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Tap <strong>⋮ (Menu)</strong> → <strong>Linked devices</strong></li>
                <li>Tap <strong>Link a device</strong></li>
                <li>Scan the QR code below</li>
              </ol>
            </div>
          </div>
          <div class="qr-container">
            <img src="${qrCodeUrl}" width="300" height="300" alt="WhatsApp QR Code">
          </div>
          <p><small>The QR code refreshes every 60 seconds. Refresh page if expired.</small></p>
        </div>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📱 QR Code URL: http://localhost:${PORT}/qr`);
});

// Helper functions
function extractPhoneNumber(from) {
  if (!from) return '';
  const parts = from.split('@');
  return parts[0] || '';
}

async function sendToDjango(externalId, message, messageId) {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (DJANGO_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${DJANGO_AUTH_TOKEN}`;
  }
  
  const payload = {
    external_id: externalId,
    text: message,
    provider_message_id: messageId,
    raw: {
      timestamp: Date.now()
    }
  };
  
  try {
    console.log(`📤 Sending to Django: "${message.substring(0, 50)}..."`);
    const response = await axios.post(DJANGO_CHAT_URL, payload, { 
      headers, 
      timeout: 10000 
    });
    
    return response.data.reply_text || response.data.reply || 'Thanks for your message!';
  } catch (error) {
    console.error('❌ Django API error:', error.message);
    return 'I received your message. Our system is processing it.';
  }
}

// Initialize WhatsApp
create({
  session: 'whatsapp-session',
  headless: true,
  devtools: false,
  useChrome: false,
  debug: false,
  logQR: true,
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu'
  ]
})
.then((whatsapp) => {
  client = whatsapp;
  
  // QR Code handler
  whatsapp.onStateChange((state) => {
    console.log(`🔄 WhatsApp state: ${state}`);
    if (state === SocketState.CONNECTED) {
      whatsappReady = true;
      qrCodeUrl = null;
      console.log('✅ WhatsApp connected successfully!');
    }
  });
  
  whatsapp.onQRCode(async (qrCode) => {
    console.log('📲 New QR code received');
    try {
      qrCodeUrl = await QRCode.toDataURL(qrCode);
      console.log('✅ QR code generated for web interface');
    } catch (err) {
      console.error('❌ Failed to generate QR code:', err.message);
    }
  });
  
  // Message handler
  whatsapp.onMessage(async (message) => {
    try {
      // Skip group messages
      if (message.isGroupMsg) return;
      
      const phoneNumber = extractPhoneNumber(message.from);
      const messageText = message.body || '';
      
      if (!phoneNumber || !messageText.trim()) return;
      
      console.log(`📥 Message from ${phoneNumber}: "${messageText.substring(0, 50)}..."`);
      
      // Send to Django
      const replyText = await sendToDjango(phoneNumber, messageText, message.id);
      
      // Send reply
      await whatsapp.sendText(message.from, replyText);
      console.log(`📤 Sent reply to ${phoneNumber}`);
      
    } catch (error) {
      console.error('❌ Error processing message:', error.message);
    }
  });
  
  console.log('✅ WhatsApp client initialized');
})
.catch((error) => {
  console.error('❌ Failed to initialize WhatsApp:', error);
  console.log('💡 The web server is still running. QR will be available at /qr');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  if (client) {
    await client.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down...');
  if (client) {
    await client.close();
  }
  process.exit(0);
});