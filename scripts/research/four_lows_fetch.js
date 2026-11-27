#!/usr/bin/env node
/**
 * 研究脚本：抓取「四低」(低成交量 / 低波动 / 低情绪 / 低持仓) 回测所需的长历史。
 *
 * 数据 (全部为公开接口，无需密钥)：
 *   - Coinbase Exchange BTC-USD 日线 OHLCV (2015-07-20 起)：价格、ATR、HV、现货成交量
 *   - Bitstamp BTC/USD 日线 (2011-08 起)：只用来补 2015-07 之前的历史最高价 (周期回撤)
 *   - Binance BTCUSDT 永续资金费 (2019-09 起，8h)：情绪
 *   - Wikimedia 英文维基 "Bitcoin" 词条日浏览量 (2015-07 起，仅人类访问)：关注度/情绪
 * 期货 OI、DVOL、30D ATM 取仓库已有档案 (data/leverage_norm.json、research/skew_dvol/dvol.json、
 * data/skew_history_BTC.json)，不在此重复抓取。
 *
 * 用法：node scripts/research/four_lows_fetch.js
 * 输出：research/four_lows/raw.json
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'research', 'four_lows');
const OUT = path.join(OUT_DIR, 'raw.json');
const DAY = 86400000;
const UA = { 'User-Agent': 'market-research-script/1.0' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = ms => new Date(ms).toISOString().slice(0, 10);

async function getJson(url, headers = UA) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      if (a >= 6) throw err;
      await sleep(Math.min(30000, 1000 * 2 ** a));
    }
  }
}

async function coinbaseDaily() {
  const rows = new Map();
  let start = Date.UTC(2015, 6, 20);
  const end = Date.now();
  while (start < end) {
    const stop = Math.min(end, start + 299 * DAY);
    const data = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(stop).toISOString()}`);
    for (const [t, low, high, open, close, volume] of data) {
      const day = iso(t * 1000);
      rows.set(day, { day, open, high, low, close, volume });
    }
    start = stop + DAY;
    await sleep(350);
  }
  // 当日未收盘的 K 线剔除
  const today = iso(Date.now());
  return [...rows.values()].filter(r => r.day < today).sort((a, b) => a.day.localeCompare(b.day));
}

async function bitstampDaily() {
  const rows = [];
  let start = Date.UTC(2011, 7, 18) / 1000;
  const end = Date.UTC(2015, 7, 1) / 1000;
  while (start < end) {
    const j = await getJson(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`);
    const ohlc = j.data.ohlc;
    if (!ohlc.length) break;
    for (const k of ohlc) rows.push({ day: iso(Number(k.timestamp) * 1000), high: Number(k.high), close: Number(k.close) });
    const last = Number(ohlc[ohlc.length - 1].timestamp);
    if (last <= start) break;
    start = last + 86400;
    await sleep(400);
  }
  return rows.filter(r => r.day < '2015-07-20');
}

async function binanceFunding() {
  const rows = [];
  let start = Date.UTC(2019, 8, 1);
  for (let guard = 0; guard < 40; guard++) {
    const data = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000&startTime=${start}`);
    if (!data.length) break;
    for (const r of data) rows.push({ t: r.fundingTime, rate: Number(r.fundingRate) });
    const last = data[data.length - 1].fundingTime;
    if (data.length < 1000) break;
    start = last + 1;
    await sleep(300);
  }
  // 按 UTC 日汇总为日均费率
  const byDay = new Map();
  for (const r of rows) {
    const d = iso(r.t);
    const e = byDay.get(d) || { day: d, sum: 0, n: 0 };
    e.sum += r.rate; e.n += 1;
    byDay.set(d, e);
  }
  return [...byDay.values()].map(e => ({ day: e.day, rate: e.sum / e.n })).sort((a, b) => a.day.localeCompare(b.day));
}

async function wikiViews() {
  const end = iso(Date.now() - DAY).replace(/-/g, '');
  const j = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Bitcoin/daily/20150701/${end}`);
  return j.items.map(i => ({ day: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`, views: i.views }));
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const [coinbase, bitstamp, funding, wiki] = await Promise.all([coinbaseDaily(), bitstampDaily(), binanceFunding(), wikiViews()]);
  const raw = { fetchedAt: new Date().toISOString(), coinbase, bitstamp, funding, wiki };
  fs.writeFileSync(OUT, JSON.stringify(raw));
  for (const k of ['coinbase', 'bitstamp', 'funding', 'wiki']) {
    const a = raw[k];
    console.log(`${k}: ${a.length} 天  ${a[0] && a[0].day} → ${a.length && a[a.length - 1].day}`);
  }
})().catch(err => { console.error(err); process.exit(1); });
