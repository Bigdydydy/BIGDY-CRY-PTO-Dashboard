/**
 * 币安 BTCUSDT (U 本位永续 / 现货) K线，尽量不碰会被封 IP 的 REST 接口:
 *
 *   1. 已收盘的历史 → data.binance.vision 官方K线档案 (CDN 上的日/月 zip，与 REST 同一份数据，
 *      发布后不再变化；不走 API 限频，418 封禁对它无效)。当天的文件次日才发布。
 *   2. 进行中的K线与当天新收盘的K线 → 币安 WebSocket K线流 (行情流不计入 REST 权重)。
 *   3. 当天更早的K线 (服务启动前、档案尚未发布) → REST 兜底，带熔断：一旦 418/429/403/451，
 *      按 Retry-After (或默认冷却时间) 停止访问该主机，避免越封越久。
 *
 * K线统一为 { t: 开盘毫秒, o, h, l, c, v: USDT 成交额 }。
 */

const zlib = require('zlib');
const { fetchWithTimeout } = require('./http_client');

const MARKETS = {
  perp: {
    archive: 'https://data.binance.vision/data/futures/um',
    rest: ['https://fapi.binance.com/fapi/v1/klines'],
    // 2025 年起 U 本位合约行情流改为 /market 路由，旧的 /stream 路径不再推送 K 线
    ws: 'wss://fstream.binance.com/market/stream'
  },
  spot: {
    archive: 'https://data.binance.vision/data/spot',
    rest: ['https://data-api.binance.vision/api/v3/klines', 'https://api.binance.com/api/v3/klines'],
    ws: 'wss://data-stream.binance.vision/stream'
  }
};
const INTERVALS = ['15m', '1h', '4h', '1d', '1w'];
const DAY_MS = 8.64e7;

// ---------------------------------------------------------------------------
// 1. 官方档案 (data.binance.vision)
// ---------------------------------------------------------------------------

