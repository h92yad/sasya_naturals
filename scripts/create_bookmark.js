'use strict';

/**
 * Deterministic Multi-Layer Bookmark Generator (Gate 2 Rule 2)
 * Creates a physical snapshot in .bookmarks/ containing SQLite DB, .env, and executable restore.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, DB_PATH } = require('../src/config/appConfig');
const { getDb } = require('../src/db/database');

function createBookmark(tagLabel = 'pre_update') {
  getDb(); // Ensure DB is initialized
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanLabel = String(tagLabel).replace(/[^a-zA-Z0-9_-]/g, '_');
  const bookmarkDir = path.join(ROOT_DIR, '.bookmarks', `bookmark_${ts}_${cleanLabel}`);
  fs.mkdirSync(bookmarkDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, path.join(bookmarkDir, 'sasya_store.db'));
  }
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, path.join(bookmarkDir, '.env.snapshot'));
  }

  const restoreScript = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dbBackup = path.join(__dirname, 'sasya_store.db');
const dbTarget = path.join(root, 'data/sasya_store.db');
if (fs.existsSync(dbBackup)) {
  fs.copyFileSync(dbBackup, dbTarget);
  console.log('[RESTORE COMPLETE] Restored data/sasya_store.db from', __dirname);
}
`;
  fs.writeFileSync(path.join(bookmarkDir, 'restore.js'), restoreScript, 'utf8');
  console.log(`[Gate 2 Bookmark] Created physical DB + config snapshot at ${bookmarkDir}`);
  return bookmarkDir;
}

if (require.main === module) {
  createBookmark(process.argv[2] || 'manual');
}

module.exports = { createBookmark };
