/**
 * 柳玉冬波浪语料 — 标的归一化表
 * code: 语料内部标的代码; name: 中文名; match: 在「品种/周期」行或正文 hashtag 中识别的正则;
 * binance: 币安 USDT 永续(TradFi)合约代码 —— 仅当其报价口径与柳玉冬图中价位一致时才填写
 *          (如 POPMART/SKHYNIX 为美元折算价，与港币/韩元图不一致，故不映射)。
 */
'use strict';

const SYMBOLS = [
  { code: 'XAU', name: '黄金', match: /黄金ETF/, binance: null, alias: 'GLD' },
  { code: 'XAU', name: '黄金', match: /黄金|XAU|PAX ?Gold/i, binance: 'XAUUSDT' },
  { code: 'XAG', name: '白银', match: /白银|XAG|沪银/i, binance: 'XAGUSDT' },
  { code: 'CL', name: 'WTI原油', match: /原油|CL!|\bWTI\b|USOIL/i, binance: 'CLUSDT' },
  { code: 'BTC', name: '比特币', match: /比特币|\bBTC|大饼/i, binance: 'BTCUSDT' },
  { code: 'ETH', name: '以太坊', match: /以太坊|\bETH\b/i, binance: 'ETHUSDT' },
  { code: 'HK1810', name: '小米集团', match: /小米|1810/, binance: 'HK1810USDT' },
  { code: 'POPMART', name: '泡泡玛特', match: /泡泡玛特|9992|Labubu|拉布布/i, binance: null },
  { code: 'MP', name: 'MP Materials', match: /MP Materials|#MP#|马匹材料/i, binance: null },
  { code: 'TEM', name: 'Tempus AI', match: /Tempus|#TEM#|\(TEM\)/i, binance: null },
  { code: 'AAPL', name: '苹果', match: /苹果|AAPL/i, binance: 'AAPLUSDT' },
  { code: 'MSTR', name: 'Strategy(微策略)', match: /微策略|MSTR|SMTR|Strategy Inc|#策略#/i, binance: 'MSTRUSDT' },
  { code: 'COIN', name: 'Coinbase', match: /coinbase|\bCOIN\b|康恩贝斯/i, binance: 'COINUSDT' },
  { code: '600141', name: '兴发集团', match: /兴发/, binance: null },
  { code: 'NVDA', name: '英伟达', match: /英伟达|NVDA/i, binance: 'NVDAUSDT' },
  { code: 'MU', name: '美光', match: /美光|Micron|\bMU\b/i, binance: 'MUUSDT' },
  { code: 'INTC', name: '英特尔', match: /英特尔|INTC/i, binance: 'INTCUSDT' },
  { code: 'CRCL', name: 'Circle', match: /circle|CRCL|环状网络/i, binance: 'CRCLUSDT' },
  { code: 'SKHYNIX', name: 'SK海力士', match: /海力士|000660/, binance: null },
  { code: 'STAR50', name: '科创50', match: /科创50/, binance: null },
  { code: '300450', name: '先导智能', match: /先导智能|300450/, binance: null },
  { code: 'HK0700', name: '腾讯控股', match: /腾讯|0700/, binance: 'HK0700USDT' },
  { code: 'BABA', name: '阿里巴巴', match: /阿里巴巴|BABA/i, binance: 'BABAUSDT' },
  { code: 'GOOGL', name: '谷歌', match: /谷歌|GOOG/i, binance: 'GOOGLUSDT' },
  { code: 'SNDK', name: '闪迪', match: /闪迪|SNDK|Sandisk/i, binance: 'SNDKUSDT' },
  { code: 'PLTR', name: 'Palantir', match: /Palantir|PLTR|帕兰蒂尔/i, binance: 'PLTRUSDT' },
  { code: 'AMD', name: 'AMD', match: /\bAMD\b/, binance: 'AMDUSDT' },
  { code: 'IXIC', name: '纳斯达克指数', match: /纳斯达克|IXIC|纳指/, binance: null },
  { code: '600519', name: '贵州茅台', match: /茅台|600519/, binance: null },
  { code: 'SPCX', name: 'SpaceX概念(SPCX)', match: /SpaceX|spacex|SPCX/i, binance: 'SPCXUSDT' },
  { code: 'HOOD', name: 'Robinhood', match: /Robinhood|HOOD|罗宾汉/i, binance: 'HOODUSDT' },
  { code: 'MRVL', name: 'Marvell', match: /MRVL|迈威尔/i, binance: 'MRVLUSDT' },
  { code: 'IBM', name: 'IBM', match: /\bIBM\b/, binance: 'IBMUSDT' },
  { code: 'SMR', name: 'NuScale', match: /#SMR#|NuScale/i, binance: null },
  { code: 'BE', name: 'Bloom Energy', match: /Bloom Energy|#BE#/i, binance: 'BEUSDT' },
  { code: 'GLW', name: '康宁', match: /康宁|GLW/i, binance: 'GLWUSDT' },
  { code: 'LITE', name: 'Lumentum', match: /Lumentum|LITE/i, binance: 'LITEUSDT' },
  { code: 'ARM', name: 'ARM', match: /\bARM\b/, binance: 'ARMUSDT' },
  { code: 'ZM', name: 'Zoom', match: /Zoom|\bZM\b/i, binance: 'ZMUSDT' },
  { code: '300408', name: '三环集团', match: /三环集团|300408/, binance: null },
  { code: '688008', name: '澜起科技', match: /澜起|688008/, binance: null },
  { code: 'HK2577', name: '英诺赛科', match: /英诺赛科|2577/, binance: null },
  { code: '002460', name: '赣锋锂业', match: /赣锋|002460/, binance: null },
  { code: '002050', name: '三花智控', match: /三花|002050/, binance: null },
  { code: '600030', name: '中信证券', match: /中信证券|600030/, binance: null },
  { code: 'DXY', name: '美元指数', match: /美元指数|DXY/, binance: null },
  { code: 'SPX', name: '标普500', match: /标普|S&P ?500|\bSPX\b/, binance: null }
];

function symbolOf(text) {
  if (!text) return null;
  for (const s of SYMBOLS) {
    if (s.match.test(text)) return s.alias ? null : s;
  }
  return null;
}

function symbolByCode(code) {
  return SYMBOLS.find(s => s.code === code && !s.alias) || null;
}

module.exports = { SYMBOLS, symbolOf, symbolByCode };
