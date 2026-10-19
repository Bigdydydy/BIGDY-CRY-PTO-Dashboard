/**
 * TradingView 行情 websocket 的最小客户端：按 交易所:代码 拉一段历史K线。
 *
 * 用途：直连交易所 REST 被网络拦截时 (如本机无法访问 api.exchange.coinbase.com)，
 * 仍能拿到同一交易所的原始K线——TradingView 的 COINBASE:BTCUSD 就是 Coinbase 撮合成交。
 * 非官方协议，只作备用源；依赖 Node 22+ 的全局 WebSocket (undici，支持自定义 Origin 头)。
 */

const TV_WS_URL = 'wss://data.tradingview.com/socket.io/websocket?type=chart';
const TV_INTERVAL = { '15m': '15', '1h': '60', '4h': '240', '1d': '1D', '1w': '1W' };

const MAX_FUTURE_SKEW_S = 300;

/** Strict raw [t,o,h,l,c,vol] row check — a malformed or short row is an
 * error, never silently zero-filled. Returns the row or null. */
function validTvRow(r) {
  const v = r && r.v;
  if (!Array.isArray(v) || v.length < 6) return null;
  const [t, o, h, l, c, vol] = v;
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t * 1000 > Date.now() + MAX_FUTURE_SKEW_S * 1000) return null;
  if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0)) return null;
  if (h < l) return null;
  if (!Number.isFinite(vol) || vol < 0) return null; // 缺成交量不可伪造 0
  return v;
}

const frame = obj => {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return `~m~${s.length}~m~${s}`;
};

/** 拆开 "~m~<len>~m~<payload>" 拼接的多帧消息 */
function splitFrames(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const m = /^~m~(\d+)~m~/.exec(raw.slice(i, i + 24));
    if (!m) break;
    const start = i + m[0].length;
    out.push(raw.slice(start, start + Number(m[1])));
    i = start + Number(m[1]);
  }
  return out;
}

/**
 * @param symbol 如 'COINBASE:BTCUSD'
 * @param tf '15m' | '1h' | '4h' | '1d' | '1w' (周线为周一 00:00 UTC 起始，与币安/OKX 一致)
 * @returns [{ t: 开盘毫秒, o, h, l, c, vol: 基础币成交量 }] 升序
 */
function fetchTvBars(symbol, tf, count = 300, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('运行时缺少 WebSocket (需 Node 22+)'));
    const interval = TV_INTERVAL[tf];
    if (!interval) return reject(new Error(`不支持周期 ${tf}`));

    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    const bars = new Map();
    let settled = false;
    let ws;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`TradingView ${symbol} 超时`)), timeoutMs);

    try {
      ws = new WebSocket(TV_WS_URL, { headers: { Origin: 'https://www.tradingview.com' } });
    } catch (e) {
      clearTimeout(timer);
      return reject(e);
    }
    const send = (m, p) => ws.send(frame({ m, p }));

    ws.onopen = () => {
      if (settled) return; // 握手晚于超时/关闭才到：不再发送，也不再改变结果
      try {
        send('set_auth_token', ['unauthorized_user_token']);
        send('chart_create_session', [session, '']);
        send('resolve_symbol', [session, 'sym_1', '=' + JSON.stringify({ symbol, adjustment: 'splits' })]);
        send('create_series', [session, 's1', 's1', 'sym_1', interval, count, '']);
      } catch (e) {
        finish(e instanceof Error ? e : new Error(`TradingView ${symbol} 握手发送失败`));
      }
    };
    ws.onmessage = ev => {
      if (settled) return; // 已 finish：迟到的帧不得再修改结果
      try {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
        for (const msg of splitFrames(raw)) {
          if (msg.startsWith('~h~')) { ws.send(frame(msg)); continue; } // 心跳原样回传
          let j;
          try { j = JSON.parse(msg); } catch (e) { continue; }
          if (j.m === 'timescale_update' || j.m === 'du') {
            const rows = j.p && j.p[1] && j.p[1].s1 && j.p[1].s1.s;
            if (Array.isArray(rows)) {
              for (const r of rows) {
                const v = validTvRow(r);
                if (v === null) {
                  return finish(new Error(`TradingView ${symbol} K线行 schema 校验失败`));
                }
                bars.set(v[0], v);
              }
            }
          } else if (j.m === 'series_completed') {
            const out = [...bars.values()]
              .sort((a, b) => a[0] - b[0])
              .map(v => ({ t: v[0] * 1000, o: v[1], h: v[2], l: v[3], c: v[4], vol: v[5] }));
            finish(out.length ? null : new Error(`TradingView ${symbol} 空数据`), out);
          } else if (j.m === 'symbol_error' || j.m === 'series_error' || j.m === 'critical_error') {
            finish(new Error(`TradingView ${symbol}: ${j.m}`));
          }
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error(`TradingView ${symbol} 消息处理失败`));
      }
    };
    ws.onerror = e => finish(new Error(`TradingView websocket: ${(e && e.message) || 'error'}`));
    ws.onclose = () => finish(new Error(`TradingView ${symbol} 连接提前关闭`));
  });
}

module.exports = { fetchTvBars, splitFrames };
