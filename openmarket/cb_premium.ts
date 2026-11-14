//@lang=wrun-ts
// Coinbase 溢价（扣除 USDT 计价偏差）
// 名义溢价 = Coinbase BTC/USD ÷ 币安 BTC/USDT − 1，里面混着 USDT 自身对美元的偏离：
//   名义溢价 ≈ 真实溢价 + (USDT/USD − 1)
// 真实溢价 = Coinbase BTC/USD ÷ (币安 BTC/USDT × Coinbase USDT/USD) − 1，两边都折成真美元再比。
// 三个市场都固定指定，可挂在任何图表上，结果相同；图表只决定 K 线周期。单位：基点（bps）。

param.int("smooth", 15, { min: 1, max: 500, description: "真实溢价均线长度（K 线根数）" });

// 第一个 input 必须跟随图表（wrun 不允许指定市场），这里不参与计算
input("close", ohlcv.close);
input("cb_btcusd", ohlcv.close, { symbol: "BTC-USD", exchange: "COINBASE", missing: "nan", description: "Coinbase BTC/USD 现货收盘" });
input("bn_btcusdt", ohlcv.close, { symbol: "BTCUSDT", exchange: "BINANCE", missing: "nan", description: "币安 BTC/USDT 现货收盘" });
input("usdt_usd", ohlcv.close, { symbol: "USDT-USD", exchange: "COINBASE", description: "Coinbase USDT/USD 收盘（缺数据时沿用上一根）" });

// 柱子颜色：0 美国强 / 1 美国强但名义溢价显示相反 / 2 亚洲强 / 3 亚洲强但名义溢价显示相反
output("true_premium", histogram, lower, { label: "真实溢价 bps", format: "0.0", color_by: "regime", colors: ["#2eaf62", "#9be7b4", "#e53935", "#f4a3a1"] });
output("true_premium_ma", line, lower, { label: "真实溢价均线", format: "0.0", color: "#e0e0e0", width: 1.5 });
output("nominal_premium", line, lower, { label: "名义溢价 bps", format: "0.0", color: "#9e9e9e", width: 1, line_style: "dotted" });
output("usdt_dev", line, lower, { label: "USDT/USD 偏离 bps", format: "0.0", color: "#f5a623", width: 1 });
output("regime", none, lower, { label: "0 美国强 / 1 美国强·名义看反 / 2 亚洲强 / 3 亚洲强·名义看反" });

let ma = new Ema(15);

function onStart(): void {
  ma = new Ema(i32(p_smooth()));
}

function onBar(): void {
  const cb = in_cb_btcusd();
  const bn = in_bn_btcusdt();
  const u = in_usdt_usd();
  if (isNaN(cb) || isNaN(bn) || isNaN(u) || bn <= 0.0 || u <= 0.0) return;

  const nominal = (cb / bn - 1.0) * 10000.0;
  const real = (cb / (bn * u) - 1.0) * 10000.0;
  const dev = (u - 1.0) * 10000.0;
  // 名义溢价和真实溢价方向相反 = 只看名义价差会得出相反结论
  const misread = (nominal > 0.0) != (real > 0.0);

  out_true_premium(real);
  out_true_premium_ma(ma.update(real));
  out_nominal_premium(nominal);
  out_usdt_dev(dev);
  out_regime((real > 0.0 ? 0.0 : 2.0) + (misread ? 1.0 : 0.0));
}
