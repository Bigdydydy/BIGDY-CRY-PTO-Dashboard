#!/usr/bin/env node
/**
 * 柳玉冬波浪语料 → 按标的时间串联的「波浪脉络线程」(Liu Wave Threads)
 * -----------------------------------------------------------------------------
 * 输入: 微博 OCR 语料目录 (每帖一个子目录, 内含 info.txt: 正文 + 「=== 波浪图解识别 ===」图解文字)
 * 输出: data/liu_wave_threads.json
 *
 * 只读取文本 (info.txt)，不读取图片。对每个标的:
 *   1. 按时间排列帖子, 抽取 监测点 / 目标 / 区间 / 支撑压力 / 浪型关键词 / 柳氏方法标签 / 多空倾向
 *   2. 价位谱系 (lineage): 同一价位在后续帖子中被「实现/跌破/刺破/守住」即串联成一条链
 *   3. 监测点轨迹 (monitorTrail): 「监测点战法」的逐日上移/下移序列
 *   4. 叙事段 (arcs): 多空倾向翻转或浪型修正处切段, 形成该标的的波浪逻辑演进
 *
 * 用法: node scripts/liu_threads/build_liu_threads.js [语料目录] [输出文件]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { symbolOf, symbolByCode } = require('./symbols');

const DEFAULT_CORPUS = process.env.LIU_CORPUS_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity', 'scratch', 'weibo_market_analysis_2026');
const DEFAULT_OUT = path.join(__dirname, '..', '..', 'data', 'liu_wave_threads.json');

const NUM = '(\\d{1,7}(?:\\.\\d{1,4})?)';

// ---------------------------------------------------------------------------
// 1. 解析 info.txt
// ---------------------------------------------------------------------------

function parsePost(dir, name) {
  const file = path.join(dir, name, 'info.txt');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const m = name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_/);
  if (!m) return null;
  const idm = name.match(/_([A-Za-z0-9]{6,12})$/);
  const link = (raw.match(/链接:\s*(\S+)/) || [])[1] || null;
  const body = raw.includes('正文:') ? raw.split('正文:').slice(1).join('正文:') : raw;
  const [textPart, ocrPart = ''] = body.split('=== 波浪图解识别 ===');
  const charts = [];
  for (const blk of ocrPart.split(/--- 图 \d+ ---/)) {
    const inst = (blk.match(/品种\/周期[:：]\s*(.+)/) || [])[1];
    if (!inst) continue;
    const field = key => {
      const mm = blk.match(new RegExp(key + '[^:：\\n]*[:：]\\s*([\\s\\S]*?)(?=\\n\\S[^\\n]{0,12}[:：]|\\n\\s*$|$)'));
      return mm ? mm[1].trim() : '';
    };
    charts.push({
      instrument: inst.trim(),
      symbol: symbolOf(inst),
      timeframe: tfOf(inst),
      drawing: field('画线拆解'),
      levelsLine: field('关键价位'),
      degreeRelation: field('浪级关系'),
      annotation: field('图中文字')
    });
  }
  return {
    id: idm ? idm[1] : name,
    dir: name,
    date: m[1],
    time: `${m[2]}:${m[3]}`,
    ts: Date.parse(`${m[1]}T${m[2]}:${m[3]}:00+08:00`) / 1000,
    link,
    text: textPart.replace(/​/g, '').replace(/\s+/g, ' ').trim(),
    charts
  };
}

function tfOf(inst) {
  if (/5分钟/.test(inst)) return '5m';
  if (/15分钟/.test(inst)) return '15m';
  if (/4小时/.test(inst)) return '4h';
  if (/1小时|小时线|小时图/.test(inst)) return '1h';
  if (/3日/.test(inst)) return '3d';
  if (/周线/.test(inst)) return '1w';
  if (/月线/.test(inst)) return '1M';
  if (/日线/.test(inst)) return '1d';
  return null;
}

// ---------------------------------------------------------------------------
// 2. 抽取: 价位 / 浪型 / 方法标签 / 倾向
// ---------------------------------------------------------------------------

const PATTERN_WORDS = [
  ['推动浪', /推动浪|驱动浪/], ['引导楔形', /引导楔形/], ['终结楔形', /终结楔形|衰竭楔形/],
  ['单锯齿', /单锯齿/], ['双锯齿', /双锯齿/], ['三锯齿', /三锯齿|三重锯齿|三重三浪/],
  ['平台形', /平台形/], ['联合形', /联合形|横平/], ['三角形', /三角形/]
];

// 柳氏实战方法标签 (语料中反复出现、可被引擎形式化的判据)
const METHOD_TAGS = [
  ['MONITOR', '监测点战法', /监测点/],
  ['LARGEST_COUNTERMOVE', '最大回撤/最大反弹判据', /最大(?:的)?(?:回撤|反弹)|反弹量|回撤量/],
  ['EAT_BACK', '吃掉0.7/0.8判据', /吃掉|0\.[789]倍|的0\.[789](?!\d)|70%|80%/],
  ['NOT_MOTIVE', '非推动浪不做底/顶', /不是.{0,6}(?:推动|驱动)浪|不符合推动浪|没有.{0,6}推动浪|不能发展为.{0,4}推动浪/],
  ['MOTIVE_FORMED', '已形成推动浪', /(?:形成|发展为|走出)(?:了)?.{0,4}推动浪|走了5段/],
  ['LEADING_DIAGONAL', '引导楔形可行性', /引导楔形/],
  ['PARTS', '调整分部(第一/二/三部分)', /第[一二三四]部分|第[一二]阶段/],
  ['DEGREE', '级别扩大/小级别顶底', /扩大.{0,4}级别|很?小级别(?:见)?[顶底]/],
  ['VALUE_ZONE', '便宜区/建仓区', /便宜区|建仓区/],
  ['TIME_RULE', '时间规则/时间窗', /时间规则|\d+[号日]之前|时间.{0,6}1\.618/],
  ['EXT_LIMIT', '上涨/下跌极限', /极限/],
  ['RETRACE_RANGE', '正常回撤0.2-0.618(极限0.8)', /0\.2\s*[-–—~]{1,2}\s*0\.618|0\.618\s*[-–—~]{1,2}\s*0\.8/],
  ['REVISION', '浪型修正', /修正|改(?:为|成)|重新(?:标注|数)/]
];

const BULL_CUES = /以后(?:又|还)?是上涨|还有上涨|上涨目标|继续涨|继续上涨|上涨动力|还有涨|看涨|空头(?:已经|基本就?|就)?败|空头失败|向多头有利|还能(?:再)?涨|会继续涨|再涨|有望|反弹(?:正在|开始)|见底|做底/g;
const BEAR_CUES = /下跌目标|还有下跌|下跌动力|继续跌|继续下跌|提高警惕|警惕|见顶|看跌|看空|下跌风险|再跌|还有下跌|多头(?:已经)?败|结束.{0,4}上涨|不是底/g;

function plausible(v) { return isFinite(v) && v > 0; }

function isNoiseNumber(src, idx, len) {
  const before = src.slice(Math.max(0, idx - 2), idx);
  const after = src.slice(idx + len, idx + len + 2);
  if (/^[年月日号点时分天根段浪倍%个次条秒周期]/.test(after)) return true;
  if (/[的第]$/.test(before) && /^倍/.test(after)) return true;
  if (/^(?:年|\/)/.test(after)) return true;
  if (/[年月]$/.test(before)) return true;
  return false;
}

function grab(re, src, kind, extra) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    for (let gi = 1; gi < m.length; gi++) {
      if (!m[gi]) continue;
      const v = parseFloat(m[gi]);
      const at = m.index + m[0].lastIndexOf(m[gi]);
      if (!plausible(v) || isNoiseNumber(src, at, m[gi].length)) continue;
      out.push(Object.assign({ kind, price: v, phrase: src.slice(Math.max(0, m.index - 6), Math.min(src.length, m.index + m[0].length + 14)) }, extra ? extra(m, gi) : {}));
    }
  }
  return out;
}

function extractLevels(src) {
  const levels = [];
  // 监测点: 方向由上下文判定 (跌破→下方支撑型, 冲过/上不去→上方压力型)
  levels.push(...grab(new RegExp(`监测点(?:在|是|为|抬升到|上移至|[:：])?\\s*${NUM}`, 'g'), src, 'monitor', m => {
    // 紧随价位的从句优先 (「监测点4838，价格不低于它…」)，其次看前置修饰 (「上方监测点」)
    const near = src.slice(m.index + m[0].length, m.index + m[0].length + 16).replace(/[。；;].*$/, '');
    const pre = src.slice(Math.max(0, m.index - 6), m.index);
    const BELOW = /不跌破|不低于|跌破|守住|之上|以上/;
    const ABOVE = /上不去|过不去|冲过|冲破|涨破|突破|收复|站上|之下|以下/;
    let side = null;
    if (BELOW.test(near)) side = 'below';
    else if (ABOVE.test(near)) side = 'above';
    else if (/下方/.test(pre)) side = 'below';
    else if (/上方/.test(pre)) side = 'above';
    return { side };
  }));
  levels.push(...grab(new RegExp(`${NUM}\\s*(?:元)?(?:的)?(?:短期)?监测点`, 'g'), src, 'monitor', () => ({ side: null })));
  levels.push(...grab(new RegExp(`(?:只要)?(?:不跌破|不低于|守住|维持在?)\\s*${NUM}`, 'g'), src, 'monitor', () => ({ side: 'below' })));
  levels.push(...grab(new RegExp(`(?<!不)(?:冲过|冲破|涨破|突破|站上|上不去|过不去|冲上|收复|刺破)\\s*${NUM}`, 'g'), src, 'trigger', m => ({ side: /上不去|过不去/.test(m[0]) ? 'above' : null })));
  levels.push(...grab(new RegExp(`不涨破\\s*${NUM}`, 'g'), src, 'monitor', () => ({ side: 'above' })));
  levels.push(...grab(new RegExp(`(?<!不)跌破\\s*${NUM}`, 'g'), src, 'trigger', () => ({ side: 'below' })));
  // 目标
  levels.push(...grab(new RegExp(`(?:上涨|下跌|反弹|远期)?目标(?:位|价|区)?(?:是|在|为)?\\s*${NUM}(?:\\s*(?:和|与|、|及)\\s*${NUM})?`, 'g'), src, 'target'));
  levels.push(...grab(new RegExp(`(?:上看|可能(?:到达|跌到|涨到|跌向|冲击)|有可能(?:跌到|涨到|冲击)|冲击)\\s*${NUM}`, 'g'), src, 'target'));
  levels.push(...grab(new RegExp(`${NUM}\\s*(?:元)?(?:目标|的目标)(?:顺利)?(?:实现|到达|达成)`, 'g'), src, 'target_hit'));
  // 支撑 / 压力
  levels.push(...grab(new RegExp(`支撑(?:位|带|区)?(?:在|是)?\\s*${NUM}`, 'g'), src, 'support'));
  levels.push(...grab(new RegExp(`压力(?:位|带|区)?(?:在|是|继续在)?\\s*${NUM}`, 'g'), src, 'resistance'));
  return levels;
}

function extractZones(src) {
  const zones = [];
  const re = new RegExp(`${NUM}\\s*(?:--|—|–|-|~|到)\\s*${NUM}`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (!plausible(a) || !plausible(b) || a === b) continue;
    if (Math.max(a, b) / Math.min(a, b) > 3) continue;
    if (/^\d{4}$/.test(m[1]) && /^(19|20)\d{2}$/.test(m[1]) && /^(19|20)\d{2}$/.test(m[2])) continue; // 年份区间
    const pre = src.slice(Math.max(0, m.index - 14), m.index);
    const post = src.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^[年月日号]/.test(post) || /[年月]$/.test(pre)) continue;
    if (Math.min(a, b) < 1 && /0\.\d/.test(m[1])) continue; // 比率区间 0.2-0.618
    let label = 'zone';
    const ctx = pre + post;
    if (/便宜|建仓/.test(ctx)) label = 'value_zone';
    else if (/支撑/.test(ctx)) label = 'support_zone';
    else if (/压力/.test(ctx)) label = 'resistance_zone';
    else if (/目标|见顶|见底|到达|范围|区间|之间/.test(ctx)) label = 'target_zone';
    else continue;
    zones.push({ lo: Math.min(a, b), hi: Math.max(a, b), label, phrase: (pre + m[0] + post).trim() });
  }
  return zones;
}

function extractWaveTags(src) {
  const tags = new Set();
  const re = /(?:看作|认为是|是|为|走|进入|运行|在)(?:大级别|小级别)?(?:第)?([1-5]|[ⅰⅱⅲⅳⅴ]|[abcdexyzw]{1,2}|[ABCDEXYZW]{1,2}|[1-5]-[1-5](?:-[1-5])?)浪/g;
  let m;
  while ((m = re.exec(src))) tags.add(m[1].toLowerCase());
  return Array.from(tags);
}

function stanceOf(src) {
  const bull = (src.match(BULL_CUES) || []).length;
  const bear = (src.match(BEAR_CUES) || []).length;
  if (bull > bear) return 'BULL';
  if (bear > bull) return 'BEAR';
  return bull ? 'MIXED' : 'NEUTRAL';
}

function dedupeLevels(levels, ref) {
  const seen = new Map();
  for (const l of levels) {
    if (ref && (l.price < ref * 0.25 || l.price > ref * 4)) continue;
    const key = l.kind + '|' + l.price;
    if (!seen.has(key)) seen.set(key, l);
  }
  return Array.from(seen.values());
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------
// 3. 串联: 价位谱系 / 监测点轨迹 / 叙事段
// ---------------------------------------------------------------------------

// 后续帖子对同一价位的引用: 动词须紧贴价位 (前置「跌破4537」或后置「4826顺利实现」)，中间不得夹其他数字
const VERB_BEFORE = [
  ['BROKEN', /(?:已经|已|终于|被)?(?<!不)(?:跌破|刺破|冲破|冲过|突破|涨破|破了)\s*$/],
  ['HELD', /(?:没有跌破|未跌破|守住了?|撑住了?|没冲过|冲不过|上不去|没过去)\s*$/],
  ['HIT', /(?:到达了?|实现了?|达到了?|到了)\s*$/]
];
const VERB_AFTER = [
  ['HIT', /^\s*(?:元|美元)?(?:的)?(?:上涨|下跌|反弹)?(?:目标)?(?:位)?(?:已经|已|顺利|终于|也|经过\S{0,4})?(?:实现|到达|达成|到了|做到|预测到了|预测正确|接近)/],
  ['BROKEN', /^\s*(?:元)?(?:已经|已|被|昨天|今天)?(?:冲破|刺破|跌破|冲过去|突破|破了)/],
  ['HELD', /^\s*(?:元)?(?:的)?(?:短期)?(?:压力|支撑)?(?:没有?(?:冲|跌)?(?:过去|破)|守住|起了作用|发挥作用|冲击两次未成功)/]
];

function verbAround(src, price) {
  const variants = Array.from(new Set([String(price), price.toFixed(2), price.toFixed(1)]));
  for (const v of variants) {
    const re = new RegExp('(?<![\\d.])' + v.replace('.', '\\.') + '(?![\\d])', 'g');
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 8), m.index).replace(/^.*\d/, '');
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 14).replace(/\d.*$/, '');
      // 条件句（如果/一旦/只要…才）是假设而非事件，不计入谱系
      const clause = src.slice(Math.max(0, m.index - 12), m.index);
      if (/如果|一旦|只要|才能|需要|必须|若/.test(clause) || /^\s*(?:以后|后)/.test(after)) continue;
      for (const [verb, rx] of VERB_BEFORE) if (rx.test(before)) return { verb, phrase: before + m[0] + after };
      for (const [verb, rx] of VERB_AFTER) if (rx.test(after)) return { verb, phrase: before + m[0] + after };
    }
  }
  return null;
}

function buildThread(code, entries) {
  entries.sort((a, b) => a.ts - b.ts);
  // 价位谱系: 每个价位被后续帖子引用的状态序列
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    for (const lv of e.levels) {
      lv.followups = [];
      for (let j = i + 1; j < entries.length && lv.followups.length < 4; j++) {
        const f = entries[j];
        const hit = verbAround(f.fullText, lv.price);
        if (hit && !lv.followups.some(x => x.date === f.date)) lv.followups.push({ date: f.date, postId: f.id, verb: hit.verb, phrase: hit.phrase });
      }
    }
  }
  // 监测点轨迹
  const monitorTrail = [];
  for (const e of entries) {
    const mons = e.levels.filter(l => l.kind === 'monitor');
    if (!mons.length) continue;
    const m = mons[0];
    const prev = monitorTrail[monitorTrail.length - 1];
    monitorTrail.push({
      date: e.date, postId: e.id, price: m.price, side: m.side || null,
      move: prev ? (m.price > prev.price ? 'UP' : m.price < prev.price ? 'DOWN' : 'SAME') : null
    });
  }
  // 叙事段: 倾向翻转或浪型修正处切段
  const arcs = [];
  let cur = null;
  for (const e of entries) {
    const st = e.stance === 'MIXED' || e.stance === 'NEUTRAL' ? (cur ? cur.stance : e.stance) : e.stance;
    const revise = e.methods.includes('REVISION');
    if (!cur || st !== cur.stance || revise) {
      cur = { start: e.date, end: e.date, stance: st, posts: 0, patterns: {}, waveTags: {}, keyLevels: [], trigger: revise ? '浪型修正' : (arcs.length ? '倾向翻转' : '起始') };
      arcs.push(cur);
    }
    cur.end = e.date;
    cur.posts++;
    e.patterns.forEach(p => { cur.patterns[p] = (cur.patterns[p] || 0) + 1; });
    e.waveTags.forEach(p => { cur.waveTags[p] = (cur.waveTags[p] || 0) + 1; });
    const firstMon = e.levels.find(l => l.kind === 'monitor');
    if (firstMon && cur.keyLevels.length < 6) cur.keyLevels.push({ date: e.date, price: firstMon.price, kind: 'monitor' });
  }
  for (const a of arcs) {
    a.patterns = Object.entries(a.patterns).sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 4);
    a.waveTags = Object.entries(a.waveTags).sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 5);
  }
  // 价位谱系统计 (自述验证口径，非K线回测)
  const stats = { levels: 0, withFollowup: 0, hit: 0, broken: 0, held: 0 };
  for (const e of entries) for (const l of e.levels) {
    stats.levels++;
    if (l.followups.length) {
      stats.withFollowup++;
      const v = l.followups[0].verb;
      if (v === 'HIT') stats.hit++; else if (v === 'BROKEN') stats.broken++; else stats.held++;
    }
  }
  return { monitorTrail, arcs, lineageStats: stats };
}

// ---------------------------------------------------------------------------
// 4. 主流程
// ---------------------------------------------------------------------------

function build(corpusDir) {
  const dirs = fs.readdirSync(corpusDir).filter(n => /^\d{4}-\d{2}-\d{2}_/.test(n)).sort();
  const posts = dirs.map(n => parsePost(corpusDir, n)).filter(Boolean);
  const bySym = new Map();

  for (const p of posts) {
    const groups = new Map();
    for (const c of p.charts) {
      if (!c.symbol) continue;
      if (!groups.has(c.symbol.code)) groups.set(c.symbol.code, []);
      groups.get(c.symbol.code).push(c);
    }
    if (!groups.size) {
      const tag = (p.text.match(/#([^#]{1,20})#/) || [])[1];
      const s = symbolOf(tag || '') || null;
      if (s) groups.set(s.code, []);
    }
    for (const [code, charts] of groups) {
      const waveCharts = charts.filter(c => !/无手绘|纯K线|无浪/.test(c.drawing) || c.annotation);
      const annotation = charts.map(c => c.annotation).filter(Boolean).join(' / ');
      const relation = charts.map(c => c.degreeRelation).filter(Boolean).join(' / ');
      const levelsLine = charts.map(c => c.levelsLine).filter(Boolean).join(' / ');
      const fullText = [p.text, annotation, relation, levelsLine].join(' \n ');
      const entry = {
        id: p.id, date: p.date, time: p.time, ts: p.ts, link: p.link,
        timeframe: (charts.find(c => c.timeframe) || {}).timeframe || null,
        text: p.text.slice(0, 240),
        annotation: annotation.replace(/[\s/]*(?:仅|只)讨论波浪[^"”]*/g, '').replace(/\(另有[^)]*\)/g, '').slice(0, 600),
        degreeRelation: relation.slice(0, 600),
        hasWaveChart: waveCharts.length > 0,
        patterns: PATTERN_WORDS.filter(([, re]) => re.test(relation + annotation)).map(([k]) => k),
        methods: METHOD_TAGS.filter(([, , re]) => re.test(fullText)).map(([k]) => k),
        waveTags: extractWaveTags(annotation + ' ' + relation),
        stance: stanceOf(p.text + ' ' + annotation),
        rawLevels: extractLevels(annotation + ' ' + p.text),
        zones: extractZones(annotation + ' ' + p.text),
        fullText
      };
      if (!bySym.has(code)) bySym.set(code, []);
      bySym.get(code).push(entry);
    }
  }

  const symbols = {};
  for (const [code, entries] of bySym) {
    const ref = median(entries.flatMap(e => e.rawLevels.filter(l => l.kind === 'monitor' || l.kind === 'target').map(l => l.price)));
    for (const e of entries) {
      e.levels = dedupeLevels(e.rawLevels, ref);
      e.zones = e.zones.filter(z => !ref || (z.lo > ref * 0.25 && z.hi < ref * 4));
    }
    const thread = buildThread(code, entries);
    const meta = symbolByCode(code) || { code, name: code, binance: null };
    const tfCount = {};
    entries.forEach(e => { if (e.timeframe) tfCount[e.timeframe] = (tfCount[e.timeframe] || 0) + 1; });
    const methodCount = {};
    entries.forEach(e => e.methods.forEach(m => { methodCount[m] = (methodCount[m] || 0) + 1; }));
    symbols[code] = {
      code, name: meta.name, binance: meta.binance || null,
      posts: entries.length,
      wavePosts: entries.filter(e => e.hasWaveChart).length,
      first: entries[0].date, last: entries[entries.length - 1].date,
      priceRef: ref,
      timeframes: tfCount,
      methodCount,
      ...thread,
      entries: entries.map(e => {
        const { rawLevels, fullText, ts, ...rest } = e;
        return Object.assign(rest, { ts });
      })
    };
  }

  const methodLegend = Object.fromEntries(METHOD_TAGS.map(([k, label]) => [k, label]));
  return {
    schema: 'liu-wave-threads/v1',
    generatedAt: new Date().toISOString(),
    corpus: { posts: posts.length, wavePosts: posts.filter(p => p.charts.length).length, first: posts[0] && posts[0].date, last: posts[posts.length - 1] && posts[posts.length - 1].date },
    note: '由OCR文本自动抽取；价位谱系(followups)为作者后续帖子的自述，不等同于K线回测。仅讨论波浪，不构成交易建议。',
    methodLegend,
    symbols
  };
}

if (require.main === module) {
  const corpus = process.argv[2] || DEFAULT_CORPUS;
  const out = process.argv[3] || DEFAULT_OUT;
  if (!fs.existsSync(corpus)) {
    console.error(`语料目录不存在: ${corpus}`);
    process.exit(1);
  }
  const res = build(corpus);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  const rows = Object.values(res.symbols).sort((a, b) => b.posts - a.posts);
  console.log(`帖子 ${res.corpus.posts} (含波浪图解 ${res.corpus.wavePosts})，标的 ${rows.length} → ${out}`);
  for (const s of rows.slice(0, 20)) {
    console.log(`${s.code.padEnd(8)} ${String(s.posts).padStart(3)}帖 ${s.first}~${s.last} 监测点轨迹${String(s.monitorTrail.length).padStart(3)} 叙事段${String(s.arcs.length).padStart(3)} 谱系 ${s.lineageStats.withFollowup}/${s.lineageStats.levels}`);
  }
}

module.exports = { build, parsePost, extractLevels, extractZones, extractWaveTags, stanceOf };
