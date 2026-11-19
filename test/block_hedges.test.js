const test = require('node:test');
const assert = require('node:assert/strict');
const hedges = require('../server/block_hedges');
const { analyzeBlockTrades } = require('../server/analytics_engine');
const BI = require('../server/block_insight');

const T0 = Date.UTC(2026, 9, 1, 12, 0);
const call = (id, amount, extra = {}) => ({
  trade_id: id, block_trade_id: 'BLOCK-1', instrument_name: 'BTC-26DEC26-80000-C', direction: 'buy',
  amount, price: 0.06, iv: 45, index_price: 80000, timestamp: T0, ...extra
});

test('hedgeDeltaBTC: inverse futures are quoted in USD, USDC linear ones in BTC', () => {
  assert.equal(hedges.hedgeDeltaBTC({ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: 800000, price: 80000 }), -10);
  assert.equal(hedges.hedgeDeltaBTC({ instrument: 'BTC-26DEC26', direction: 'buy', amount: 400000, price: 80000 }), 5);
  assert.equal(hedges.hedgeDeltaBTC({ instrument: 'BTC_USDC-PERPETUAL', direction: 'sell', amount: 3, price: 80000 }), -3);
  assert.equal(hedges.isOptionName('BTC-26DEC26-80000-C'), true);
  assert.equal(hedges.isOptionName('BTC-26DEC26'), false);
});

test('fetchBlockLegs + entryFromLegs keep only the non-option legs of that block', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const btc = url.includes('currency=BTC');
    const trades = btc ? [
      { trade_id: 1, block_trade_id: 'BLOCK-9', instrument_name: 'BTC-26DEC26-80000-C', direction: 'buy', amount: 100, price: 0.05, timestamp: T0, block_trade_leg_count: 2 },
      { trade_id: 2, block_trade_id: 'BLOCK-9', instrument_name: 'BTC-PERPETUAL', direction: 'sell', amount: 4000000, price: 80000, timestamp: T0, block_trade_leg_count: 2 },
      { trade_id: 3, block_trade_id: 'BLOCK-8', instrument_name: 'BTC-PERPETUAL', direction: 'buy', amount: 10, price: 80000, timestamp: T0 }
    ] : [];
    return { ok: true, json: async () => ({ result: { trades, has_more: false } }) };
  };
  const r = await hedges.fetchBlockLegs('BLOCK-9', T0, { fetcher });
  assert.equal(calls.length, 2); // BTC and USDC
  const e = hedges.entryFromLegs(T0, r);
  assert.equal(e.legCount, 2);
  assert.equal(e.optionLegs, 1);
  assert.equal(e.complete, true);
  assert.deepEqual(e.hedges.map(h => h.instrument), ['BTC-PERPETUAL']);
  assert.equal(hedges.hedgeDeltaOf(e), -50);
  // A block whose legs are all options produces no entry
  assert.equal(hedges.entryFromLegs(T0, { legCount: 1, legs: [r.legs[0]] }), null);
});

test('mergeSets: complete entries win, coveredThrough takes the furthest checked point', () => {
  const a = { blocks: { X: { ts: 1, complete: false, hedges: [] } }, coveredThrough: 100 };
  const b = { blocks: { X: { ts: 1, complete: true, hedges: [{}] }, Y: { ts: 2, complete: true, hedges: [] } }, coveredThrough: 50 };
  const m = hedges.mergeSets(a, b);
  assert.equal(m.blocks.X.complete, true);
  assert.equal(Object.keys(m.blocks).length, 2);
  assert.equal(m.coveredThrough, 100);
});

test('a long call hedged with a short perpetual reads as a long-vol trade, not a bullish one', () => {
  const trades = [call('a', 500)];
  const plain = analyzeBlockTrades(trades, 30e6, 'all', 80000);
  const w0 = plain.whaleBlocks[0];
  assert.equal(w0.intentBadgeClass, 'badge-bull');
  assert.equal(w0.hedge, null);
  const optionDeltaBTC = w0.netDeltaBTC;
  // Sell futures worth the option delta (in USD, inverse contract)
  const set = { blocks: { 'BLOCK-1': { ts: T0, complete: true, hedges: [{ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: Math.round(optionDeltaBTC * 80000), price: 80000 }] } } };
  const hedged = analyzeBlockTrades(trades, 30e6, 'all', 80000, null, { hedges: set });
  const w = hedged.whaleBlocks[0];
  assert.equal(w.hedge.deltaHedged, true);
  assert.ok(Math.abs(w.netDeltaBTC) < 0.01);
  assert.equal(w.intentBadgeClass, 'badge-vol-buy');
  assert.ok(w.strategyNameZh.includes('期货 Delta 对冲'));
  // 4B family follows the hedged net delta
  assert.equal(BI.familyOf({ netDeltaUSD: w0.netDeltaUSD, netVegaUSD: w0.netVegaUSD, notionalUSD: w0.notionalUSD, legs: w0.legs }), 'bull');
  assert.equal(BI.familyOf({ netDeltaUSD: w.netDeltaUSD, netVegaUSD: w.netVegaUSD, notionalUSD: w.notionalUSD, legs: w.legs, hedged: true }), 'long-vol');
  // A small hedge only labels the structure; the direction stays
  const partial = { blocks: { 'BLOCK-1': { ts: T0, complete: true, hedges: [{ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: 80000, price: 80000 }] } } };
  const p = analyzeBlockTrades(trades, 30e6, 'all', 80000, null, { hedges: partial }).whaleBlocks[0];
  assert.equal(p.hedge.deltaHedged, false);
  assert.equal(p.intentBadgeClass, 'badge-bull');
  assert.ok(p.strategyNameZh.includes('部分对冲'));
});

test('applyHedgesToRegistry re-families marked structures without touching marks', () => {
  const trades = [call('a', 500)];
  const plain = analyzeBlockTrades(trades, 30e6, 'all', 80000);
  const reg = BI.registerStructures([], plain).registry;
  assert.equal(reg[0].family, 'bull');
  reg[0].marks = [{ day: '2026-10-02', valueBtc: 1 }];
  const optionDeltaBTC = plain.whaleBlocks[0].netDeltaBTC;
  const set = { blocks: { 'BLOCK-1': { ts: T0, complete: true, hedges: [{ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: Math.round(optionDeltaBTC * 80000), price: 80000 }] } } };
  const hedged = analyzeBlockTrades(trades, 30e6, 'all', 80000, null, { hedges: set });
  const r = BI.applyHedgesToRegistry(reg, hedged);
  assert.equal(r.refamilied, 1);
  assert.equal(r.registry[0].family, 'long-vol');
  assert.equal(r.registry[0].hedged, true);
  assert.deepEqual(r.registry[0].marks, reg[0].marks);
  assert.deepEqual(r.registry[0].blockIds, ['BLOCK-1']);
  // Running again changes nothing
  assert.equal(BI.applyHedgesToRegistry(r.registry, hedged).updated, 0);
});
