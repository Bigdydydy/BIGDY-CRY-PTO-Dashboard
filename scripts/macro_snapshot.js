#!/usr/bin/env node
/**
 * Module 1 数据快照：重建宏观图与优先股数据集并写回 data/。
 * 由 GitHub Actions 定时运行并提交，线上实例冷启动时从 GitHub raw 读取这份快照，
 * 即使实例所在 IP 被个别数据源限流，页面也不会退回到上次部署时的旧数据。
 *
 * Producer heartbeat (data/job_health_macro_snapshot.json): a step is 'ok'
 * only when the returned payload's dataHealth is fully OK — a partial
 * fallback fetch is a failed step. Partial artifacts are still committed by
 * the workflow; a non-ok job exits 1 AFTER finish so the heartbeat lands.
 */
const { fetchAndBuildMacroData } = require('../server/macro_fetcher');
const { getPreferredsData } = require('../server/mstr_preferreds');
const { getMstrDisclosures } = require('../server/mstr_disclosures');
const { beginJob, recordStep, finishJob } = require('../server/pipeline_health');

const JOB = 'macro_snapshot';

/** Every required source verified OK — fallback/stale sources fail the step. */
function allSourcesOk(payload) {
  const h = payload && payload.dataHealth;
  if (!h || h.state !== 'OK' || !h.sources) return false;
  return Object.values(h.sources).every(s => s && s.state === 'OK');
}

async function main() {
  beginJob(JOB);

  try {
    const macro = await fetchAndBuildMacroData();
    const s = macro.summary;
    console.log('[macro_snapshot] macro', s.dateRange.end, 'sources', JSON.stringify(s.sources));
    recordStep(JOB, 'macro', {
      ok: allSourcesOk(macro),
      error: allSourcesOk(macro) ? null : new Error(`macro health ${macro.dataHealth?.state || 'missing dataHealth'}`),
      dataAsOf: s.dateRange && s.dateRange.end ? `${s.dateRange.end}T00:00:00Z` : null
    });
  } catch (err) {
    console.error('[macro_snapshot] macro failed:', err.message);
    recordStep(JOB, 'macro', { ok: false, error: err });
  }

  // 披露采集排在优先股之前：优先股构建会读取本轮刚采集的 STRC 官方股息率
  try {
    // Strategy 官方披露采集 (issuer ledger/shares + SEC filing index):
    // the step is ok only when every disclosure source verified this scan.
    const disc = await getMstrDisclosures(true);
    const ok = allSourcesOk(disc);
    console.log('[macro_snapshot] mstr_disclosures', disc.lastCompletedAt,
      'state', disc.dataHealth && disc.dataHealth.state);
    recordStep(JOB, 'mstr_disclosures', {
      ok,
      error: ok ? null : new Error(`mstr disclosures health ${disc.dataHealth?.state || 'missing dataHealth'}`),
      // lastCompletedAt is the last FULLY accepted scan — a failed scan keeps
      // the older success-bound timestamp, never stamps a fresh success.
      dataAsOf: disc.lastCompletedAt || null
    });
  } catch (err) {
    console.warn('[macro_snapshot] mstr_disclosures failed:', err.message);
    recordStep(JOB, 'mstr_disclosures', { ok: false, error: err });
  }

  try {
    const pref = await getPreferredsData(true);
    console.log('[macro_snapshot] preferreds', pref.summary.asOf, 'sources', JSON.stringify(pref.summary.sources),
      'strc rate', JSON.stringify(pref.summary.strcRateCoverage));
    recordStep(JOB, 'preferreds', {
      ok: allSourcesOk(pref),
      error: allSourcesOk(pref) ? null : new Error(`preferreds health ${pref.dataHealth?.state || 'missing dataHealth'}`),
      dataAsOf: pref.summary && pref.summary.asOf ? pref.summary.asOf : null
    });
  } catch (err) {
    // 优先股数据失败不影响宏观快照提交，但心跳必须如实记录
    console.warn('[macro_snapshot] preferreds failed:', err.message);
    recordStep(JOB, 'preferreds', { ok: false, error: err });
  }

  const job = finishJob(JOB);
  if (!job || job.status !== 'ok') {
    console.warn(`[macro_snapshot] job finished ${job ? job.status : 'with heartbeat write failure'}: ${job && job.lastError}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[macro_snapshot] failed:', err.message);
    try { finishJob(JOB); } catch (e) { /* heartbeat best effort */ }
    process.exit(1);
  });
}

module.exports = { main, allSourcesOk };
