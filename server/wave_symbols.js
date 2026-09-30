/**
 * Module 8 波浪研判标的白名单
 * 加密: BTC/ETH (币安 USDT 永续)
 * 柳玉冬跟踪标的: 币安 TradFi 永续 (报价口径与柳玉冬图表一致者才纳入; liu 为 data/liu_wave_threads.json 中的标的代码)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WAVE_SYMBOLS = [
  { symbol: 'BTCUSDT', display: 'BTC/USDT', name: '比特币', group: 'crypto', liu: 'BTC' },
  { symbol: 'ETHUSDT', display: 'ETH/USDT', name: '以太坊', group: 'crypto', liu: 'ETH' },
  { symbol: 'XAUUSDT', display: 'XAU/USDT', name: '黄金', group: 'liu', liu: 'XAU' },
  { symbol: 'XAGUSDT', display: 'XAG/USDT', name: '白银', group: 'liu', liu: 'XAG' },
  { symbol: 'CLUSDT', display: 'CL/USDT', name: 'WTI原油', group: 'liu', liu: 'CL' },
  { symbol: 'CRCLUSDT', display: 'CRCL/USDT', name: 'Circle', group: 'liu', liu: 'CRCL' },
  { symbol: 'HK1810USDT', display: 'HK1810/USDT', name: '小米集团', group: 'liu', liu: 'HK1810' },
  { symbol: 'SNDKUSDT', display: 'SNDK/USDT', name: '闪迪', group: 'liu', liu: 'SNDK' },
  { symbol: 'NVDAUSDT', display: 'NVDA/USDT', name: '英伟达', group: 'liu', liu: 'NVDA' },
  { symbol: 'MSTRUSDT', display: 'MSTR/USDT', name: 'Strategy', group: 'liu', liu: 'MSTR' },
  { symbol: 'GOOGLUSDT', display: 'GOOGL/USDT', name: '谷歌', group: 'liu', liu: 'GOOGL' },
  { symbol: 'INTCUSDT', display: 'INTC/USDT', name: '英特尔', group: 'liu', liu: 'INTC' },
  { symbol: 'AAPLUSDT', display: 'AAPL/USDT', name: '苹果', group: 'liu', liu: 'AAPL' },
  { symbol: 'MUUSDT', display: 'MU/USDT', name: '美光', group: 'liu', liu: 'MU' },
  { symbol: 'COINUSDT', display: 'COIN/USDT', name: 'Coinbase', group: 'liu', liu: 'COIN' },
  { symbol: 'PLTRUSDT', display: 'PLTR/USDT', name: 'Palantir', group: 'liu', liu: 'PLTR' },
  { symbol: 'SPCXUSDT', display: 'SPCX/USDT', name: 'SpaceX概念', group: 'liu', liu: 'SPCX' },
  { symbol: 'BABAUSDT', display: 'BABA/USDT', name: '阿里巴巴', group: 'liu', liu: 'BABA' }
];

const BY_SYMBOL = new Map(WAVE_SYMBOLS.map(s => [s.symbol, s]));

/** 归一化请求中的标的: 'xau/usdt' / 'XAU-USDT' / 'XAUUSDT' → 白名单条目 (不在白名单返回 null) */
function resolveWaveSymbol(raw) {
  const key = String(raw || 'BTCUSDT').toUpperCase().replace(/[\/\-_.]/g, '');
  return BY_SYMBOL.get(key) || BY_SYMBOL.get(key.replace(/^1810HK/, 'HK1810')) || null;
}

const THREADS_FILE = path.join(__dirname, '..', 'data', 'liu_wave_threads.json');
let threadsCache = null;

function loadLiuThreads() {
  if (threadsCache) return threadsCache;
  if (!fs.existsSync(THREADS_FILE)) return null;
  threadsCache = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
  return threadsCache;
}

/** 取某标的的柳玉冬波浪线程 (按时间串联)。无语料时返回 null */
function getLiuThread(entry) {
  const data = loadLiuThreads();
  if (!data || !entry || !entry.liu) return null;
  const th = data.symbols[entry.liu];
  if (!th) return null;
  return Object.assign({ methodLegend: data.methodLegend, note: data.note, schema: data.schema }, th);
}

module.exports = { WAVE_SYMBOLS, resolveWaveSymbol, getLiuThread, loadLiuThreads };
