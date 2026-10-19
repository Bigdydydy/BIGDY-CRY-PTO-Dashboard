/**
 * TradingView fallback feed — raw row validation must reject malformed
 * frames through the promise (finish -> reject), never by throwing inside
 * the onmessage event callback (which would crash the process), and a
 * missing volume must not be fabricated as 0.
 *
 * A FakeWebSocket drives every scenario — no real socket is opened.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { fetchTvBars } = require('../server/tradingview_feed');

const frame = s => {
  const p = typeof s === 'string' ? s : JSON.stringify(s);
  return `~m~${p.length}~m~${p}`;
};

class FakeWebSocket {
  constructor(url) { this.url = url; FakeWebSocket.last = this; }
  send() {}
  close() { this.closed = true; }
}

const goodRow = t => ({ v: [t, 100, 110, 90, 105, 12.5] });
const nowSec = () => Math.floor(Date.now() / 1000);

function feed(barsMsg, extra = []) {
  return [
    frame({ m: 'timescale_update', p: [0, { s1: { s: barsMsg } }] }),
    ...extra,
    frame({ m: 'series_completed', p: [] })
  ].join('');
}

async function run(script) {
  const real = global.WebSocket;
  global.WebSocket = FakeWebSocket;
  try {
    const p = fetchTvBars('COINBASE:BTCUSD', '1h', 10, 5000);
    const ws = FakeWebSocket.last;
    script(ws);
    return await p;
  } finally {
    global.WebSocket = real;
  }
}

describe('tradingview_feed row validation (FakeWebSocket)', () => {
  test('valid rows resolve to ascending bars with real volume', async () => {
    const t = nowSec() - 7200;
    const bars = await run(ws => {
      ws.onmessage({ data: feed([goodRow(t), goodRow(t + 3600)]) });
    });
    assert.equal(bars.length, 2);
    assert.deepEqual(bars[0], { t: t * 1000, o: 100, h: 110, l: 90, c: 105, vol: 12.5 });
    assert.equal(bars[1].t, (t + 3600) * 1000);
  });

  test('missing r.v -> rejects, does not throw inside the event callback', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: feed([{ /* no v */ }]) })),
      /schema 校验失败/
    );
  });

  test('short row (missing volume) rejects — vol is never fabricated as 0', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: feed([{ v: [nowSec() - 100, 1, 2, 0.5, 1.5] }]) })),
      /schema 校验失败/
    );
  });

  test('null/negative volume and non-finite prices reject', async () => {
    const t = nowSec() - 100;
    await assert.rejects(run(ws => ws.onmessage({ data: feed([{ v: [t, 1, 2, 0.5, 1.5, null] }]) })), /schema/);
    await assert.rejects(run(ws => ws.onmessage({ data: feed([{ v: [t, 1, 2, 0.5, 1.5, -3] }]) })), /schema/);
    await assert.rejects(run(ws => ws.onmessage({ data: feed([{ v: [t, 1, NaN, 0.5, 1.5, 3] }]) })), /schema/);
  });

  test('non-array r.v rejects instead of crashing on r.v[0]', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: feed([{ v: 'oops' }]) })),
      /schema 校验失败/
    );
  });

  test('future-dated row rejects', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: feed([{ v: [nowSec() + 3600 * 24, 1, 2, 0.5, 1.5, 1] }]) })),
      /schema 校验失败/
    );
  });

  test('unparseable frames are skipped, valid rows still resolve', async () => {
    const t = nowSec() - 3600;
    const bars = await run(ws => {
      ws.onmessage({ data: frame('{not-json') + feed([goodRow(t)]) });
    });
    assert.equal(bars.length, 1);
  });

  test('early close before series_completed rejects with a clean error', async () => {
    await assert.rejects(
      run(ws => { ws.onopen && ws.onopen(); ws.onclose(); }),
      /连接提前关闭/
    );
  });

  test('series_completed with zero bars rejects (no fabricated data)', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: feed([]) })),
      /空数据/
    );
  });

  test('symbol/series error messages reject', async () => {
    await assert.rejects(
      run(ws => ws.onmessage({ data: frame({ m: 'symbol_error', p: [] }) })),
      /symbol_error/
    );
  });

  test('timeout rejects when nothing arrives', async () => {
    const real = global.WebSocket;
    global.WebSocket = FakeWebSocket;
    try {
      await assert.rejects(fetchTvBars('COINBASE:BTCUSD', '1h', 10, 25), /超时/);
    } finally {
      global.WebSocket = real;
    }
  });

  test('onopen send throwing is routed through finish, not out of the callback', async () => {
    class SendBoom extends FakeWebSocket { send() { throw new Error('send on closed socket'); } }
    const real = global.WebSocket;
    global.WebSocket = SendBoom;
    try {
      const p = fetchTvBars('COINBASE:BTCUSD', '1h', 10, 5000);
      SendBoom.last.onopen();
      await assert.rejects(p, /send on closed socket/);
    } finally {
      global.WebSocket = real;
    }
  });

  test('late onopen/onmessage after finish are ignored — no send, no mutation', async () => {
    const t = nowSec() - 100;
    const sent = [];
    class LateWS extends FakeWebSocket { send(m) { sent.push(m); } }
    const real = global.WebSocket;
    global.WebSocket = LateWS;
    try {
      const p = fetchTvBars('COINBASE:BTCUSD', '1h', 10, 5000);
      const ws = LateWS.last;
      ws.onmessage({ data: feed([goodRow(t)]) }); // resolves via series_completed
      await p;
      const sentAfterResolve = sent.length;
      ws.onopen();                                 // late handshake: must not send
      ws.onmessage({ data: feed([goodRow(t + 3600)]) }); // late frame: must not mutate
      assert.equal(sent.length, sentAfterResolve, 'no send after finish');
      assert.equal(ws.closed, true);
    } finally {
      global.WebSocket = real;
    }
  });

  test('heartbeat frames are echoed back, not parsed as data', async () => {
    const t = nowSec() - 100;
    const sent = [];
    class EchoWS extends FakeWebSocket { send(m) { sent.push(m); } }
    const real = global.WebSocket;
    global.WebSocket = EchoWS;
    try {
      const p = fetchTvBars('COINBASE:BTCUSD', '1h', 10, 5000);
      const ws = EchoWS.last;
      ws.onmessage({ data: frame('~h~12345') + feed([goodRow(t)]) });
      await p;
      assert.ok(sent.some(m => m.includes('~h~12345')));
    } finally {
      global.WebSocket = real;
    }
  });
});
