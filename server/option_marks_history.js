/**
 * 期权每日 mark 历史 —— 大宗结构 markout (成交后 +1 天 / +7 天 / 到期) 的估值基础
 *
 * Deribit 每一笔成交都带着当时的 mark_price (BTC) 与指数价，所以从全量期权逐笔里就能还原任一天的标记价，
 * 不必依赖当天在线采样。
 *
 * 口径：每天 08:00 UTC (Deribit 交割时点) 一份快照，标签为该 08:00 所在的 UTC 日期；
 *   每个合约取 (前一天 08:00, 当天 08:00] 内最后一笔成交上的 mark_price，并记下那笔成交的时间 (观测时滞) 与当时的指数价
 *   (估值时可用观测时的 mark 反推隐含波动率，再按收盘指数重新定价，消除时滞期间币价变动带来的误差)。
 *   当天没有成交的合约不记录，由使用方 (markAt) 往前回看并给出时滞，绝不静默填补。
 * 文件：data/option_marks_daily/<CUR>_YYYY-MM.json
 *   { currency, month, version, days: { 'YYYY-MM-DD': { closeTs, index, marks: { instrument: [markPrice, observedTs, indexAtObs] } } } }
 * 由 scripts/option_marks_history.js 生成 (首次回补到年初，之后 4B 日更扫最近 3 天)。
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./data_health_cache');

const DIR = path.join(__dirname, '..', 'data', 'option_marks_daily');
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLOSE_OFFSET_MS = 8 * HOUR_MS;

/** 成交时刻 -> 所属快照日 (该成交之后最近的 08:00 UTC 的日期) */
function closeDayOf(ts) {
  return new Date(ts - CLOSE_OFFSET_MS + DAY_MS - 1).toISOString().slice(0, 10);
}

function closeTsOf(day) {
  return Date.parse(`${day}T08:00:00Z`);
}

function monthFile(currency, month, dir = DIR) {
  return path.join(dir, `${currency.toUpperCase()}_${month}.json`);
}

function readMonth(currency, month, dir = DIR) {
  const file = monthFile(currency, month, dir);
  if (!fs.existsSync(file)) return { currency, month, version: 1, days: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || typeof j.days !== 'object') throw new Error(`${path.basename(file)} 格式非法`);
  return j;
}

/**
 * 把逐笔成交折算成每日快照 (只处理期权；同一合约同一天保留最晚的一笔)。
 * @returns {Object<string, {closeTs, index, indexTs, marks}>}
 */
function snapshotsFromTrades(trades) {
  const days = {};
  for (const t of trades || []) {
    const ts = Number(t.timestamp);
    const mark = Number(t.mark_price);
    if (!Number.isFinite(ts) || !(mark >= 0) || !/-\d+-[CP]$/.test(String(t.instrument_name || ''))) continue;
    const day = closeDayOf(ts);
    if (!days[day]) days[day] = { closeTs: closeTsOf(day), index: null, indexTs: 0, marks: {} };
    const d = days[day];
    const prev = d.marks[t.instrument_name];
    if (!prev || ts >= prev[1]) d.marks[t.instrument_name] = [mark, ts, Number(t.index_price) || null];
    if (Number(t.index_price) > 0 && ts >= d.indexTs) {
      d.index = Number(t.index_price);
      d.indexTs = ts;
    }
  }
  return days;
}

/**
 * 并入月度文件。同一天同一合约保留观测更晚的那笔 (增量扫描与回补可以任意重叠)。
 * @returns {{days: number, months: string[]}}
 */
function mergeSnapshots(currency, snapshots, { dir = DIR } = {}) {
  const byMonth = new Map();
  for (const [day, snap] of Object.entries(snapshots)) {
    const m = day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, {});
    byMonth.get(m)[day] = snap;
  }
  const months = [];
  let touched = 0;
  for (const [month, incoming] of [...byMonth.entries()].sort()) {
    const cur = readMonth(currency, month, dir);
    let changed = false;
    for (const [day, snap] of Object.entries(incoming)) {
      const d = cur.days[day] || { closeTs: snap.closeTs, index: null, indexTs: 0, marks: {} };
      for (const [inst, m] of Object.entries(snap.marks)) {
        const prev = d.marks[inst];
        if (!prev || m[1] > prev[1]) {
          d.marks[inst] = m;
          changed = true;
        }
      }
      if (snap.index && snap.indexTs >= (d.indexTs || 0) && (snap.index !== d.index || snap.indexTs !== d.indexTs)) {
        d.index = snap.index;
        d.indexTs = snap.indexTs;
        changed = true;
      }
      cur.days[day] = d;
      touched++;
    }
    if (!changed) continue;
    cur.days = Object.fromEntries(Object.entries(cur.days).sort());
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(monthFile(currency, month, dir), cur, 0);
    months.push(month);
  }
  return { days: touched, months };
}

/** 读取 [fromDay, toDay] 的快照 (含两端)，供估值批量使用 */
function loadRange(currency, fromDay, toDay, { dir = DIR } = {}) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const re = new RegExp(`^${currency.toUpperCase()}_(\\d{4}-\\d{2})\\.json$`);
  for (const f of fs.readdirSync(dir).sort()) {
    const m = (re.exec(f) || [])[1];
    if (!m || m < fromDay.slice(0, 7) || m > toDay.slice(0, 7)) continue;
    for (const [day, snap] of Object.entries(readMonth(currency, m, dir).days)) {
      if (day >= fromDay && day <= toDay) out[day] = snap;
    }
  }
  return out;
}

/**
 * 某合约在某快照日的 mark：当天没有观测时往前回看最多 maxStaleDays 天。
 * @returns {null|{mark: number, observedTs: number, indexAtObs: number|null, staleDays: number, index: number|null}}
 */
function markAt(history, instrument, day, { maxStaleDays = 3 } = {}) {
  let d = day;
  for (let k = 0; k <= maxStaleDays; k++) {
    const snap = history[d];
    const m = snap && snap.marks[instrument];
    if (m) return { mark: m[0], observedTs: m[1], indexAtObs: m[2] ?? null, staleDays: k, index: history[day]?.index ?? snap.index ?? null };
    d = new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  }
  return null;
}

module.exports = {
  DIR,
  closeDayOf,
  closeTsOf,
  monthFile,
  readMonth,
  snapshotsFromTrades,
  mergeSnapshots,
  loadRange,
  markAt
};
