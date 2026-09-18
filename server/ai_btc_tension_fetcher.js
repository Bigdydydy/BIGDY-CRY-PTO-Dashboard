/**
 * AI-BTC Financing Tension Index & Transmission Analysis Fetcher
 * Reads, caches, and serves the pre-computed institutional dataset for Module 8.
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DATA_FILE = path.join(__dirname, '..', 'data', 'ai_btc_tension.json');
const PYTHON_PIPELINE_DIR = path.join('C:', 'Users', 'HZX', '.gemini', 'antigravity', 'scratch', 'ai_btc_tension_index');

let cachedData = null;
let lastLoadedTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute in-memory cache

/**
 * Validates the core schema of the AI-BTC Tension payload
 */
function validateAiBtcTensionData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('AI-BTC Tension payload must be an object');
  }
  if (!data.metadata || !data.current || !data.series || !Array.isArray(data.series)) {
    throw new Error('AI-BTC Tension payload is missing metadata, current, or series');
  }
  if (!data.regression || !Array.isArray(data.regression.parameters)) {
    throw new Error('AI-BTC Tension payload is missing regression parameters');
  }
  if (!Array.isArray(data.event_study) || !data.miner_hpc_basket) {
    throw new Error('AI-BTC Tension payload is missing event_study or miner_hpc_basket');
  }
  return true;
}

/**
 * Loads AI-BTC tension dataset from disk cache
 */
function loadFromDisk() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`AI-BTC Tension data file not found at: ${DATA_FILE}`);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  validateAiBtcTensionData(parsed);
  cachedData = parsed;
  lastLoadedTime = Date.now();
  return cachedData;
}

/**
 * Gets AI-BTC tension data, respecting cache unless forceRefresh is true
 */
async function getAiBtcTensionData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedData && (now - lastLoadedTime < CACHE_TTL_MS)) {
    return cachedData;
  }

  // Attempt to read from disk first
  try {
    return loadFromDisk();
  } catch (err) {
    console.warn('[AiBtcTensionFetcher] Initial disk load warning:', err.message);
    if (cachedData) return cachedData;
    throw err;
  }
}

/**
 * Optional background sync with Python pipeline if available
 */
function triggerPythonPipelineRefresh() {
  return new Promise((resolve) => {
    const pythonExe = path.join(PYTHON_PIPELINE_DIR, '.venv', 'Scripts', 'python.exe');
    const exportScript = path.join(PYTHON_PIPELINE_DIR, 'export_to_json.py');

    if (!fs.existsSync(pythonExe) || !fs.existsSync(exportScript)) {
      console.log('[AiBtcTensionFetcher] Python venv or export script not present, skipping execution.');
      return resolve(false);
    }

    exec(`"${pythonExe}" "${exportScript}"`, { cwd: PYTHON_PIPELINE_DIR }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[AiBtcTensionFetcher] Python pipeline execution error:', error.message);
        return resolve(false);
      }
      console.log('[AiBtcTensionFetcher] Python pipeline successfully updated ai_btc_tension.json');
      try {
        loadFromDisk();
        resolve(true);
      } catch (e) {
        resolve(false);
      }
    });
  });
}

module.exports = {
  getAiBtcTensionData,
  validateAiBtcTensionData,
  triggerPythonPipelineRefresh
};
