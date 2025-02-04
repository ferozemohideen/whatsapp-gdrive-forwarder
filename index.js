// index.js
require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');

const { SupabaseAuth } = require('./SupabaseAuth');

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_BUCKET,
  GOOGLE_CREDENTIALS,
  DRIVE_FOLDER_ID,
  TARGET_CHAT_ID,
  PORT = 3000,
} = process.env;

// Parse Google creds if needed
const googleCreds = GOOGLE_CREDENTIALS ? JSON.parse(GOOGLE_CREDENTIALS) : null;

// 1) Create a custom SupabaseAuth (NO watchers)
const supabaseAuth = new SupabaseAuth({
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
  bucketName: SUPABASE_BUCKET,
  remoteDataPath: 'whatsapp/sessions',
  sessionName: 'session',   // must match LocalAuth's clientId
  debug: true
});

// 2) Create LocalAuth
const localAuth = new LocalAuth({ clientId: 'session' });

// 3) Create the WhatsApp client (we only pass LocalAuth to the constructor)
const client = new Client({
  authStrategy: localAuth,
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox',
      "--no-first-run",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ]
  }
});

// We'll manually call supabaseAuth.* around client.initialize()

// --- Standard wwebjs events ---
client.on('qr', (qr) => {
  console.log('QR code received. Scan it with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp client authenticated!');
});

client.on('auth_failure', (msg) => {
  console.error('AUTH FAILURE', msg);
});

client.on('ready', async () => {
  console.log('WhatsApp client is ready!');
  // Let SupabaseAuth do after-browser logic (which might do a forced upload)
  await supabaseAuth.afterBrowserInitialized();
});

// Listen for media messages, for example
client.on('message', async (msg) => {
  // Only process messages from the target chat
  console.log('Incoming message from:', msg.from);
  if (msg.from !== TARGET_CHAT_ID) {
    return;
  }

  if (msg.hasMedia) {
    console.log('Incoming media from target chat:', msg.from);
    try {
      const media = await msg.downloadMedia();
      await uploadToDrive(media);
      console.log('Uploaded to Drive!');
    } catch (err) {
      console.error('Error uploading media:', err);
    }
  }
});

// 4) Startup flow
(async () => {
  // Attempt to restore session from Supabase
  await supabaseAuth.beforeBrowserInitialized();
  // Now initialize the client
  client.initialize();
})();

// Simple Express server
const app = express();
app.get('/', (req, res) => {
  res.send('WhatsApp -> SupabaseAuth -> GDrive (No watchers) is running!');
});

// If you want a route that triggers a manual upload:
app.get('/backup-session', async (req, res) => {
  try {
    await supabaseAuth.uploadSessionZip();
    res.send('Session manually uploaded to Supabase!');
  } catch (err) {
    res.status(500).send('Error uploading session: ' + err.message);
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Helper function to upload media to Google Drive
async function uploadToDrive(media) {
  if (!googleCreds) return;

  const auth = new google.auth.GoogleAuth({
    credentials: googleCreds,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  const driveService = google.drive({ version: 'v3', auth });

  const ext = media.mimetype.split('/')[1];
  const fileName = `whatsapp-media-${Date.now()}.${ext}`;
  const fileBuffer = Buffer.from(media.data, 'base64');

  const { PassThrough } = require('stream');
  const bufferStream = new PassThrough();
  bufferStream.end(fileBuffer);

  const resp = await driveService.files.create({
    requestBody: {
      name: fileName,
      parents: [DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: media.mimetype,
      body: bufferStream
    },
    fields: 'id'
  });
  return resp.data.id;
}
