#!/usr/bin/env node
/**
 * CLI: build the indicator snapshot for the commentary agent.
 *
 *   node analyst_agent/data_layer/fetch_snapshot.js                    # today, all lenses
 *   node analyst_agent/data_layer/fetch_snapshot.js --asof 2026-09-25  # historical run, no look-ahead
 *   node analyst_agent/data_layer/fetch_snapshot.js --event 2026-09-16 --lens esther
 *
 * Writes snapshots/<asof>.json (full) and snapshots/<asof>.md (compact table for the prompt).
 */

const fs = require('fs');
const path = require('path');
const { buildSnapshot } = require('./lib/snapshot');

const KEY_TRANSFORMS = [
  'chg_1d_bp', 'chg_1w_bp', 'chg_4w_bp', 'chg_1w_pct', 'chg_4w_pct', 'chg_4w', 'chg_3m', 'chg_3m_bp', 'chg_12m_pct',
  'yoy', 'mom_annualized_3m', 'mom_change', 'avg_3m_change', 'avg_4w', 'zscore_1y', 'chg_12m_bp', 'vs_sma200', 'vs_sma50', 'vs_sma50w', 'days_below_sma200', 'drawdown_from_high', 'percentile_1y', 'percentile_10y',
  'curve_regime', 'share_of_nominal_move', 'divergence_vs_spx', 'rel_to_spx', 'gap_vs_core_cpi', 'crack_vs_wti',
  'implied_oil_disruption', 'distance_to_key_level_bp', 'chg_since_event_bp', 'chg_since_spx_high_bp'
];

function parseArgs(argv) {
  const out = { lens: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asof') out.asof = argv[++i];
    else if (a === '--event') out.eventDate = argv[++i];
    else if (a === '--lens') out.lens = argv[++i].split(',');
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--no-cache') out.noCache = true;
    else if (a === '--no-rules') out.withRules = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('unknown argument ' + a);
  }
  for (const k of ['asof', 'eventDate']) {
    if (out[k] && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) throw new Error(k + ' must be YYYY-MM-DD');
  }
  return out;
}

function fmtTransform(name, t) {
  if (!t || t.error) return null;
  // Multi-field transforms carry no single `value`.
  if (name === 'share_of_nominal_move') return 'realShareOf10yMove 4w=' + t.share_4w + ' 13w=' + t.share_13w;
  if (name === 'rel_to_spx') return 'relSPX 4w=' + t.chg_4w_pct + '% 13w=' + t.chg_13w_pct + '%';
  if (name === 'implied_oil_disruption') return t.implied_mbd == null ? null : 'impliedDisruption=' + t.implied_mbd + 'mb/d (+' + t.price_rise_pct + '% vs baseline)';
  if (t.value === null || t.value === undefined) return null;
  const v = t.value;
  if (name === 'distance_to_key_level_bp') {
    return 'keyLevels=' + v.map(l => l.level + ':' + (l.distance_bp != null ? l.distance_bp + 'bp' : l.distance_pct + '%')).join(',');
  }
  if (typeof v === 'object') return name + '=' + JSON.stringify(v);
  return name + '=' + v;
}

function toMarkdown(snap) {
  const lines = [];
  const m = snap.meta;
  lines.push('# 指标快照 ' + m.asof);
  lines.push('');
  lines.push('生成时间 ' + m.generated_at + '；注册表 v' + m.registry_version + '；成功 ' + m.counts.ok + '/' + m.counts.indicators
    + '，过期 ' + m.counts.stale + '，需 OpenMarket ' + m.counts.runtime_openmarket + '，需人工 ' + m.counts.manual_input_required + '，失败 ' + m.counts.failed + '。');
  lines.push('');
  const byDim = {};
  for (const [id, r] of Object.entries(snap.indicators)) (byDim[r.dimension] = byDim[r.dimension] || []).push([id, r]);
  for (const [dim, rows] of Object.entries(byDim)) {
    lines.push('## ' + dim);
    lines.push('');
    lines.push('| ID | 名称 | 最新 | 日期 | 关键变换 | 备注 |');
    lines.push('|---|---|---|---|---|---|');
    for (const [id, r] of rows) {
      let latest = r.latest ? String(r.latest.value) : '';
      let date = r.latest ? r.latest.date : '';
      let note = r.stale ? '⚠ 数据较旧' : '';
      if (r.status === 'runtime_openmarket') note = '运行时读 OpenMarket ' + (r.realtime_source.query || r.realtime_source.symbol);
      if (r.status === 'manual_input_required') note = '待人工补充';
      if (r.error) note = '❌ ' + r.error.slice(0, 80);
      if (r.latest_by_term) {
        latest = Object.entries(r.latest_by_term).map(([term, a]) => term + ' ' + a.high_yield + '% btc' + a.bid_to_cover).join('; ');
        date = Object.values(r.latest_by_term).map(a => a.date).sort().pop();
      }
      const tf = Object.entries(r.transforms || {})
        .filter(([n]) => KEY_TRANSFORMS.includes(n))
        .map(([n, t]) => fmtTransform(n, t))
        .filter(Boolean)
        .join('; ');
      lines.push('| ' + [id, r.name, latest, date, tf, note].map(x => String(x).replace(/\|/g, '/')).join(' | ') + ' |');
    }
    lines.push('');
  }
  if (Object.keys(m.source_errors).length) {
    lines.push('## 数据源错误');
    lines.push('');
    for (const [k, v] of Object.entries(m.source_errors)) lines.push('- `' + k + '`: ' + v);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const t0 = Date.now();
  const snap = await buildSnapshot(args);
  const outDir = args.outDir || path.join(__dirname, 'snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, snap.meta.asof + (args.lens.length ? '_' + args.lens.join('-') : ''));
  fs.writeFileSync(base + '.json', JSON.stringify(snap, null, 2));
  fs.writeFileSync(base + '.md', toMarkdown(snap));
  const c = snap.meta.counts;
  console.log('[snapshot] ' + snap.meta.asof + ': ok ' + c.ok + '/' + c.indicators + ', stale ' + c.stale + ', openmarket ' + c.runtime_openmarket
    + ', manual ' + c.manual_input_required + ', failed ' + c.failed + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  for (const [id, r] of Object.entries(snap.indicators)) if (r.error) console.log('  ✗ ' + id + ': ' + r.error);
  console.log('  → ' + base + '.json / .md');
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs, toMarkdown };
