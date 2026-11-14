const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const block = src.slice(src.indexOf('let rawMcClellanData = null;'), src.indexOf('function renderMcClellanStructure()'));

test('Core recovery labels historical zero with its date and leaves Meme live', () => {
  const els = {};
  const sandbox = { document: { getElementById: id => els[id] ||= { textContent: '', className: '' } } };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  sandbox.renderMcClellanCharts = () => {};
  sandbox.renderMcClellanStructure = () => {};
  sandbox.data = {
    current: {
      core: { ready: false, date: '2026-11-14', valid_streak_days: 1,
        last_valid: { date: '2026-11-12', oscillator: 0, summation: -100 },
        last_reset: { date: '2026-11-13', reason: 'incomplete_quotes', constituents: 99,
          expected_constituents: 100, missing_members: ['quantixai'] } },
      frontier: { ready: true, oscillator: -18.17, summation: -31.2 }
    }
  };
  vm.runInContext('renderMcClellanDashboard(data)', sandbox);
  assert.equal(els['kpi-mc-core-osc'].textContent, '重新预热');
  assert.match(els['kpi-mc-core-osc-sub'].textContent, /2026-11-12：0\.0（历史值）/);
  assert.equal(els['kpi-mc-core-sum'].textContent, '--');
  assert.equal(els['kpi-mc-fr-osc'].textContent, '-18.2');
  const notice = vm.runInContext('mcRecoveryText(data.current.core, 40)', sandbox);
  assert.match(notice, /2026-11-13.*99\/100.*quantixai/);
  assert.match(notice, /1\/40/);
});

test('First warmup has no invented last value or reset reason', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const notice = vm.runInContext('mcRecoveryText({ valid_streak_days: 2 }, 40)', sandbox);
  assert.match(notice, /2\/40/);
  assert.doesNotMatch(notice, /重置|最后有效/);
});
