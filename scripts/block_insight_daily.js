#!/usr/bin/env node
/**
 * Module 4B 日更 (由 .github/workflows/block_insight_daily.yml 在 UTC 08:00 交割后调用)
 *
 *  1. 拉取 Greeks.live 近 72h 大宗成交，把其中已完整覆盖的 OI 日压成日聚合，并入
 *     data/block_flow_daily_BTC.json (长期保留)；
 *  2. 把其中 ≥ $30M 的冰山组 / 独立大单登记进 data/smart_money_BTC.json；
 *  3. 用 Deribit 标记价给未结算的结构记当天的盯市点，已全部交割的按交割价结算。
 * 每一步都是幂等的，一天多次运行只会补齐缺失的部分；某一步失败不影响其它步骤，全部失败才以非零退出。
 * 本地运行服务器时不要手动执行本脚本：服务器的补采写在 .local.json，避免与 Actions 的提交冲突。
 *
 * Producer heartbeat (data/job_health_block_insight_daily.json):
 *  - option_oi：workflow 传入 OPTION_OI_STEP_OUTCOME；success + 当天 OI 快照已存在 => 验证性成功，
 *    failure/skipped/未知 outcome 或档案缺当天 => failed。手工运行无 env 时只看档案。
 *  - block_trades / marks：各自尝试，endpoint 合法但窗口无成交也算一次成功检查；
 *    成功步骤的档案写入该步骤的 producerHealth，失败步骤的档案保留旧心跳不重写。
 * 非全 ok 时 job 为 partial/failed 并 exitCode=1，但成功产出的档案仍照常落盘提交。
 *
 * 用法: node scripts/block_insight_daily.js
 */

const fs = require('fs');
const BI = require('../server/block_insight');
const { fetchBlockTrades } = require('../server/data_fetcher');
const { fetchBookSummaryRows } = require('../server/option_marks');
const { analyzeBlockTrades } = require('../server/analytics_engine');
const oi = require('../server/option_oi_history');
const { beginJob, recordStep, finishJob, readJob } = require('../server/pipeline_health');

const JOB = 'block_insight_daily';

/** Previous file's embedded producer receipt, kept verbatim when its step failed. */
function priorProducerHealth(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.producerHealth && typeof j.producerHealth === 'object' ? j.producerHealth : null;
  } catch (err) {
    return null;
  }
}

function stepHealth(name) {
  const rec = readJob(JOB);
  const s = rec && rec.steps && rec.steps[name];
  return s ? {
    lastAttemptAt: s.lastAttemptAt,
    lastSuccessAt: s.lastSuccessAt,
    lastError: s.lastError,
    status: s.status
  } : null;
}

