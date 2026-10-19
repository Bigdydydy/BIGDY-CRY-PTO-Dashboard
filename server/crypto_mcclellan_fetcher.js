/**
 * Crypto McClellan Oscillator Fetcher (Core Top 100 vs On-chain Meme)
 * Reads, caches, and serves the pre-computed market breadth dataset for Module 1-B.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth } = require('./data_health_cache');

const DATA_FILE = path.join(__dirname, '..', 'data', 'crypto_mcclellan.json');
const PYTHON_PIPELINE_DIR = path.join(__dirname, '..', 'scripts', 'crypto_mcclellan');
const REQUIRED_IDS = ['mcclellan_core', 'mcclellan_frontier'];
const ANCILLARY_IDS = ['mcclellan_anchor'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Round-trip the ISO day: Date.parse rolls nonexistent dates like Feb 30
// over — reject those.
const validDateStr = d => typeof d === 'string' && DATE_RE.test(d) && !isNaN(Date.parse(d))
  && new Date(d).toISOString().slice(0, 10) === d;

let cachedData = null;
let lastLoadedTime = 0;
let diskSeeded = false;
let pipelineInflight = null;
const CACHE_TTL_MS = 60 * 1000; // 1 minute in-memory cache

let lastRefreshStatus = {
  status: 'cached',
  message: '使用已验证的基准预计算数据',
  timestamp: new Date().toISOString()
};

/** Latest series-row date whose field holds a non-null finite value. */
function latestNonNullDate(series, field) {
  let max = null;
  for (const r of series) {
    const v = r && r[field];
    if (v !== null && v !== undefined && Number.isFinite(Number(v)) && validDateStr(r.date)) {
      if (max === null || r.date > max) max = r.date;
    }
  }
  return max;
}

/**
 * Validates the core schema of the McClellan payload.
 * ready must be a real boolean on each track; ready=false is legitimate
 * oscillator warmup (oscillator:null) marked explicitly, not malformed —
 * but it is NOT licence for an arbitrary object: every track still needs a
 * valid non-future date and a real non-null *_n source row behind it. The
 * series must always be nonempty, date-valid and ascending. Finite zero is
 * a valid value.
 */
function validateMcClellanData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('McClellan payload must be an object');
  }
  if (!data.metadata || !data.current || !data.series || !Array.isArray(data.series)) {
    throw new Error('McClellan payload is missing metadata, current, or series');
  }
  // The series is required regardless of readiness — warmup does not shrink it.
  if (!data.series.length) throw new Error('McClellan series 为空');
  for (let i = 0; i < data.series.length; i++) {
    if (!validDateStr(data.series[i] && data.series[i].date)) {
      throw new Error(`McClellan series[${i}] date 非法`);
    }
    if (i > 0 && data.series[i].date <= data.series[i - 1].date) {
      throw new Error('McClellan series 非日期升序');
    }
  }
  const { core, frontier } = data.current;
  if (!core || typeof core !== 'object' || !frontier || typeof frontier !== 'object') {
    throw new Error('McClellan payload current state is missing core or frontier track');
  }
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const today = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 10);
  for (const [name, track, nField] of [['core', core, 'core_n'], ['frontier', frontier, 'frontier_n']]) {
    if (typeof track.ready !== 'boolean') throw new Error(`McClellan ${name}.ready 非布尔值`);
    if (!validDateStr(track.date)) throw new Error(`McClellan ${name}.date 非法`);
    if (track.date > today) throw new Error(`McClellan ${name}.date 在未来`);
    if (track.ready === true) {
      if (!fin(track.oscillator) || !fin(track.summation)) {
        throw new Error(`McClellan ${name} ready 但 oscillator/summation 非有限数`);
      }
    } else {
      // Warmup: breadth exists but the oscillator window has not filled yet.
      track.warmup = true;
      if (track.oscillator !== null && track.oscillator !== undefined && !fin(track.oscillator)) {
        throw new Error(`McClellan ${name} warmup oscillator 非法`);
      }
    }
    // Every track needs a real non-null *_n source row behind it, and its
    // date must not postdate that row.
    const newest = latestNonNullDate(data.series, nField);
    if (!newest) throw new Error(`McClellan ${name} 缺少 ${nField} 源行`);
    if (track.date > newest) {
      throw new Error(`McClellan ${name}.date ${track.date} 晚于最新源行 ${newest}`);
    }
  }
  return true;
}

/**
 * Reading a snapshot is not new collection. Seeds per-track clocks once:
 * dataAsOf from each track's own date, lastSuccessAt preferring persisted
 * dataHealth, else the producer's metadata.generated_at (never reader-now).
 * The dex-volume anchor is ancillary: missing → UNKNOWN, never blocking.
 */
function seedSnapshotOnce(parsed) {
  if (diskSeeded || !parsed) return;
  diskSeeded = true;
  const gen = parsed.metadata?.generated_at || null;
  seedCachedHealth(parsed, 'mcclellan_core', {
    dataAsOf: parsed.current?.core?.date || null,
    lastSuccessAt: gen
  });
  seedCachedHealth(parsed, 'mcclellan_frontier', {
    dataAsOf: parsed.current?.frontier?.date || null,
    lastSuccessAt: gen
  });
  const anchor = latestNonNullDate(parsed.series, 'dex_volume');
  if (anchor) {
    seedCachedHealth(parsed, 'mcclellan_anchor', { dataAsOf: anchor, lastSuccessAt: gen });
  }
}

/**
 * Detect available Python executable
 */
