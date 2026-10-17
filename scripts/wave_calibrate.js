#!/usr/bin/env node
/**
 * 指引校准: 每条指引 (软规则) 对「先到目标」的实际预测力
 * -----------------------------------------------------------------------------
 * 与 wave_track_record.js 同一回放 (BTCUSDT / ETHUSDT 4H，每 STEP 根只用当时之前的 WINDOW 根运行引擎，
 * 取前 TOP 名候选的标准化预测并用之后的K线结算)，另外记下每个候选各条软规则的通过 / 不通过。
 *
 * 模型: logit P(命中) = logit(随机游走命中率) + b0 + Σ βj·xj
 *   xj = +1 通过 / -1 不通过 / 0 待验或不适用；随机游走命中率作为基准 (offset)，β 只学「超出随机」的部分。
 *   L2 正则 (λ)，按时间前 TRAIN_FRAC 训练、后段检验。
 * 检验指标: 检验段平均对数损失 (log-loss) 相对「只用随机游走」的改善 (skill = 1 − LL模型/LL基准)，
 *   以及按模型排序后首选计数的「命中 / 随机期望」。
 *
 * 用法: node scripts/wave_calibrate.js [--engine <path>] [--tag <name>] [--write]
 *   --engine  指定引擎文件 (对照不同版本)；默认 server/wave_engine.js
 *   --write   检验段 skill > 0 时把系数写进引擎的 <CALIBRATION> 区块
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { klines, resolve, lowerBound } = require('./wave_track_record.js');

const ROOT = path.join(__dirname, '..');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const WINDOW = 1000;
const STEP = 18;
const TOP = 3;
const TRAIN_FRAC = 0.7;
const LAMBDA = 2;            // L2 正则强度 (按样本数归一前)
const MIN_SUPPORT = 30;      // 训练段中该指引有通过 / 不通过记录的最少条数

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENGINE = path.resolve(arg('--engine') || path.join(ROOT, 'server', 'wave_engine.js'));
const TAG = arg('--tag') || 'current';
const OUT = path.join(ROOT, 'data', 'wave_calibration.json');

const logit = p => Math.log(p / (1 - p));
const sigm = z => 1 / (1 + Math.exp(-z));
const clip = p => Math.min(0.97, Math.max(0.03, p));

/** 远目标预测: 目标取现价之外第二近的目标，失效取计数否定位 (无则本段防线) */
function farForecast(c, last, f) {
  const px = last.close;
  const inv = c.negationPivot || c.monitoringPivot;
  if (!inv || !isFinite(inv.price)) return null;
  const dir = inv.price < px ? 1 : -1;
  if ((f.direction === 'UP' ? 1 : -1) !== dir) return null;
  const tg = (c.targets || []).filter(t => isFinite(t.price) && dir * (t.price - px) > 0)
    .sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px))[1];
  if (!tg) return null;
  const dT = Math.abs(tg.price - px), dI = Math.abs(inv.price - px);
  return { direction: f.direction, target: { price: tg.price }, invalidation: { price: inv.price }, deadline: f.deadline, rw: dI / (dI + dT) };
}

/**
 * 动能证据 (只量浪本身，不用指标参数): 浪速 = |涨跌幅| / 用时根数，浪量 = 该浪平均成交量。
 * 驱动浪: 浪3 浪速 / 浪量大于浪1 (浪3 动能最强)；浪5 浪速 / 浪量小于浪3 (浪5 背离)
 */
function momentumFeats(c, win) {
  const out = {};
  if (!/IMPULSE|DIAGONAL/.test(c.baseType) || !c.pivots || c.pivots.length < 4) return out;
  const P = c.pivots;
  const leg = k => {
    const a = P[k], b = P[k + 1];
    const n = Math.max(1, b.idx - a.idx);
    const bars = win.slice(a.idx + 1, b.idx + 1);
    const vol = bars.length ? bars.reduce((s, x) => s + (x.volume || 0), 0) / bars.length : 0;
    return { speed: Math.abs(b.price - a.price) / a.price / n, vol };
  };
  const L1 = leg(0), L3 = leg(2);
  out[`MOM:${c.baseType}:浪3速>浪1`] = L3.speed > L1.speed ? 1 : -1;
  if (L1.vol > 0) out[`VOL:${c.baseType}:浪3量>浪1`] = L3.vol > L1.vol ? 1 : -1;
  if (P.length >= 6 && !P[5].open) {
    const L5 = leg(4);
    out[`MOM:${c.baseType}:浪5速<浪3`] = L5.speed < L3.speed ? 1 : -1;
    if (L3.vol > 0) out[`VOL:${c.baseType}:浪5量<浪3`] = L5.vol < L3.vol ? 1 : -1;
  }
  return out;
}

