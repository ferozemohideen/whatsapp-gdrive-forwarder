// index.js
require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');

const { SupabaseAuth } = require('./SupabaseAuth');

// === 1) Load ENV Variables ===
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_BUCKET,
  DRIVE_FOLDER_ID,
  GOOGLE_CREDENTIALS,
  PORT = 3000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_BUCKET) {
  throw new Error('Missing Supabase config. Please set SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET.');
}

// For Google Drive
const googleCreds = GOOGLE_CREDENTIALS ? JSON.parse(GOOGLE_CREDENTIALS) : null;
if (!googleCreds) {
  throw new Error('Missing Google credentials in GOOGLE_CREDENTIALS env variable.');
}

if (!DRIVE_FOLDER_ID) {
  throw new Error('Missing DRIVE_FOLDER_ID.');
}

// === 2) Create the Auth Strategies ===
// "LocalAuth" will handle normal local session logic in ./.wwebjs_auth/session
// "SupabaseAuth" will sync that session folder with Supabase
const supabaseAuth = new SupabaseAuth({
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
  bucketName: SUPABASE_BUCKET,
  remoteDataPath: 'whatsapp/sessions',
  sessionName: 'session',  // the same directory name used by LocalAuth
  debug: true,
});

// We also rely on LocalAuth so that whatsapp-web.js properly loads/writes session data
const localAuth = new LocalAuth({
  clientId: 'session', // this means ./.wwebjs_auth/session
});

// === 3) Create the WhatsApp client ===
const client = new Client({
  // We'll primarily rely on LocalAuth. 
  // But we also pass "supabaseAuth" so it can do `beforeBrowserInitialized` / `afterBrowserInitialized`.
  authStrategy: localAuth, // The library will only accept one "authStrategy" 
                           // so we do a small trick below:
  puppeteer: { 
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Manually hook SupabaseAuth's lifecycle
client.on('launch_browser', async () => {
  // "launch_browser" isn't an official event, 
  // but let's pretend we call supabaseAuth's methods here:

  // If your version of whatsapp-web.js doesn't have 'launch_browser', 
  // call supabaseAuth.beforeBrowserInitialized() just before client.initialize():
  await supabaseAuth.beforeBrowserInitialized();
});

client.on('ready', async () => {
  // after the browser is up, call afterBrowserInitialized
  await supabaseAuth.afterBrowserInitialized();
  console.log('WhatsApp is ready!');
});

// Standard events
client.on('qr', (qr) => {
  console.log('QR code received, scan it with your phone:');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => {
  console.log('WhatsApp client authenticated!');
});
client.on('auth_failure', msg => {
  console.error('Authentication failure:', msg);
});

// === 4) Listening for Media + Upload to Google Drive ===
client.on('message', async (msg) => {
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      // Upload to Google Drive
      const driveFileId = await uploadToDrive(media);
      console.log('Media uploaded to Drive. File ID:', driveFileId);
    } catch (err) {
      console.error('Error uploading media to Drive:', err);
    }
  }
});

async function uploadToDrive(media) {
  // 1. Auth with Google
  const auth = new google.auth.GoogleAuth({
    credentials: googleCreds,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  const driveService = google.drive({ version: 'v3', auth });

  // 2. Build filename & convert base64 to buffer
  const ext = media.mimetype.split('/')[1]; // e.g. 'jpeg', 'png', 'mp4'
  const fileName = `whatsapp-media-${Date.now()}.${ext}`;
  const fileBuffer = Buffer.from(media.data, 'base64');

  // 3. Make a stream
  const { PassThrough } = require('stream');
  const bufferStream = new PassThrough();
  bufferStream.end(fileBuffer);

  // 4. Upload
  const resp = await driveService.files.create({
    requestBody: {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: media.mimetype,
      body: bufferStream
    },
    fields: 'id'
  });
  return resp.data.id;
}

// === 5) Start the client + Express server ===
(async () => {
  // If you don't have a "launch_browser" event, call supabaseAuth.beforeBrowserInitialized() here:
  await supabaseAuth.beforeBrowserInitialized();
  // Then initialize the client
  client.initialize();
})();

const app = express();
app.get('/', (req, res) => {
  res.send('WhatsApp -> SupabaseAuth -> Google Drive is running!');
});
app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));