function detectPython() {
  const candidates = [
    path.join(PYTHON_PIPELINE_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(PYTHON_PIPELINE_DIR, '.venv', 'bin', 'python'),
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
  // Seed after validation; seedSource no-ops on existing records, so a disk
  // load can never erase a recorded pipeline failure.
  seedSnapshotOnce(parsed);
  cachedData = parsed;
  lastLoadedTime = Date.now();
  return cachedData;
}

/**
 * Triggers Python pipeline refresh if available
 */
function triggerPythonPipelineRefresh() {
  if (pipelineInflight) return pipelineInflight;
  pipelineInflight = runPythonPipeline().finally(() => { pipelineInflight = null; });
  return pipelineInflight;
}

function recordPipelineResult(ok, err) {
  const ids = [...REQUIRED_IDS, ...ANCILLARY_IDS];
  for (const id of ids) {
    if (ok) continue; // success clocks are recorded from the reloaded payload below
    else recordFailure(id, err || new Error('pipeline failed'));
  }
}

/** Content digest of the current artifact — an unchanged file after a
 * --skip-if-final run is NOT a new collection. */
function fileDigest() {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(DATA_FILE)).digest('hex');
  } catch (e) {
    return null;
  }
}

/** Success clocks are the PRODUCER's clock — metadata.generated_at — never
 * the reader's now. */
function recordPipelineSuccess(parsed) {
  const genMs = Date.parse(parsed.metadata?.generated_at || '');
  const clock = Number.isFinite(genMs) ? { now: genMs } : {};
  recordSuccess('mcclellan_core', {
    dataAsOf: parsed.current?.core?.date || null, asOfKind: 'source', source: 'python-pipeline',
    issues: parsed.current?.core?.warmup ? ['core warmup'] : [],
    ...clock
  });
  recordSuccess('mcclellan_frontier', {
    dataAsOf: parsed.current?.frontier?.date || null, asOfKind: 'source', source: 'python-pipeline',
    issues: parsed.current?.frontier?.warmup ? ['frontier warmup'] : [],
    ...clock
  });
  const anchor = latestNonNullDate(parsed.series, 'dex_volume');
  if (anchor) {
    recordSuccess('mcclellan_anchor', {
      dataAsOf: anchor, asOfKind: 'source', source: 'python-pipeline', ...clock
    });
  }
}

function runPythonPipeline() {
  // Load + seed the existing artifact BEFORE recording the attempt: a cold
  // run that fails must not leave the last good disk clocks unseeded
  // (seedSource never overwrites a recorded failure).
  try { if (!cachedData) loadFromDisk(); } catch (e) { /* no valid artifact yet */ }
  const beforeDigest = fileDigest();
  for (const id of [...REQUIRED_IDS, ...ANCILLARY_IDS]) recordAttempt(id, { now: Date.now() });
  return new Promise((resolve) => {
    const pythonBin = detectPython();
    const exportScript = path.join(PYTHON_PIPELINE_DIR, 'export_to_json.py');

    if (!pythonBin || !fs.existsSync(exportScript)) {
      console.log('[McClellanFetcher] Python runtime or export script not found in environment.');
      recordPipelineResult(false, new Error('Python runtime or export script not found'));
      return resolve({
        success: false,
        status: 'pipelineUnavailable',
        reason: 'Python runtime or export script not found'
      });
    }

    // --skip-if-final: a manual refresh never overwrites a finalized post-close snapshot
    const cmd = `"${pythonBin}" "${exportScript}" --skip-if-final`;
    // Collection waits out CoinGecko / GeckoTerminal rate limits, so allow a few minutes
    exec(cmd, { cwd: PYTHON_PIPELINE_DIR, timeout: 240000 }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[McClellanFetcher] Python pipeline execution error:', error.message);
        recordPipelineResult(false, error);
        return resolve({
          success: false,
          status: 'stale',
          reason: error.message
        });
      }
      try {
        const unchanged = beforeDigest !== null && fileDigest() === beforeDigest;
        const parsed = loadFromDisk();
        if (unchanged) {
          // --skip-if-final exit 0 is not a new collection: keep the old
          // clocks and any recorded error state untouched.
          console.log('[McClellanFetcher] Pipeline exit 0 but artifact unchanged (skip-if-final); keeping prior clocks.');
          return resolve({
            success: true,
            status: 'unchanged',
            reason: 'artifact unchanged (skip-if-final)'
          });
        }
        console.log('[McClellanFetcher] Python pipeline successfully updated crypto_mcclellan.json');
        recordPipelineSuccess(parsed);
        resolve({
          success: true,
          status: 'refreshed'
        });
      } catch (e) {
        recordPipelineResult(false, e);
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
      if (result.success && result.status === 'unchanged') {
        lastRefreshStatus = {
          status: 'unchanged',
          message: '当日终版已定稿（skip-if-final），未重新采集，沿用现有快照时钟',
          timestamp: new Date().toISOString()
        };
      } else if (result.success) {
        lastRefreshStatus = {
          status: 'refreshed',
          message: '麦克莱伦市场宽度管线已重新采集并解算',
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
    return withDataHealth({ ...cachedData, refresh_status: lastRefreshStatus }, REQUIRED_IDS, ANCILLARY_IDS);
  }

  // Attempt to read from disk
  try {
    const data = loadFromDisk();
    return withDataHealth({ ...data, refresh_status: lastRefreshStatus }, REQUIRED_IDS, ANCILLARY_IDS);
  } catch (err) {
    console.warn('[McClellanFetcher] Initial disk load warning:', err.message);
    if (cachedData) return withDataHealth({ ...cachedData, refresh_status: lastRefreshStatus }, REQUIRED_IDS, ANCILLARY_IDS);
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
