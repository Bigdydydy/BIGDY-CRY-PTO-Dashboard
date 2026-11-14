const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const ema = app.slice(app.indexOf('function flowEma('), app.indexOf('/** Coinbase 溢价'));
const render = app.slice(app.indexOf('function renderFlowChart('), app.indexOf('function initFlowForceEvents('));

test('Flow chart: missing rows are whitespace, EMA resets, and premium line breaks at missing FX', () => {
  const output = {};
  const context = vm.createContext({
    rawFlowData: { series: [
      { time: 1, hist: 8, region: 1, missing: [], usPremiumBps: 2 },
      // Protect against legacy API responses that still send a direction.
      { time: 2, hist: -30, region: -1, missing: ['bnPerp'], usPremiumBps: null },
      { time: 3, hist: -2, region: -1, missing: [], usPremiumBps: 1 }
    ] },
    flowChart: {}, flowSmooth: 3, flowRowsByTime: null, flowCandlesByTime: null,
    FLOW_RED: 'red', FLOW_GREEN: 'green',
    flowPremium: p => p.usPremiumBps, updateFlowCrosshair() {},
    flowSeries: Object.fromEntries(['hist', 'dots', 'prem', 'candles', 'volume'].map(k => [k, { setData(data) { output[k] = data; } }]))
  });
  vm.runInContext(ema + render + '\nrenderFlowChart();', context);
  assert.equal(output.hist[1].value, undefined, 'no fabricated bar at missing venue');
  assert.equal(output.dots[1].value, undefined, 'no regional dot at missing venue');
  assert.equal(output.prem[1].value, undefined, 'line cannot connect across missing FX');
  assert.equal(output.hist[2].value, 2, 'new EMA begins at recovered value, ignoring pre-gap history');
  assert.equal(output.dots[2].value, 1);
});
