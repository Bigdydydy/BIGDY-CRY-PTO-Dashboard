#!/usr/bin/env node
/**
 * 研究脚本：重建 BTC 每日 30D 附近 25Δ 风险逆转 (RR = IV(25Δ Call) − IV(25Δ Put)) 与 DVOL 日线。
 *
 * 数据：
 *   - history.deribit.com 期权逐笔，每天只取 04:00–08:00 UTC 窗口 (与 08:00 交割快照口径对齐)；
 *     每个合约取窗口内成交 IV 的中位数，落盘为一行 jsonl (可断点续跑)。
 *   - Deribit get_volatility_index_data 1D (DVOL)。
 *
 * 用法：node scripts/research/skew_dvol_fetch.js [--from 2021-04-01] [--to 2026-11-24]
 * 输出：research/skew_dvol/daily_insts.jsonl、research/skew_dvol/dvol.json
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'research', 'skew_dvol');
// 分段并行时用 --part 区分输出文件 (daily_insts.<part>.jsonl)，分析脚本会读取全部 daily_insts*.jsonl
const PART = (() => { const i = process.argv.indexOf('--part'); return i >= 0 ? `.${process.argv[i + 1]}` : ''; })();
const INSTS_FILE = path.join(OUT_DIR, `daily_insts${PART}.jsonl`);
const DVOL_FILE = path.join(OUT_DIR, 'dvol.json');
const HIST = 'https://history.deribit.com/api/v2/public';
const LIVE = 'https://www.deribit.com/api/v2/public';
const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

async function getJson(url) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (err) {
      if (a >= 7) throw err;
      await sleep(Math.min(60000, 1000 * 2 ** a));
    }
  }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function fetchDay(day) {
  const start = Date.parse(`${day}T04:00:00Z`);
  const end = Date.parse(`${day}T08:00:00Z`);
  const ivs = {};
  let cursor = start;
  let lastIndex = null;
  let n = 0;
  const seen = new Set();
  for (let page = 0; page < 40; page++) {
    const r = await getJson(`${HIST}/get_last_trades_by_currency_and_time?currency=BTC&kind=option&start_timestamp=${cursor}&end_timestamp=${end - 1}&count=1000&sorting=asc`);
    const trades = r.trades || [];
    for (const t of trades) {
      if (seen.has(t.trade_id)) continue;
      seen.add(t.trade_id);
      n++;
      if (Number.isFinite(t.index_price)) lastIndex = t.index_price;
      if (!(Number.isFinite(t.iv) && t.iv > 1 && t.iv < 400)) continue;
      (ivs[t.instrument_name] ||= []).push(t.iv);
    }
    if (!r.has_more || !trades.length) break;
    const lastTs = trades[trades.length - 1].timestamp;
    if (!(lastTs > cursor)) break;
    cursor = lastTs;
    await sleep(120);
  }
  const insts = {};
  for (const [k, v] of Object.entries(ivs)) insts[k] = [Math.round(median(v) * 100) / 100, v.length];
  return { day, index: lastIndex, trades: n, insts };
}

async function fetchDvol() {
  const rows = new Map();
  let end = Date.now();
  const start = Date.parse('2021-03-01');
  for (let i = 0; i < 20; i++) {
    const r = await getJson(`${LIVE}/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`);
    for (const [ts, o, h, l, c] of r.data) rows.set(ts, { day: new Date(ts).toISOString().slice(0, 10), open: o, high: h, low: l, close: c });
    if (!r.continuation || r.continuation >= end) break;
    end = r.continuation;
    await sleep(200);
  }
  const data = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  fs.writeFileSync(DVOL_FILE, JSON.stringify({ source: 'deribit get_volatility_index_data 1D', data }));
  return data.length;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!process.argv.includes('--no-dvol')) console.log('DVOL rows:', await fetchDvol());
  const from = Date.parse(arg('--from', '2021-04-01'));
  const to = Date.parse(arg('--to', new Date(Date.now() - DAY).toISOString().slice(0, 10)));
  const done = new Set();
  if (fs.existsSync(INSTS_FILE)) {
    for (const line of fs.readFileSync(INSTS_FILE, 'utf8').split('\n')) {
      if (line.trim()) { try { done.add(JSON.parse(line).day); } catch (_) { /* 断行忽略 */ } }
    }
  }
  let k = 0;
  for (let ts = from; ts <= to; ts += DAY) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (done.has(day)) continue;
    const rec = await fetchDay(day);
    fs.appendFileSync(INSTS_FILE, JSON.stringify(rec) + '\n');
    if (++k % 50 === 0) console.log(day, 'trades', rec.trades, 'insts', Object.keys(rec.insts).length);
    await sleep(120);
  }
  console.log('done, new days:', k);
})().catch(err => { console.error(err); process.exit(1); });
