/**
 * 美债曲线 / Fed 净流动性的备用数据源 —— 全部取自数据的原始发布方，不需要 key：
 *
 *   DGS1 / DGS10   ← 美国财政部每日 par yield curve。H.15 的 CMT 收益率就取自这张表，
 *                    数值一致；财政部当天收盘后即发布，通常比 FRED 早一天。
 *   RRPONTSYD      ← 纽约联储 Markets API 的隔夜逆回购操作结果（美元 → 十亿美元）。
 *                    当天午后公布，FRED 次日才更新。
 *   WALCL          ← 美联储 H.4.1 数据下载：RESPPMA_N.WW（总资产，周三时点，百万美元）
 *   WTREGEN        ← 美联储 H.4.1 数据下载：RESPPLLDT_XAW_N.WW（TGA 周均值，百万美元）
 *
 * 每个函数只返回近期窗口（几个月），输出单位与 FRED 同一序列一致；
 * 完整历史仍由 FRED 或上一版快照承担。任何坏行、坏表头、未来日期都整体抛错，
 * 由调用方决定降级，绝不把残缺数据当作成功返回。
 *
 * fetchFn 由调用方注入（macro_fetcher 传入 http_client.fetchWithTimeout），便于离线测试。
 */

const MAX_FUTURE_MS = 5 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const H41_SERIES = Object.freeze({
  // 包哈希来自 federalreserve.gov/datadownload/Choose.aspx?rel=H41；若美联储重排数据包，
  // 这里会因找不到序列代码而抛错（备用源失效，不会读错列）。
  WALCL: { code: 'RESPPMA_N.WW', pkg: 'ccfdc0c8cb86be87af324da79a6f8826' },
  WTREGEN: { code: 'RESPPLLDT_XAW_N.WW', pkg: 'f52e72511be65e16f71d4f5858951312' }
});

const validDateStr = d => typeof d === 'string' && DATE_RE.test(d) && !isNaN(Date.parse(d))
  && new Date(d).toISOString().slice(0, 10) === d;

/** Quote-aware CSV line split (H.4.1 descriptions contain commas inside quotes). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function checkDate(label, date, nowMs) {
  if (!validDateStr(date)) throw new Error(`${label}: invalid date "${date}"`);
  if (Date.parse(date) > nowMs + MAX_FUTURE_MS) throw new Error(`${label}: future date ${date}`);
}

function checkNum(label, s) {
  if (!STRICT_NUM_RE.test(s)) throw new Error(`${label}: non-numeric value "${s}"`);
  return parseFloat(s);
}

/** Rebuild a Map in ascending date order. */
function sortedMap(map) {
  return new Map([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** GET text; the Fed DDP occasionally answers 200 with an empty body — retry those. */
async function getText(fetchFn, url, label, { emptyRetries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchFn(url, { headers: { 'User-Agent': UA }, timeout: 12000, retries: 1 });
    if (!resp.ok) throw new Error(`${label} HTTP ${resp.status}`);
    const text = await resp.text();
    if (String(text || '').trim()) return text;
    if (attempt >= emptyRetries) throw new Error(`${label}: empty response body`);
    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
}

/** 财政部 par yield curve 某一年的 CSV → { DGS1: Map, DGS10: Map } */
function parseTreasuryYieldCsv(text, nowMs = Date.now()) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0] || '').map(h => h.toLowerCase());
  const dateCol = header.indexOf('date');
  const col1y = header.indexOf('1 yr');
  const col10y = header.indexOf('10 yr');
  if (dateCol < 0 || col1y < 0 || col10y < 0) {
    throw new Error(`Treasury yields: unexpected CSV header "${lines[0]}"`);
  }
  const out = { DGS1: new Map(), DGS10: new Map() };
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const parts = splitCsvLine(lines[i]);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(parts[dateCol] || '');
    if (!m) throw new Error(`Treasury yields: invalid date "${parts[dateCol]}"`);
    const date = `${m[3]}-${m[1]}-${m[2]}`;
    checkDate('Treasury yields', date, nowMs);
    for (const [id, col] of [['DGS1', col1y], ['DGS10', col10y]]) {
      const v = parts[col];
      if (v === undefined || v === '' || /^n\/?a$/i.test(v)) continue; // 该期限当天未报价
      if (out[id].has(date)) throw new Error(`Treasury yields: duplicate date ${date}`);
      out[id].set(date, checkNum('Treasury yields', v));
    }
  }
  if (!out.DGS1.size || !out.DGS10.size) throw new Error('Treasury yields: no data rows parsed');
  return { DGS1: sortedMap(out.DGS1), DGS10: sortedMap(out.DGS10) };
}