async function collect(E) {
  const rows = [];
  for (const sym of SYMBOLS) {
    const h4 = await klines(sym, '4h', 10000);
    const h1 = await klines(sym, '1h', 1500 * 27);
    const seen = new Set();
    const t0 = Date.now();
    let runs = 0;
    for (let i = WINDOW; i < h4.length - 1; i += STEP) {
      const win = h4.slice(i - WINDOW + 1, i + 1);
      const sub = h1.slice(lowerBound(h1, win[0].time), lowerBound(h1, h4[i].time + 14400));
      let a;
      try { a = E.analyzeWaves(win, sym, { timeframe: '4h', subBars: { '1h': sub }, calibrate: false }); } catch (e) { continue; }
      runs++;
      (a.candidates || []).slice(0, TOP).forEach((c, rank) => {
        const f = c.forecast;
        if (!f) return;
        const sig = `${c.type}|${c.pivots.map(p => p.time).join(',')}|${f.target.price}|${f.invalidation.price}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        const r = resolve(h4, i, f);
        const feats = {};
        (c.ruleChecks || []).filter(x => !x.hard && !x.pending).forEach(x => { feats[`${c.baseType}:${x.id}`] = x.pass ? 1 : -1; });
        Object.assign(feats, momentumFeats(c, win));
        // 远目标预测: 第二近的目标对计数否定位 (近目标对本段防线时随机命中率约 3/4，几乎测不出计数对错)
        const far = farForecast(c, win[win.length - 1], f);
        const r2 = far ? resolve(h4, i, far) : null;
        rows.push({ sym, time: h4[i].time, rank, key: f.key, type: c.baseType, probability: c.probability, guidePct: c.guidePct,
          rw: f.randomWalkPct / 100, outcome: r.outcome,
          rwFar: far ? far.rw : null, outcomeFar: r2 ? r2.outcome : null, feats });
      });
      if (runs % 100 === 0) console.log(`  ${sym} ${runs} 次回放，${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  return rows.sort((x, y) => x.time - y.time);
}

/** 带 offset 的 L2 逻辑回归 (牛顿法太重，用全批梯度下降，特征少足够) */
function fit(rows, names, extra) {
  const X = rows.map(r => names.map(n => (r.feats[n] || 0)).concat(extra ? extra(r) : []));
  const y = rows.map(r => r.outcome === 'hit' ? 1 : 0);
  const off = rows.map(r => logit(clip(r.rw)));
  const d = (X[0] || []).length;
  let w = new Array(d).fill(0), b = 0;
  const lam = LAMBDA / rows.length;
  for (let it = 0; it < 4000; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < rows.length; i++) {
      let z = off[i] + b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = sigm(z) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
    }
    const lr = 0.5;
    b -= lr * gb / rows.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / rows.length + lam * w[j]);
  }
  const predict = r => {
    const x = names.map(n => (r.feats[n] || 0)).concat(extra ? extra(r) : []);
    let z = logit(clip(r.rw)) + b;
    for (let j = 0; j < d; j++) z += w[j] * x[j];
    return sigm(z);
  };
  return { w, b, predict };
}

const logLoss = (rows, p) => rows.reduce((s, r) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p(r))); return s - (r.outcome === 'hit' ? Math.log(q) : Math.log(1 - q)); }, 0) / rows.length;
const brier = (rows, p) => rows.reduce((s, r) => s + (p(r) - (r.outcome === 'hit' ? 1 : 0)) ** 2, 0) / rows.length;

function topEdge(rows, score) {
  const byRun = {};
  rows.forEach(r => { (byRun[`${r.sym}|${r.time}`] = byRun[`${r.sym}|${r.time}`] || []).push(r); });
  let hits = 0, exp = 0, n = 0;
  for (const list of Object.values(byRun)) {
    const best = list.slice().sort((a, b) => score(b) - score(a))[0];
    n++; exp += best.rw; if (best.outcome === 'hit') hits++;
  }
  return { n, hits, expected: +exp.toFixed(1), ratio: exp ? +(hits / exp).toFixed(3) : null };
}

function writeBlock(model) {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'wave_engine.js'), 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const a = src.indexOf('// <CALIBRATION>'), b = src.indexOf('// </CALIBRATION>');
  if (a < 0 || b < 0) throw new Error('engine has no <CALIBRATION> block');
  const lineStart = src.lastIndexOf('\n', a) + 1;
  const indent = src.slice(lineStart, a);
  const body = `// <CALIBRATION> 由 scripts/wave_calibrate.js 生成，勿手改${nl}${indent}const CALIBRATION = ${JSON.stringify(model)};${nl}${indent}`;
  fs.writeFileSync(path.join(ROOT, 'server', 'wave_engine.js'), src.slice(0, a) + body + src.slice(b));
}

