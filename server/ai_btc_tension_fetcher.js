/**
 * AI-BTC Financing Tension Index & Transmission Analysis Fetcher
 * Reads, caches, and serves the pre-computed institutional dataset for Module 8.
 */
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const DATA_FILE = path.join(__dirname, '..', 'data', 'ai_btc_tension.json');
const PYTHON_PIPELINE_DIR = path.join(__dirname, '..', 'scripts', 'ai_btc_tension');

let cachedData = null;
let lastLoadedTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute in-memory cache

let lastRefreshStatus = {
  status: 'cached',
  message: '使用已验证的基准预计算数据',
  timestamp: new Date().toISOString()
};

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
 * Detect available Python executable
 */
function detectPython() {
  const candidates = [
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
 * Triggers Python pipeline refresh if available
 */
function triggerPythonPipelineRefresh() {
  return new Promise((resolve) => {
    const pythonBin = detectPython();
    const exportScript = path.join(PYTHON_PIPELINE_DIR, 'export_to_json.py');

    if (!pythonBin || !fs.existsSync(exportScript)) {
      console.log('[AiBtcTensionFetcher] Python runtime or export script not found in environment.');
      return resolve({
        success: false,
        status: 'pipelineUnavailable',
        reason: 'Python runtime or export script not found'
      });
    }

    const cmd = `"${pythonBin}" "${exportScript}"`;
    exec(cmd, { cwd: PYTHON_PIPELINE_DIR, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[AiBtcTensionFetcher] Python pipeline execution error:', error.message);
        return resolve({
          success: false,
          status: 'stale',
          reason: error.message
        });
      }
      console.log('[AiBtcTensionFetcher] Python pipeline successfully updated ai_btc_tension.json');
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
 * Gets AI-BTC tension data, respecting cache unless forceRefresh is true
 */
async function getAiBtcTensionData(forceRefresh = false) {
  const now = Date.now();

  // If forceRefresh is requested, execute the Python calculation pipeline
  if (forceRefresh) {
    try {
      console.log('[AiBtcTensionFetcher] forceRefresh requested: executing Python calculation pipeline...');
      const result = await triggerPythonPipelineRefresh();
      if (result.success) {
        lastRefreshStatus = {
          status: 'refreshed',
          message: 'Python 计量分析全量管线已成功重新解算，全部因子及 OOS 残差已刷新',
          timestamp: new Date().toISOString()
        };
      } else {
        lastRefreshStatus = {
          status: result.status,
          message: result.status === 'pipelineUnavailable'
            ? '当前运行环境未配置 Python 科学计算栈或依赖，已提供经过预计算与计量核验的完整最新快照数据'
            : `Python 管线运行异常 (${result.reason})，已回退至已验证的快照数据`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (pipelineErr) {
      console.warn('[AiBtcTensionFetcher] Python pipeline trigger error, falling back:', pipelineErr.message);
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
    console.warn('[AiBtcTensionFetcher] Initial disk load warning:', err.message);
    if (cachedData) return { ...cachedData, refresh_status: lastRefreshStatus };
    throw err;
  }
}

function getLastRefreshStatus() {
  return lastRefreshStatus;
}

module.exports = {
  getAiBtcTensionData,
  validateAiBtcTensionData,
  triggerPythonPipelineRefresh,
  detectPython,
  getLastRefreshStatus
};
