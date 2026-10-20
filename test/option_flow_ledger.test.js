const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const flow = require('../server/option_flow_ledger');

const C = 'BTC-30OCT26-80000-C';
const P = 'BTC-30OCT26-70000-P';
const trade = (id, ts, name, direction, amount, extra = {}) => ({ trade_id: String(id), timestamp: ts, instrument_name: name, direction, amount, ...extra });

describe('option_flow_ledger · 成交分类', () => {
  test('屏幕、大宗与强平分开；强平按被强平方确定客户方向', () => {
    assert.deepEqual(flow.classifyTrade(trade(1, 1, C, 'buy', 2)), { bucket: 'screen', customer: 2, amount: 2 });
    assert.deepEqual(flow.classifyTrade(trade(1, 1, C, 'sell', 3, { block_trade_id: 'BLOCK-1' })), { bucket: 'block', customer: -3, amount: 3 });
    // 主动方被强平：客户方向 = 主动方方向
    assert.deepEqual(flow.classifyTrade(trade(1, 1, C, 'sell', 1, { liquidation: 'T' })), { bucket: 'liq', customer: -1, amount: 1 });
    // 挂单方被强平：客户方向与主动方相反
    assert.deepEqual(flow.classifyTrade(trade(1, 1, C, 'sell', 1, { liquidation: 'M' })), { bucket: 'liq', customer: 1, amount: 1 });
    // 双方都被强平：对做市商无影响
    assert.deepEqual(flow.classifyTrade(trade(1, 1, C, 'buy', 1, { liquidation: 'MT' })), { bucket: 'liq', customer: 0, amount: 1 });
    assert.equal(flow.classifyTrade(trade(1, 1, C, 'hold', 1)), null);
    assert.equal(flow.classifyTrade(trade(1, 1, C, 'buy', 0)), null);
    assert.equal(flow.classifyTrade({ direction: 'buy', amount: 1 }), null);
  });

  test('客户净买入 = 大宗 + 强平 + 屏幕 × 折扣系数', () => {
    const row = [10, -4, 1, 30, 8, 1, 9];
    assert.equal(flow.customerNet(row), 7);
    assert.equal(flow.customerNet(row, 0), -3);
    assert.equal(flow.customerNet(row, 0.5), 2);
  });
});

describe('option_flow_ledger · 记账与去重', () => {
  test('按合约累计净额、成交量与笔数，只为现存合约记账但游标照常前进', () => {
    const ledger = flow.emptyLedger();
    const r = flow.applyTrades(ledger, [
      trade(1, 100, C, 'buy', 2),
      trade(2, 101, C, 'sell', 0.5, { block_trade_id: 'B' }),
      trade(3, 102, P, 'sell', 1, { liquidation: 'M' }),
      trade(4, 103, 'BTC-1JAN26-1-C', 'buy', 9),
      trade(5, 104, C, 'buy', 0)
    ], { liveSet: new Set([C, P]) });
    assert.equal(r.applied, 3);
    assert.deepEqual(ledger.instruments[C], [2, -0.5, 0, 2, 0.5, 0, 2]);
    assert.deepEqual(ledger.instruments[P], [0, 0, 1, 0, 0, 1, 1]);
    assert.equal(ledger.instruments['BTC-1JAN26-1-C'], undefined);
    assert.equal(ledger.lastTradeTs, 104);
  });

  test('游标毫秒内已入账的成交不重复，早于游标的成交跳过', () => {
    const ledger = flow.emptyLedger();
    flow.applyTrades(ledger, [trade(1, 100, C, 'buy', 1), trade(2, 200, C, 'buy', 1), trade(3, 200, C, 'buy', 1)]);
    assert.deepEqual(ledger.boundaryTradeIds.sort(), ['2', '3']);
    // 下一页从 200 毫秒重新取：2、3 已入账，4 是同毫秒新成交
    const r = flow.applyTrades(ledger, [trade(2, 200, C, 'buy', 1), trade(3, 200, C, 'buy', 1), trade(4, 200, C, 'buy', 1), trade(0, 150, C, 'buy', 5)]);
    assert.equal(r.applied, 1);
    assert.equal(ledger.instruments[C][0], 4);
    assert.equal(ledger.instruments[C][6], 4);
  });

  test('删除已交割合约', () => {
    const ledger = flow.emptyLedger();
    ledger.instruments = { 'BTC-19OCT26-80000-C': [1, 0, 0, 1, 0, 0, 1], [C]: [1, 0, 0, 1, 0, 0, 1] };
    flow.pruneExpired(ledger, Date.UTC(2026, 9, 20));
    assert.deepEqual(Object.keys(ledger.instruments), [C]);
    assert.equal(flow.expiryOf(C), Date.UTC(2026, 9, 30, 8));
  });
});