function treasuryYieldUrl(year) {
  return 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
    + `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
}

/** 当年（1-2 月时连同上一年）财政部收益率曲线 → { DGS1, DGS10 } */
async function fetchTreasuryYields(fetchFn, { now = Date.now() } = {}) {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const years = d.getUTCMonth() < 2 ? [year - 1, year] : [year];
  const out = { DGS1: new Map(), DGS10: new Map() };
  for (const y of years) {
    let parsed;
    try {
      parsed = parseTreasuryYieldCsv(await getText(fetchFn, treasuryYieldUrl(y), 'Treasury yields'), now);
    } catch (err) {
      // 年初几天当年文件可能还没有数据行：有上一年数据时不算失败
      if (y === year && years.length > 1 && out.DGS1.size) continue;
      throw err;
    }
    for (const id of ['DGS1', 'DGS10']) for (const [k, v] of parsed[id]) out[id].set(k, v);
  }
  return { DGS1: sortedMap(out.DGS1), DGS10: sortedMap(out.DGS10) };
}

/** 纽约联储逆回购操作 JSON → Map(date → 十亿美元)，同日多场操作求和 */
function parseNyFedRrp(json, nowMs = Date.now()) {
  const ops = json && json.repo && json.repo.operations;
  if (!Array.isArray(ops)) throw new Error('NY Fed RRP: operations array missing');
  const sums = new Map();
  for (const op of ops) {
    if (!op || op.operationType !== 'Reverse Repo') continue;
    const date = op.operationDate;
    checkDate('NY Fed RRP', date, nowMs);
    const amt = op.totalAmtAccepted;
    if (typeof amt !== 'number' || !Number.isFinite(amt) || amt < 0) {
      throw new Error(`NY Fed RRP: invalid totalAmtAccepted ${JSON.stringify(amt)} on ${date}`);
    }
    sums.set(date, (sums.get(date) || 0) + amt);
  }
  if (!sums.size) throw new Error('NY Fed RRP: no reverse repo operations in window');
  const out = new Map();
  for (const [d, usd] of sums) out.set(d, Number((usd / 1e9).toFixed(3)));
  return sortedMap(out);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchNyFedRrp(fetchFn, { now = Date.now(), lookbackDays = 120 } = {}) {
  const url = 'https://markets.newyorkfed.org/api/rp/reverserepo/propositions/search.json'
    + `?startDate=${isoDay(now - lookbackDays * 86400000)}&endDate=${isoDay(now)}`;
  const resp = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000, retries: 1 });
  if (!resp.ok) throw new Error(`NY Fed RRP HTTP ${resp.status}`);
  return parseNyFedRrp(await resp.json(), now);
}

/** H.4.1 数据下载包 CSV → 指定序列的 Map(date → 百万美元) */
function parseH41Csv(text, code, nowMs = Date.now()) {
  const label = `H.4.1 ${code}`;
  const rows = String(text || '').trim().split(/\r?\n/).map(splitCsvLine);
  const headRows = [];
  let i = 0;
  while (i < rows.length && !validDateStr(rows[i][0])) headRows.push(rows[i++]);
  const idRow = headRows.find(r => /^time period/i.test(r[0])) || headRows.find(r => /^unique identifier/i.test(r[0]));
  if (!idRow) throw new Error(`${label}: identifier row missing (not a DDP CSV?)`);
  const col = idRow.findIndex((c, k) => k > 0 && (c === code || c.endsWith('/' + code)));
  if (col < 0) throw new Error(`${label}: series not found in package`);
  const multRow = headRows.find(r => /^multiplier/i.test(r[0]));
  if (!multRow || multRow[col] !== '1000000') {
    throw new Error(`${label}: unexpected multiplier "${multRow && multRow[col]}"`);
  }
  const out = new Map();
  let last = '';
  for (; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    checkDate(label, r[0], nowMs);
    if (r[0] <= last) throw new Error(`${label}: non-ascending dates`);
    last = r[0];
    const v = r[col];
    if (v === undefined || v === '' || /^(nd|na)$/i.test(v)) continue;
    out.set(r[0], checkNum(label, v));
  }
  if (!out.size) throw new Error(`${label}: no data rows parsed`);
  return out;
}

async function fetchH41Series(fetchFn, id, { lastObs = 16, now = Date.now() } = {}) {
  const spec = H41_SERIES[id];
  if (!spec) throw new Error(`H.4.1: no backup mapping for ${id}`);
  const url = `https://www.federalreserve.gov/datadownload/Output.aspx?rel=H41&series=${spec.pkg}`
    + `&lastobs=${lastObs}&from=&to=&filetype=csv&label=include&layout=seriescolumn`;
  return parseH41Csv(await getText(fetchFn, url, `H.4.1 ${spec.code}`), spec.code, now);
}

module.exports = {
  fetchTreasuryYields,
  fetchNyFedRrp,
  fetchH41Series,
  parseTreasuryYieldCsv,
  parseNyFedRrp,
  parseH41Csv,
  splitCsvLine,
  H41_SERIES
};
