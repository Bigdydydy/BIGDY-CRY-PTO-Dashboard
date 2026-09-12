const { refreshAllMarketData, getCachedData } = require('./server/data_fetcher');
const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  analyzeIvSmile,
  analyze25DeltaSkew
} = require('./server/analytics_engine');

async function testAll() {
  console.log("Fetching market data...");
  await refreshAllMarketData('BTC');
  const cache = getCachedData();

  console.log("\n=== 1. IV Smile (微笑曲线) ===");
  const smile = analyzeIvSmile(cache.ivSkewMonth, cache.gex?.index_price);
  console.log("Shape:", smile.skewShape);
  console.log("ATM Strike:", smile.atmStrike, "ATM IV:", smile.atmIv);
  console.log("Put Wing:", smile.lowestStrike, "IV:", smile.lowestIv, "Premium:", smile.putWingPremium);
  console.log("Call Wing:", smile.highestStrike, "IV:", smile.highestIv, "Premium:", smile.callWingPremium);
  console.log("Smile Narrative:\n", smile.paragraph);

  console.log("\n=== 2. 25 Delta Skew 期限结构 ===");
  const skew = analyze25DeltaSkew(cache.skewChart);
  console.log("1D:", skew.d1, "7D:", skew.d7, "30D:", skew.d30, "90D:", skew.d90);
  console.log("Near-term Sentiment:", skew.nearTermSentiment);
  console.log("Mid-term Sentiment:", skew.midTermSentiment);
  console.log("25D Skew Narrative:\n", skew.paragraph);

  console.log("\n=== 3. Block Trade Greeks & Intent Analysis ===");
  const blocks = analyzeBlockTrades(cache.blockTrades, 30000000);
  console.log("Whale blocks count:", blocks.whaleBlocks.length);
  for (const b of blocks.whaleBlocks.slice(0, 3)) {
    console.log(`\nBlock [${b.blockId}] - ${b.intentBadge}`);
    console.log(`  Notional: $${b.notionalUSDM.toFixed(2)}M | Net Delta: ${b.netDeltaBTC.toFixed(1)} BTC ($${b.netDeltaUSDM.toFixed(1)}M) | Net Vega: $${Math.round(b.netVegaUSD).toLocaleString()} | Net Theta: $${Math.round(b.netThetaUSD).toLocaleString()}/day`);
    console.log(`  Narrative: ${b.intentNarrative}`);
  }

  console.log("\nIceberg clusters count:", blocks.icebergClusters.length);
  for (const c of blocks.icebergClusters.slice(0, 2)) {
    console.log(`\nIceberg [${c.instrument} ${c.direction.toUpperCase()}] - ${c.intentBadge}`);
    console.log(`  Notional: $${c.clusterNotionalM.toFixed(2)}M | Splits: ${c.splitCount} | Net Delta: $${c.netDeltaUSDM.toFixed(1)}M | Net Vega: $${Math.round(c.netVegaUSD).toLocaleString()}`);
    console.log(`  Narrative: ${c.intentNarrative}`);
  }
}

testAll().catch(console.error);
