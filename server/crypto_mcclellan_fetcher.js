/**
 * Crypto Dual-Track McClellan Oscillator & Liquidity Siphon Fetcher
 * Reads, caches, and serves the pre-computed market breadth dataset for Module 1-B.
 */
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const DATA_FILE = path.join(__dirname, '..', 'data', 'crypto_mcclellan.json');
const PYTHON_PIPELINE_DIR = path.join(__dirname, '..', 'scripts', 'crypto_mcclellan');

let cachedData = null;
let lastLoadedTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute in-memory cache

let lastRefreshStatus = {
  status: 'cached',
  message: '使用已验证的基准预计算数据',
  timestamp: new Date().toISOString()
};

/**
 * Validates the core schema of the McClellan payload
 */
function validateMcClellanData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('McClellan payload must be an object');
  }
  if (!data.metadata || !data.current || !data.series || !Array.isArray(data.series)) {
    throw new Error('McClellan payload is missing metadata, current, or series');
  }
  if (!data.regime_stats || typeof data.regime_stats !== 'object') {
    throw new Error('McClellan payload is missing regime_stats');
  }
  if (typeof data.current.core_oscillator !== 'number' || typeof data.current.frontier_oscillator !== 'number') {
    throw new Error('McClellan payload current state has invalid oscillator types');
  }
  return true;
}

/**
 * Detect available Python executable
 */
function detectPython() {
  const candidates = [
    path.join(__dirname, '..', 'scripts', 'ai_btc_tension', '.venv', 'Scripts', 'python.exe'),
    path.join(PYTHON_PIPELINE_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(PYTHON_PIPELINE_DIR, '.venv', 'bin', 'python'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\HZX', '.gemini', 'antigravity', 'scratch', 'ai_btc_tension_index', '.venv', 'Scripts', 'python.exe'),
    'python3',
    'python'
  ];

  for (const cand of candidates) {
    if (path.isAbsolute(cand) && fs.existsSync(cand)) {
      return cand;
    }
  }

  // Probe system PATH
  for (const cmd of ['python3', 'python']) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (e) {
      // not in path
    }
  }
  return null;
}

/**
 * Loads McClellan dataset from disk cache
 */
function loadFromDisk() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`McClellan data file not found at: ${DATA_FILE}`);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  validateMcClellanData(parsed);
  cachedData = parsed;
  lastLoadedTime = Date.now();
  return cachedData;
}

/**
 * Triggers Python pipeline refresh if available
 */
function triggerPythonPipelineRefresh() {
  return new Promise((resolve) => {
    const pythonBin = detectPython();
    const exportScript = path.join(PYTHON_PIPELINE_DIR, 'export_to_json.py');

    if (!pythonBin || !fs.existsSync(exportScript)) {
      console.log('[McClellanFetcher] Python runtime or export script not found in environment.');
      return resolve({
        success: false,
        status: 'pipelineUnavailable',
        reason: 'Python runtime or export script not found'
      });
    }

    const cmd = `"${pythonBin}" "${exportScript}"`;
    exec(cmd, { cwd: PYTHON_PIPELINE_DIR, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[McClellanFetcher] Python pipeline execution error:', error.message);
        return resolve({
          success: false,
          status: 'stale',
          reason: error.message
        });
      }
      console.log('[McClellanFetcher] Python pipeline successfully updated crypto_mcclellan.json');
      try {
        loadFromDisk();
        resolve({
          success: true,
          status: 'refreshed'
        });
      } catch (e) {
        resolve({
          success: false,
          status: 'stale',
          reason: e.message
        });
      }
    });
  });
}

/**
 * Gets McClellan data, respecting cache unless forceRefresh is true
 */
async function getMcClellanData(forceRefresh = false) {
  const now = Date.now();

  if (forceRefresh) {
    try {
      console.log('[McClellanFetcher] forceRefresh requested: executing Python calculation pipeline...');
      const result = await triggerPythonPipelineRefresh();
      if (result.success) {
        lastRefreshStatus = {
          status: 'refreshed',
          message: '双轨麦克莱伦市场广度与流动性剪刀差管线已成功重新解算！',
          timestamp: new Date().toISOString()
        };
      } else {
        lastRefreshStatus = {
          status: result.status,
          message: result.status === 'pipelineUnavailable'
            ? '当前运行环境未配置 Python 科学计算栈，已提供核验基准快照数据'
            : `Python 管线运行异常 (${result.reason})，已回退至已验证的快照数据`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (pipelineErr) {
      console.warn('[McClellanFetcher] Python pipeline trigger error, falling back:', pipelineErr.message);
      lastRefreshStatus = {
        status: 'stale',
        message: `Python 管线执行出错: ${pipelineErr.message}`,
        timestamp: new Date().toISOString()
      };
    }
  }

  if (!forceRefresh && cachedData && (now - lastLoadedTime < CACHE_TTL_MS)) {
    return { ...cachedData, refresh_status: lastRefreshStatus };
  }

  // Attempt to read from disk
  try {
    const data = loadFromDisk();
    return { ...data, refresh_status: lastRefreshStatus };
  } catch (err) {
    console.warn('[McClellanFetcher] Initial disk load warning:', err.message);
    if (cachedData) return { ...cachedData, refresh_status: lastRefreshStatus };
    throw err;
  }
}

function getLastRefreshStatus() {
  return lastRefreshStatus;
}

module.exports = {
  getMcClellanData,
  validateMcClellanData,
  triggerPythonPipelineRefresh,
  detectPython,
  getLastRefreshStatus
};
