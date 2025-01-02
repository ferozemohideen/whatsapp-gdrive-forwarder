// SupabaseAuth.js
const { AuthStrategy, NoAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

/**
 * SupabaseAuth: merges LocalAuth folder usage with a Supabase Storage backup of the session.
 */
class SupabaseAuth extends NoAuth {
  /**
   * @param {object} options
   * @param {string} options.supabaseUrl
   * @param {string} options.supabaseKey
   * @param {string} options.bucketName
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
    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL/Key required.');
    if (!bucketName) throw new Error('Supabase bucketName is required.');

    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.bucketName = bucketName;
    this.remoteDataPath = remoteDataPath.replace(/\\/g, '/');
    this.sessionName = sessionName;
    this.debug = debug;

    this.authDir = path.join(process.cwd(), '.wwebjs_auth', this.sessionName);

    // Create Supabase client
    this.supabase = createClient(this.supabaseUrl, this.supabaseKey);
  }

  debugLog(msg) {
    if (this.debug) {
      console.log(`[SupabaseAuth][${new Date().toISOString()}] ${msg}`);
    }
  }

  /**
   * Called before launching Chromium. We attempt to download and unzip any existing session ZIP.
   */
  async beforeBrowserInitialized() {
    this.debugLog('beforeBrowserInitialized: Checking for existing session in Supabase...');
    fs.mkdirSync(this.authDir, { recursive: true });

    const zipPath = path.join(process.cwd(), `${this.sessionName}.zip`);
    const remoteFilePath = path.join(this.remoteDataPath, `${this.sessionName}.zip`).replace(/\\/g, '/');

    // List the remote directory
    const { data: fileList, error: listErr } = await this.supabase
      .storage
      .from(this.bucketName)
      .list(this.remoteDataPath, { limit: 1000 });

    if (listErr) {
      this.debugLog(`Error listing remote dir: ${listErr.message}`);
      return;
    }

    // Check if there's a .zip with our sessionName
    const foundZip = fileList && fileList.find(item => item.name === `${this.sessionName}.zip`);
    if (!foundZip) {
      this.debugLog('No existing zip found in Supabase Storage. Starting fresh.');
      return;
    }

    // Download the ZIP
    const { data: downloadData, error: downloadErr } = await this.supabase
      .storage
      .from(this.bucketName)
      .download(remoteFilePath);

    if (downloadErr || !downloadData) {
      this.debugLog(`Failed to download existing session zip: ${downloadErr?.message}`);
      return;
    }

    // Save the file to disk
    const arrayBuffer = await downloadData.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));
    // Unzip
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(this.authDir, true);
    this.debugLog(`Session restored from Supabase: ${remoteFilePath} → ${this.authDir}`);
  }

  /**
   * Called after the browser is up. We'll watch the authDir for changes,
   * and forcibly upload once to confirm we push the session if it exists.
   */
  async afterBrowserInitialized() {
    this.debugLog(`afterBrowserInitialized: Setting up watchers in ${this.authDir}`);

    // Force at least one upload on startup (in case no file changes occur)
    try {
      await this.uploadSessionZip();
    } catch (err) {
      console.error('Error uploading session zip on startup:', err);
    }

    // Watch for changes
    const watcher = chokidar.watch(this.authDir, {
      ignoreInitial: true,
      persistent: true
    });

    watcher.on('all', async (event, filePath) => {
      this.debugLog(`File event: ${event} in ${filePath}. Uploading zip...`);
      try {
        await this.uploadSessionZip();
      } catch (err) {
        console.error('Error uploading session zip:', err);
      }
    });
  }

  /**
   * Zip the .wwebjs_auth folder and upload to Supabase. 
   * Using Buffer read to avoid the "duplex" error with Node 18 fetch.
   */
  async uploadSessionZip() {
    const zipPath = path.join(process.cwd(), `${this.sessionName}.zip`);
    // Zip the entire authDir
    const zip = new AdmZip();
    zip.addLocalFolder(this.authDir);
    zip.writeZip(zipPath);

    // Instead of streaming, read the file as a buffer
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
