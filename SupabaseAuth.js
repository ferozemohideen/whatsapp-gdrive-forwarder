// SupabaseAuth.js
const { AuthStrategy, NoAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

/**
 * SupabaseAuth: merges LocalAuth folder usage with a Supabase-based backup
 * of the `.wwebjs_auth/<sessionName>` directory, but WITHOUT file-watching.
 */
class SupabaseAuth extends NoAuth {
  /**
   * @param {object} options
   * @param {string} options.supabaseUrl       - Your Supabase project URL (https://xyzcompany.supabase.co).
   * @param {string} options.supabaseKey       - Your Supabase service (or anon) key. For private buckets, typically service key is needed.
   * @param {string} options.bucketName        - The bucket to store the zip in.
   * @param {string} [options.remoteDataPath='whatsapp/sessions']
   * @param {string} [options.sessionName='session']
   * @param {boolean} [options.debug=false]
   */
  constructor({
    supabaseUrl,
    supabaseKey,
    bucketName,
    remoteDataPath = 'whatsapp/sessions',
    sessionName = 'session',
    debug = false
  }) {
    super();
    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL & Key are required.');
    if (!bucketName) throw new Error('Supabase bucketName is required.');

    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.bucketName = bucketName;
    this.remoteDataPath = remoteDataPath.replace(/\\/g, '/');
    this.sessionName = sessionName;
    this.debug = debug;

    this.authDir = path.join(process.cwd(), '.wwebjs_auth', this.sessionName);

    // Create the Supabase client
    this.supabase = createClient(this.supabaseUrl, this.supabaseKey);
  }

  debugLog(msg) {
    if (this.debug) {
      console.log(`[SupabaseAuth][${new Date().toISOString()}] ${msg}`);
    }
  }

  /**
   * Called before the browser is launched. We'll attempt to load an existing
   * session from Supabase by downloading & unzipping.
   */
  async beforeBrowserInitialized() {
    this.debugLog('beforeBrowserInitialized: Checking for existing session in Supabase...');
    fs.mkdirSync(this.authDir, { recursive: true });

    const zipPath = path.join(process.cwd(), `${this.sessionName}.zip`);
    const remoteFilePath = path.join(this.remoteDataPath, `${this.sessionName}.zip`).replace(/\\/g, '/');

    // 1. List the remote directory
    const { data: fileList, error: listErr } = await this.supabase
      .storage
      .from(this.bucketName)
      .list(this.remoteDataPath, { limit: 1000 });

    if (listErr) {
      this.debugLog(`Error listing remote dir: ${listErr.message}`);
      return; // No session to restore
    }

    // 2. Check if there's a .zip named <sessionName>.zip
    const foundZip = fileList && fileList.find(item => item.name === `${this.sessionName}.zip`);
    if (!foundZip) {
      this.debugLog('No existing zip found in Supabase Storage. Starting fresh.');
      return;
    }

    // 3. Download the ZIP
    const { data: downloadData, error: downloadErr } = await this.supabase
      .storage
      .from(this.bucketName)
      .download(remoteFilePath);

    if (downloadErr || !downloadData) {
      this.debugLog(`Failed to download existing session zip: ${downloadErr?.message}`);
      return;
    }

    // 4. Write the blob to disk
    const arrayBuffer = await downloadData.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));

    // 5. Unzip into ./.wwebjs_auth/<sessionName>
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(this.authDir, true);

    this.debugLog(`Session restored from Supabase: ${remoteFilePath} -> ${this.authDir}`);
  }

  /**
   * Called after the browser is initialized. We won't watch for changes automatically.
   * If you want at least one upload on startup, call uploadSessionZip() here.
   */
  async afterBrowserInitialized() {
    this.debugLog('afterBrowserInitialized: Doing one optional forced upload (comment out if unwanted)...');

    // If you definitely want to push up the local session right away:
    await this.uploadSessionZip();
  }

  /**
   * Method to manually zip ./.wwebjs_auth/<sessionName> and upload to Supabase.
   * You can call this from anywhere in your code if you want to do an upload.
   */
  async uploadSessionZip() {
    const zipPath = path.join(process.cwd(), `${this.sessionName}.zip`);

    // Zip the entire authDir
    const zip = new AdmZip();
    zip.addLocalFolder(this.authDir);
    zip.writeZip(zipPath);

    // Read it into a buffer (avoids the "duplex" error)
    const zipBuffer = fs.readFileSync(zipPath);

    const remoteFilePath = path.join(this.remoteDataPath, `${this.sessionName}.zip`).replace(/\\/g, '/');

    this.debugLog(`uploadSessionZip: Uploading ${zipBuffer.length} bytes to ${remoteFilePath}...`);
    const { data: uploadData, error: uploadErr } = await this.supabase
      .storage
      .from(this.bucketName)
      .upload(remoteFilePath, zipBuffer, {
        contentType: 'application/zip',
        upsert: true
      });

    if (uploadErr) {
      this.debugLog(`Failed to upload session zip: ${uploadErr.message}`);
      return;
    }
    this.debugLog(`Session zip uploaded to Supabase at: ${remoteFilePath}`);
  }

  // The following override methods are no-ops for completeness:
  async onAuthenticationNeeded() {
    this.debugLog('onAuthenticationNeeded()');
  }
  async onAuthenticated() {
    this.debugLog('onAuthenticated()');
  }
  async onReady() {
    this.debugLog('onReady()');
  }
  async onLogout() {
    this.debugLog('onLogout()');
  }
}

module.exports = { SupabaseAuth };