async function main() {
  beginJob(JOB);
  const now = Date.now();
  let daily = BI.readDailyFile();
  let registry = BI.readRegistryFile();
  const oiSnapshots = oi.readHistoryFile(oi.COMMITTED_FILE);
  const prevRegistryHealth = priorProducerHealth(BI.SMART_FILE);
  let tradesOk = false;
  let marksOk = false;

  // ---- option_oi: this script does NOT collect OI itself; it verifies the
  // archive the dedicated snapshot step produced. ----
  const oiOutcome = process.env.OPTION_OI_STEP_OUTCOME;
  const oiHasToday = oi.hasSnapshotForDay(oiSnapshots, now);
  const oiOk = (oiOutcome === 'success' || oiOutcome === undefined || oiOutcome === '') && oiHasToday;
  recordStep(JOB, 'option_oi', {
    ok: oiOk,
    verifiedSkip: oiOk,
    error: oiOk ? null : new Error(`option_oi outcome=${oiOutcome || 'manual-run'} archiveToday=${oiHasToday}`)
  });

  // ---- block_trades ----
  try {
    const trades = await fetchBlockTrades('BTC');
    if (!trades.length) {
      // A valid empty response is still a successful producer check — the
      // archive's health comes from the check receipt, not the last trade.
      console.log('[4B] block trades endpoint returned an empty window — verified, no new days');
      recordStep(JOB, 'block_trades', { ok: true, dataAsOf: null });
      tradesOk = true;
    } else {
      const coverage = Math.min(...trades.map(t => t.timestamp));
      const fresh = BI.aggregateTrades(trades, coverage, now);
      const complete = Object.fromEntries(Object.entries(fresh).filter(([, d]) => d.complete));
      daily = BI.mergeDaily(daily, complete);
      console.log(`[4B] daily aggregates: +${Object.keys(complete).length} complete days in window, ${Object.keys(daily).length} kept`);

      const spot = trades.reduce((a, t) => (t.timestamp > a.timestamp ? t : a)).index_price;
      const analysis = analyzeBlockTrades(trades, BI.STRUCTURE_MIN_NOTIONAL, 'all', spot, oiSnapshots);
      const res = BI.registerStructures(registry, analysis);
      registry = res.registry;
      console.log(`[4B] structures: +${res.added}, ${registry.length} tracked`);
      const latestDay = Object.keys(daily).sort().pop() || null;
      recordStep(JOB, 'block_trades', { ok: true, dataAsOf: latestDay });
      tradesOk = true;
    }
  } catch (err) {
    console.error('[4B] block trades step failed:', err.message);
    recordStep(JOB, 'block_trades', { ok: false, error: err });
  }

  // ---- marks ----
  // markStructures never throws for a missing mark/delivery — it returns the
  // structure unchanged. "No exception" is therefore not proof of coverage:
  // every open (!final) structure must hold a mark for TODAY's key, else the
  // step is failed even though some marks may have been written.
  let marksRan = false;
  try {
    const nowMs = Date.now();
    const key = oi.dayKey(nowMs);
    const [rows, deliveryByDate] = await Promise.all([fetchBookSummaryRows('BTC'), BI.fetchDeliveryPrices()]);
    const { markByInstrument, spot } = BI.marksFromBookSummary(rows);
    const res = BI.markStructures(registry, { markByInstrument, spot, deliveryByDate, nowMs });
    registry = res.registry;
    marksRan = true;
    const unmarked = registry.filter(s => !s.final && !s.marks.some(m => m.day === key));
    console.log(`[4B] marked ${res.marked}, settled ${res.settled}, unmarked open structures: ${unmarked.length}`);
    if (unmarked.length) {
      recordStep(JOB, 'marks', {
        ok: false,
        error: new Error(`${unmarked.length} open structure(s) missing mark/delivery for ${key} (e.g. ${unmarked[0].id})`)
      });
    } else {
      const latestMark = registry.reduce((m, s) => Math.max(m, ...(s.marks || []).map(x => x.ts || 0)), 0) || null;
      recordStep(JOB, 'marks', { ok: true, dataAsOf: latestMark ? new Date(latestMark).toISOString() : null });
      marksOk = true;
    }
  } catch (err) {
    console.error('[4B] mark-to-market step failed:', err.message);
    recordStep(JOB, 'marks', { ok: false, error: err });
  }

  // Persist only archives whose producer step verified this run; a failed
  // step leaves its file (and embedded receipt) byte-identical. The registry
  // is still written when the marks step ran but was incomplete — valid new
  // marks/structures are kept while the producer receipt stays at the old
  // verified run.
  if (tradesOk) BI.writeDailyFile(daily, BI.DAILY_FILE, stepHealth('block_trades'));
  if (tradesOk || marksRan) {
    BI.writeRegistryFile(registry, BI.SMART_FILE, marksOk ? stepHealth('marks') : prevRegistryHealth);
  }

  const job = finishJob(JOB);
  if (!job || job.status !== 'ok') {
    console.warn(`[4B] job finished ${job ? job.status : 'with heartbeat write failure'}: ${job && job.lastError}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[4B] failed:', err.message);
    try { finishJob(JOB); } catch (e) { /* heartbeat best effort */ }
    process.exit(1);
  });
}

module.exports = { main };