function analyze(rows, label) {
  const res = rows.filter(r => r.outcome === 'hit' || r.outcome === 'miss');
  const cut = res[Math.floor(res.length * TRAIN_FRAC)].time;
  const train = res.filter(r => r.time < cut), test = res.filter(r => r.time >= cut);

  // 指引: 训练段中通过、不通过各至少有一些记录
  const support = {};
  train.forEach(r => Object.entries(r.feats).forEach(([k, v]) => { const s = support[k] = support[k] || { pass: 0, fail: 0 }; if (v > 0) s.pass++; else s.fail++; }));
  const names = Object.keys(support).filter(k => support[k].pass + support[k].fail >= MIN_SUPPORT && support[k].fail >= 5 && support[k].pass >= 5).sort();

  const base = r => clip(r.rw);
  const guide = fit(train, [], r => [(r.guidePct - 60) / 20]);
  const full = fit(train, names);
  const prob = fit(train, [], r => [(r.probability - 40) / 20]);

  const llBase = logLoss(test, base);
  const ev = (nm, p) => { const ll = logLoss(test, p); return { model: nm, logLoss: +ll.toFixed(4), brier: +brier(test, p).toFixed(4), skill: +(1 - ll / llBase).toFixed(4) }; };
  const models = [ev('随机游走基准', base), ev('指引符合度 guidePct', guide.predict), ev('候选概率 probability', prob.predict), ev(`逐条指引（${names.length} 条）`, full.predict)];

  // 单条指引: 只用这一条拟合的检验段 skill，以及训练 / 检验段通过 vs 不通过的「命中/期望」
  const perRule = names.map((n, j) => {
    const stat = (set, v) => { const s = set.filter(r => r.feats[n] === v); const h = s.filter(r => r.outcome === 'hit').length, e = s.reduce((a, r) => a + r.rw, 0); return { n: s.length, ratio: e ? +(h / e).toFixed(3) : null }; };
    const solo = fit(train.filter(r => r.feats[n]), [n]);
    const tset = test.filter(r => r.feats[n]);
    const soloSkill = tset.length >= 20 ? +(1 - logLoss(tset, solo.predict) / logLoss(tset, base)).toFixed(4) : null;
    return { rule: n, beta: +full.w[j].toFixed(3), soloBeta: +solo.w[0].toFixed(3), soloSkill, trainPass: stat(train, 1), trainFail: stat(train, -1), testPass: stat(test, 1), testFail: stat(test, -1) };
  }).sort((x, y) => (y.soloSkill || -1) - (x.soloSkill || -1));

  const report = {
    label, trainCut: new Date(cut * 1000).toISOString().slice(0, 10), resolved: res.length, train: train.length, test: test.length,
    hitPct: Math.round(100 * res.filter(r => r.outcome === 'hit').length / res.length), randomWalkPct: Math.round(100 * res.reduce((x, r) => x + r.rw, 0) / res.length),
    models,
    topTest: { engineRank: topEdge(test, r => -r.rank), guidePct: topEdge(test, r => r.guidePct), perRuleModel: topEdge(test, r => full.predict(r) - base(r)) },
    perRule
  };
  console.log(`\n[${TAG} · ${label}] 已结算 ${res.length} 条（命中 ${report.hitPct}%，随机期望 ${report.randomWalkPct}%；训练 ${train.length} / 检验 ${test.length}，分界 ${report.trainCut}）`);
  models.forEach(m => console.log(`  ${m.model.padEnd(22)} 检验段 log-loss ${m.logLoss}  Brier ${m.brier}  skill ${m.skill}`));
  console.log('  检验段首选计数 命中/随机期望：', JSON.stringify(report.topTest));
  console.log('  单条指引（按单独拟合的检验段 skill 排序，前 10 与动能项）：');
  perRule.filter((p, k) => k < 10 || /^(MOM|VOL):/.test(p.rule)).forEach(p => console.log(`    ${p.rule.padEnd(26)} 单独skill=${p.soloSkill}  β=${p.soloBeta}  训练 通过${p.trainPass.ratio}(${p.trainPass.n}) 不通过${p.trainFail.ratio}(${p.trainFail.n})  检验 通过${p.testPass.ratio}(${p.testPass.n}) 不通过${p.testFail.ratio}(${p.testFail.n})`));
  return { report, res, names, models };
}

async function main() {
  const E = require(ENGINE);
  const cacheFile = path.join(os.tmpdir(), 'liu_replay_cache', `calib_${TAG}_${new Date().toISOString().slice(0, 10)}.json`);
  let rows;
  if (fs.existsSync(cacheFile) && !process.argv.includes('--fresh')) rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  else { rows = await collect(E); fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(rows)); }

  const near = analyze(rows, '近目标·本段防线');
  const far = analyze(rows.filter(r => r.outcomeFar).map(r => Object.assign({}, r, { rw: r.rwFar, outcome: r.outcomeFar })), '远目标·计数否定位');
  fs.writeFileSync(OUT.replace('.json', `_${TAG}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), engine: path.relative(ROOT, ENGINE), tag: TAG,
    symbols: SYMBOLS, window: WINDOW, step: STEP, top: TOP, near: near.report, far: far.report }, null, 1));
  const { res, names, models } = near;

  if (process.argv.includes('--write')) {
    const m = models[3];
    if (m.skill > 0) {
      const all = fit(res, names);
      writeBlock({ generatedAt: new Date().toISOString().slice(0, 10), source: `${SYMBOLS.join('/')} 4H 回放 ${res.length} 条`, testSkill: m.skill, b0: +all.b.toFixed(4),
        coef: Object.fromEntries(names.map((n, j) => [n, +all.w[j].toFixed(4)])) });
      console.log('→ 已写入引擎 <CALIBRATION>');
    } else console.log('→ 检验段 skill ≤ 0，不写入引擎');
  }
}

if (require.main === module) main();
