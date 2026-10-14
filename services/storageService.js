/**
 * storageService.js
 *
 * Provides a unified read/write layer that works both locally (data/ directory)
 * and on Vercel serverless (read-only bundle FS, writable /tmp).
 *
 * Strategy:
 *  - Reads try the data/ file first (initial seed data from the bundle), then /tmp.
 *  - Writes always go to /tmp (writable everywhere).
 *  - In-memory fallback is always maintained so the app works even if /tmp fills up.
 */

const fs = require('fs');
const path = require('path');

const os = require('os');
const TMP_DIR = path.join(os.tmpdir(), 'mailflow_data');
const DATA_DIR = path.resolve(__dirname, '..', 'data');

function isVercel() {
  return !!process.env.VERCEL;
}

// Ensure temp directory exists for a given file
function ensureTmpDir(targetTmpPath) {
  try {
    const dir = targetTmpPath ? path.dirname(targetTmpPath) : TMP_DIR;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {}
}

function getTmpPath(dataFilePath) {
  try {
    const resolved = path.resolve(dataFilePath);
    const rel = path.relative(DATA_DIR, resolved);
    // If the path is outside DATA_DIR (e.g. temporary test directory, custom location),
    // preserve the specific caller-provided path rather than collapsing by filename.
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return resolved;
    }
    return path.join(TMP_DIR, rel);
  } catch (e) {
    return path.join(TMP_DIR, path.basename(dataFilePath));
  }
}

/**
 * Read JSON data from storage.
 * - On Vercel: /tmp override first, then bundled seed data
 * - Locally: direct data/ file first, then /tmp
 */
function readJSON(dataFilePath, defaultValue = null) {
  const tmpPath = getTmpPath(dataFilePath);

  if (isVercel()) {
    // 1. Try /tmp first on Vercel (where runtime writes happen)
    try {
      if (fs.existsSync(tmpPath)) {
        const raw = fs.readFileSync(tmpPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {}

    // 2. Fall back to bundled data/ file
    try {
      if (fs.existsSync(dataFilePath)) {
        const raw = fs.readFileSync(dataFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {}
  } else {
    // Local dev: try the local project file first
    try {
      if (fs.existsSync(dataFilePath)) {
        const raw = fs.readFileSync(dataFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {}

    // Fall back to temp if file doesn't exist in data/
    try {
      if (fs.existsSync(tmpPath)) {
        const raw = fs.readFileSync(tmpPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {}
  }

  return defaultValue;
}

/**
 * Write JSON data.
 * Tries local dataFilePath first (for local dev persistence).
 * If on Vercel or read-only filesystem (EROFS), writes to TMP_DIR preserving subdirectories.
 */
function writeJSON(dataFilePath, data) {
  const tmpPath = getTmpPath(dataFilePath);

  // If NOT on Vercel, attempt direct write to local data/ folder first
  if (!isVercel()) {
    try {
      const parentDir = path.dirname(dataFilePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      // If direct write fails (permissions/read-only), fall through to tmp
      console.warn(`[storageService] Local write to ${dataFilePath} failed, falling back to temp: ${e.message}`);
    }
  }

  // On Vercel or read-only environments, write to temp directory
  ensureTmpDir(tmpPath);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[storageService] Could not write ${tmpPath}: ${e.message}`);
    return false;
  }
}

/**
 * Delete a data file from both local and temp locations.
 */
function deleteFile(dataFilePath) {
  const tmpPath = getTmpPath(dataFilePath);
  try {
    if (fs.existsSync(dataFilePath)) fs.unlinkSync(dataFilePath);
  } catch (e) {}
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch (e) {}
}

/**
 * Check if a data file exists in /tmp or the bundle.
 */
function exists(dataFilePath) {
  const tmpPath = getTmpPath(dataFilePath);
  return fs.existsSync(tmpPath) || fs.existsSync(dataFilePath);
}

module.exports = { readJSON, writeJSON, deleteFile, exists, TMP_DIR, DATA_DIR };

