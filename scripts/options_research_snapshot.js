#!/usr/bin/env node
'use strict';
// Capture evidence only; player identities and trade recommendations are never inferred here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BASE = 'https://bigdy-cry-pto-dashboard-3.onrender.com';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
async function main() {
  const args = process.argv.slice(2);
  const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const out = path.resolve(arg('--out', 'scratch/options-research-evidence.json'));
  const researchDir = arg('--research-dir', null);
  const snapshotDir = arg('--snapshot-dir', null);
  const sources = {};
  for (const [name, endpoint] of Object.entries({market:'/api/market-data?timeRange=3d', insight:'/api/block-insight', health:'/api/system/health'})) {
    let source;
    if (snapshotDir) source = JSON.parse(fs.readFileSync(path.join(snapshotDir, `options-online-${name}.json`), 'utf8'));
    else {
      const response = await fetch(BASE + endpoint, {signal: AbortSignal.timeout(60000)});
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      source = {url: BASE + endpoint, httpStatus: response.status, receivedAt: new Date().toISOString(), data: await response.json()};
    }
    if (source.httpStatus !== 200 || source.data?.code !== 0) throw new Error(`${name}: invalid source envelope`);
    sources[name] = {...source, sha256: hash(JSON.stringify(source.data))};
  }
  if (!sources.market.data.blockTrades?.tradeStoreStats || !sources.insight.data.coverage) throw new Error('Missing options/coverage schema');
  const asOf = sources.market.receivedAt;
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('Invalid source clock');
  const research = researchDir ? fs.readdirSync(researchDir).filter(n => /\.txt$/i.test(n) && /Bitcoin|Q4 Equity|Interest Rates|Inflation/i.test(n)).map(name => {
    const file = path.resolve(researchDir, name), stat = fs.statSync(file), raw = fs.readFileSync(file);
    return {name, path:file, modifiedAt:stat.mtime.toISOString(), bytes:raw.length, sha256:hash(raw)};
  }).filter(r => Date.parse(r.modifiedAt) <= Date.parse(asOf) && Date.parse(asOf)-Date.parse(r.modifiedAt) <= 45*86400000).sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt)) : [];
  const m=sources.market.data, i=sources.insight.data;
  const result={schemaVersion:1, asOf, researchDateMeaning:'filesystem modification time, not publication time', research, sources,
    coverage:{onlineStore:m.blockTrades.tradeStoreStats, insight:i.coverage, analysisHealth:m.analysisHealth},
    caveats:['Leg-summed notional is not capital invested.', 'Net OI cannot prove the counterparty identity or opening/closing of a specific execution.', 'All player interpretations require competing hypotheses.', 'Different source clocks and incomplete current-day aggregates must remain visible.']};
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({out,asOf,research:research.map(r=>({name:r.name,modifiedAt:r.modifiedAt})),onlineRetention:m.blockTrades.tradeStoreStats?.retentionDays}));
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
