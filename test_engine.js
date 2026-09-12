const { refreshAllMarketData, getCachedData } = require('./server/data_fetcher');
const { analyzeAtmIv, analyzeDynamicGex, analyzeBlockTrades } = require('./server/analytics_engine');

async function testEngine() {
  console.log("Testing DataFetcher & AnalyticsEngine...");
  await refreshAllMarketData('BTC');
  const cache = getCachedData();

  console.log("\n=== Testing Module 1: ATM IV ===");
  const atmResult = analyzeAtmIv(cache.ivHistory, cache.dvolStats);
  console.log("Curve:", atmResult.curveType, atmResult.curveDesc);
  console.log("1M IV:", atmResult.iv1m, "3M IV:", atmResult.iv3m, "6M IV:", atmResult.iv6m);
  console.log("Percentile:", atmResult.percentile, "Regime:", atmResult.regimeTag);
  console.log("Paragraph:\n", atmResult.paragraph);

  console.log("\n=== Testing Module 2: Dynamic GEX (Current Date: 2026-09-12) ===");
  const gexNow = analyzeDynamicGex(cache.gex, new Date('2026-09-12T08:00:00Z'));
  console.log("Focused Expiries count:", gexNow.focusedExpiries.length);
  gexNow.focusedExpiries.forEach(f => console.log(`  ${f.expiry} (${f.categoryTag}) -> Total GEX: $${f.totalGexM.toFixed(1)}M, CallWall: $${f.callWall}, PutWall: $${f.putWall}`));
  console.log("Contains 27NOV26 in Sept?", gexNow.focusedExpiries.some(f => f.expiry === '27NOV26'));
  console.log("GEX Paragraph:\n", gexNow.paragraph);

  console.log("\n=== Testing Dynamic Expiration Progression to November (Date: 2026-11-05) ===");
  const gexNov = analyzeDynamicGex(cache.gex, new Date('2026-11-05T08:00:00Z'));
  console.log("Focused Expiries in Nov count:", gexNov.focusedExpiries.length);
  gexNov.focusedExpiries.forEach(f => console.log(`  ${f.expiry} (${f.categoryTag})`));
  console.log("Contains 27NOV26 in Nov?", gexNov.focusedExpiries.some(f => f.expiry === '27NOV26'));

  console.log("\n=== Testing Module 3: Block Trades & Icebergs (>=$30M) ===");
  const blockResult = analyzeBlockTrades(cache.blockTrades, 30000000);
  console.log("Single Whale Blocks (>= $30M):", blockResult.whaleBlocks.length);
  console.log("Iceberg Clusters (>= $30M):", blockResult.icebergClusters.length);
  blockResult.icebergClusters.forEach(c => console.log(`  [Iceberg Cluster] ${c.direction.toUpperCase()} ${c.totalContracts} ${c.instrument} | $${c.clusterNotionalM.toFixed(1)}M across ${c.splitCount} trades in ${c.durationMin}m`));
  console.log("Block Trade Paragraph:\n", blockResult.paragraph);
}

testEngine().catch(console.error);