/** 解出单文件 zip 的内容 (兼容本地头里不写压缩大小、改用数据描述符的情况) */
function unzipSingle(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是 zip 文件');
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  let csize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if ((flags & 0x08) || csize === 0) {
    // 从中央目录读压缩大小: 末尾 EOCD (0x06054b50) → 中央目录偏移 → 记录里的压缩大小 (+20)
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('zip 缺少中央目录');
    const cdOffset = buf.readUInt32LE(eocd + 16);
    csize = buf.readUInt32LE(cdOffset + 20);
  }
  const data = buf.subarray(start, start + csize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方式 ${method}`);
}

/** 解析档案 CSV；合约文件带表头，现货文件无表头且 2025 年起时间戳为微秒 */
function parseKlineCsv(text) {
  const bars = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('open_time')) continue;
    const c = line.split(',');
    let t = Number(c[0]);
    if (t > 1e14) t = Math.floor(t / 1000);
    const bar = { t, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[7] };
    if (Number.isFinite(bar.t) && Number.isFinite(bar.c)) bars.push(bar);
  }
  return bars;
}

const archiveCache = new Map(); // url → bars (档案发布后不变，进程内永久缓存)
const archiveMissing = new Map(); // url → 记录 404 的时间 (未发布的文件 1 小时内不重试)

async function fetchArchiveFile(url) {
  if (archiveCache.has(url)) return archiveCache.get(url);
  const missAt = archiveMissing.get(url);
  if (missAt && Date.now() - missAt < 3.6e6) return null;
  const res = await fetchWithTimeout(url, { timeout: 20000, retries: 1 });
  if (res.status === 404) {
    archiveMissing.set(url, Date.now());
    return null;
  }
  if (!res.ok) throw new Error(`档案 HTTP ${res.status}`);
  const bars = parseKlineCsv(unzipSingle(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  archiveCache.set(url, bars);
  return bars;
}

const ymd = d => d.toISOString().slice(0, 10);
const ym = d => d.toISOString().slice(0, 7);

/**
 * 取 [fromMs, 今天 00:00 UTC) 内已归档的K线：整月用月度文件，当月 (以及月度文件尚未发布的上月) 用日文件。
 * 周线没有日文件，当月的周线留给实时流 / REST。
 */
/** 并发上限为 limit 的 map (档案文件多为几 KB，串行下载首次构建周线要 70 个文件) */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchArchiveBars(market, interval, fromMs) {
  const base = `${MARKETS[market].archive}`;
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const now = new Date(todayStart);
  const curMonth = ym(now);
  const months = [];
  const cursor = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1));
  while (ym(cursor) < curMonth) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const dailyUrls = (fromDay, toDay) => {
    if (interval === '1w') return []; // 周线没有日文件
    const urls = [];
    for (let d = fromDay; d < toDay; d += DAY_MS) {
      if (d + DAY_MS <= fromMs) continue;
      urls.push(`${base}/daily/klines/BTCUSDT/${interval}/BTCUSDT-${interval}-${ymd(new Date(d))}.zip`);
    }
    return urls;
  };
  const monthly = await mapLimit(months, 6, m =>
    fetchArchiveFile(`${base}/monthly/klines/BTCUSDT/${interval}/BTCUSDT-${interval}-${ym(m)}.zip`));
  const daily = [];
  months.forEach((m, i) => {
    if (monthly[i]) return;
    // 月初几天上月的月度文件还没生成，改拉日文件
    const next = new Date(m);
    next.setUTCMonth(next.getUTCMonth() + 1);
    daily.push(...dailyUrls(m.getTime(), next.getTime()));
  });
  daily.push(...dailyUrls(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), todayStart));
  const dailyBars = await mapLimit(daily, 6, fetchArchiveFile);
  const out = [];
  for (const bars of monthly.concat(dailyBars)) if (bars) out.push(...bars);
  return out.filter(b => b.t >= fromMs).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// 2. REST 兜底 + 熔断
// ---------------------------------------------------------------------------
const hostCooldown = new Map(); // host → 恢复访问的时间戳

function coolDown(host, res) {
  const retryAfter = Number(res.headers.get('retry-after'));
  const defaults = { 418: 30 * 60e3, 429: 2 * 60e3, 403: 6 * 3.6e6, 451: 6 * 3.6e6 };
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : defaults[res.status];
  hostCooldown.set(host, Date.now() + ms);
  console.warn(`[BinanceFeed] ${host} HTTP ${res.status}，暂停访问 ${Math.round(ms / 60e3)} 分钟`);
}

/** 带熔断的币安 REST GET (盘口深度、24h 统计等)，冷却中直接报错而不发请求 */
async function getBinanceJson(url) {
  const host = new URL(url).host;
  const until = hostCooldown.get(host);
  if (until && Date.now() < until) throw new Error(`${host} 熔断中 (${Math.ceil((until - Date.now()) / 60e3)} 分钟后重试)`);
  const res = await fetchWithTimeout(url, { timeout: 10000, retries: 0 });
  if ([418, 429, 403, 451].includes(res.status)) {
    coolDown(host, res);
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchRestBars(market, interval, limit = 300) {
  const errors = [];
  for (const url of MARKETS[market].rest) {
    const host = new URL(url).host;
    const until = hostCooldown.get(host);
    if (until && Date.now() < until) {
      errors.push(`${host}: 熔断中 (${Math.ceil((until - Date.now()) / 60e3)} 分钟后重试)`);
      continue;
    }
    try {
      const res = await fetchWithTimeout(`${url}?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, { timeout: 10000, retries: 0 });
      if ([418, 429, 403, 451].includes(res.status)) {
        coolDown(host, res);
        errors.push(`${host}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
      const rows = await res.json();
      return rows.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
    }
  }
  throw new Error(errors.join('；'));
}

// ---------------------------------------------------------------------------
// 3. WebSocket K线流 (进程内常驻，断线指数退避重连)
// ---------------------------------------------------------------------------
const live = { perp: {}, spot: {} }; // market → interval → Map(t → bar)
const streamState = { perp: { connected: false, lastMsgAt: 0 }, spot: { connected: false, lastMsgAt: 0 } };
const KEEP_LIVE = 400;

function openStream(market, attempt = 0) {
  if (typeof WebSocket !== 'function') return;
  const streams = INTERVALS.map(i => `btcusdt@kline_${i}`).join('/');
  let ws;
  try {
    ws = new WebSocket(`${MARKETS[market].ws}?streams=${streams}`);
  } catch (e) {
    setTimeout(() => openStream(market, attempt + 1), Math.min(300e3, 5e3 * 2 ** attempt));
    return;
  }
  ws.onopen = () => {
    streamState[market].connected = true;
    attempt = 0;
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; }
    const k = msg && msg.data && msg.data.k;
    if (!k) return;
    streamState[market].lastMsgAt = Date.now();
    const map = live[market][k.i] || (live[market][k.i] = new Map());
    map.set(k.t, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q, closed: !!k.x });
    if (map.size > KEEP_LIVE) map.delete(map.keys().next().value);
  };
  ws.onclose = () => {
    streamState[market].connected = false;
    // 币安每 24 小时主动断开一次；异常断线时退避重连
    setTimeout(() => openStream(market, attempt + 1), Math.min(300e3, 3e3 * 2 ** Math.min(attempt, 6)));
  };
  ws.onerror = () => {};
}

let streamsStarted = false;
function ensureStreams() {
  if (streamsStarted || process.env.FLOW_FORCE_NO_STREAMS) return;
  streamsStarted = true;
  openStream('perp');
  openStream('spot');
}

/** 实时流自连上以来收到的K线 (含进行中的一根)，升序 */
function getStreamBars(market, interval) {
  const map = live[market][interval];
  return map ? [...map.values()].sort((a, b) => a.t - b.t) : [];
}

function getStreamStatus() {
  return {
    perp: { ...streamState.perp },
    spot: { ...streamState.spot },
    cooldown: Object.fromEntries([...hostCooldown.entries()].filter(([, t]) => t > Date.now()).map(([h, t]) => [h, new Date(t).toISOString()]))
  };
}

module.exports = {
  fetchArchiveBars,
  fetchRestBars,
  getBinanceJson,
  ensureStreams,
  getStreamBars,
  getStreamStatus,
  unzipSingle,
  parseKlineCsv
};