describe('option_flow_ledger · 分页同步', () => {
  // 模拟接口：按时间升序，从 start 起取 count 笔
  const makeFetcher = (all, pageSize, calls) => async (currency, start, end) => {
    calls.push(start);
    const rows = all.filter(t => t.timestamp >= start && t.timestamp <= end);
    return { trades: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
  };

  test('同毫秒成交跨页时既不重复也不丢失，完成后记 syncedThrough', async () => {
    const all = [
      trade(1, 10, C, 'buy', 1), trade(2, 20, C, 'buy', 1), trade(3, 20, C, 'buy', 1),
      trade(4, 20, C, 'buy', 1), trade(5, 30, C, 'sell', 1), trade(6, 40, P, 'buy', 2)
    ];
    const calls = [];
    const ledger = flow.emptyLedger();
    ledger.startTs = 0;
    // 每页 3 笔：第 1 页止于 20 毫秒的前两笔，第 2 页从 20 毫秒重取，去重后只记入新的第 3 笔
    const r = await flow.syncLedger(ledger, { endTs: 50, fetchPage: makeFetcher(all, 3, calls), sleepMs: 0 });
    assert.deepEqual(calls, [0, 20, 21]);
    assert.equal(r.complete, true);
    assert.equal(ledger.instruments[C][0], 3);   // 4 买 − 1 卖
    assert.equal(ledger.instruments[C][6], 5);
    assert.equal(ledger.instruments[P][0], 2);
    assert.equal(ledger.syncedThrough, 50);
    assert.equal(ledger.lastTradeTs, 40);

    // 增量：新成交到来后从游标继续，旧成交不重复
    all.push(trade(7, 40, P, 'sell', 1), trade(8, 60, C, 'buy', 1));
    const r2 = await flow.syncLedger(ledger, { endTs: 70, fetchPage: makeFetcher(all, 2, []), sleepMs: 0 });
    assert.equal(r2.applied, 2);
    assert.equal(ledger.instruments[P][0], 1);
    assert.equal(ledger.instruments[C][0], 4);
  });

  test('达到页数上限时不标记完成，下次从游标继续', async () => {
    const all = Array.from({ length: 10 }, (_, i) => trade(i + 1, (i + 1) * 10, C, 'buy', 1));
    const ledger = flow.emptyLedger();
    ledger.startTs = 0;
    const r = await flow.syncLedger(ledger, { endTs: 1000, fetchPage: makeFetcher(all, 3, []), sleepMs: 0, maxPages: 2 });
    assert.equal(r.complete, false);
    assert.equal(ledger.syncedThrough, null);
    await flow.syncLedger(ledger, { endTs: 1000, fetchPage: makeFetcher(all, 3, []), sleepMs: 0 });
    assert.equal(ledger.instruments[C][0], 10);
    assert.equal(ledger.syncedThrough, 1000);
  });

  // 已知局限：同一毫秒成交超过一页 (真实接口为 1000 笔) 时，该毫秒剩余成交会被跳过
  test('整页落在同一毫秒时游标前移 1 毫秒，避免原地循环', async () => {
    const all = [trade(1, 10, C, 'buy', 1), trade(2, 10, C, 'buy', 1), trade(3, 10, C, 'buy', 1), trade(4, 20, C, 'buy', 1)];
    const calls = [];
    const ledger = flow.emptyLedger();
    ledger.startTs = 10;
    await flow.syncLedger(ledger, { endTs: 30, fetchPage: makeFetcher(all, 2, calls), sleepMs: 0, maxPages: 5 });
    assert.ok(calls.includes(11), `游标应前移到 11，实际请求起点 ${calls}`);
  });

  test('缺少起点时报错', async () => {
    await assert.rejects(flow.syncLedger(flow.emptyLedger(), { fetchPage: async () => ({ trades: [], hasMore: false }) }));
  });
});

describe('option_flow_ledger · 读写与线上读取', () => {
  const sample = () => ({ ...flow.emptyLedger(), startTs: 1, syncedThrough: Date.now() - 1000, lastTradeTs: 5, instruments: { [C]: [1, 2, 0, 3, 2, 0, 4] } });

  test('写入后可读回，非法档案读为 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowledger-'));
    const file = path.join(dir, 'l.json');
    flow.writeLedger(file, sample());
    assert.deepEqual(flow.readLedger(file).instruments[C], [1, 2, 0, 3, 2, 0, 4]);
    fs.writeFileSync(file, JSON.stringify({ instruments: { [C]: [1, 2] } }));
    assert.equal(flow.readLedger(file), null);
    assert.equal(flow.readLedger(path.join(dir, 'missing.json')), null);
  });

  test('优先读线上档案，失败时退回磁盘，并按 30 分钟缓存', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowledger-'));
    const file = path.join(dir, 'l.json');
    const disk = sample();
    disk.instruments[C] = [9, 9, 9, 9, 9, 9, 9];
    flow.writeLedger(file, disk);

    flow.clearLedgerCache();
    let calls = 0;
    const ok = async () => { calls++; return { ok: true, json: async () => sample() }; };
    const a = await flow.getLedger({ now: 1000, fetcher: ok, file });
    assert.equal(a.instruments[C][0], 1);
    await flow.getLedger({ now: 2000, fetcher: ok, file });
    assert.equal(calls, 1, '缓存期内不重复请求');

    flow.clearLedgerCache();
    const bad = async () => ({ ok: false, status: 404 });
    const b = await flow.getLedger({ now: 1000, fetcher: bad, file });
    assert.equal(b.instruments[C][0], 9, '线上失败时读磁盘');
    flow.clearLedgerCache();
  });
});
