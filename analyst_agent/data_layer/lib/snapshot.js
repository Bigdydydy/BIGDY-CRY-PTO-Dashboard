/**
 * Builds the indicator snapshot the commentary agent reads: fetches every indicator in
 * methodology/indicators.json from its primary source (falling back when it fails), truncates all
 * history at `asof` so historical runs carry no look-ahead, computes the listed transforms and
 * the composite / cross-series values, and flags stale data.
 */

const fs = require('fs');
const path = require('path');
const providers = require('./providers');
const T = require('./transforms');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'methodology', 'indicators.json');
const PARAMS_PATH = path.join(__dirname, '..', 'analysis_params.json');

// Max calendar days since the latest observation before a value is flagged stale.
const STALE_DAYS = { daily: 5, weekly: 16, monthly: 75, irregular: 120, event: 45 };

// Transforms that need data this pipeline does not fetch; reported as runtime/unsupported, not as errors.
const RUNTIME_TRANSFORMS = new Set(['funding_rate', 'open_interest_delta_pct', 'revision_vs_prior_vintage']);

function sourceKey(src) {
  return src.provider + ':' + (src.series || src.ticker);
}

function loadParams() {
  try {
    return JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

async function fetchSource(src, opts) {
  if (src.provider === 'fred') return providers.fetchFred(src.series, opts);
  if (src.provider === 'yahoo') return providers.fetchYahoo(src.ticker, opts);
  throw new Error('provider ' + src.provider + ' is not fetched by the snapshot');
}

/** Run async jobs with a concurrency cap; Yahoo gets its own lane at 1 to stay under its rate limit. */
async function runPool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

/** Fetch every distinct FRED/Yahoo source referenced by the registry exactly once. */
async function fetchAll(registry, opts) {
  const wanted = new Map();
  const add = src => {
    if (src && (src.provider === 'fred' || src.provider === 'yahoo')) wanted.set(sourceKey(src), src);
  };
  for (const ind of registry.indicators) {
    if (ind.composite) {
      const inputs = Array.isArray(ind.composite.inputs)
        ? ind.composite.inputs
        : (ind.composite.inputs ? Object.values(ind.composite.inputs) : (ind.sources ? ind.sources.filter(s => s.role === 'primary') : []));
      inputs.forEach(add);
    }
    else ind.sources.filter(s => s.role !== 'realtime').forEach(add);
  }
  const fetched = new Map();
  const errors = {};
  const job = src => async () => {
    try {
      fetched.set(sourceKey(src), await fetchSource(src, opts));
    } catch (err) {
      errors[sourceKey(src)] = err.message;
    }
  };
  const all = [...wanted.values()];
  await Promise.all([
    runPool(all.filter(s => s.provider === 'fred').map(job), 4),
    runPool(all.filter(s => s.provider === 'yahoo').map(job), 1)
  ]);
  return { fetched, errors };
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function buildComposite(ind, getRaw) {
  const c = ind.composite;
  const input = name => {
    const s = getRaw(c.inputs[name]);
    if (!s || !s.length) throw new Error('missing component ' + sourceKey(c.inputs[name]));
    return s;
  };
  switch (c.type) {
    case 'net_liquidity': {
      // WALCL and TGA are weekly (millions), RRP daily (billions): step RRP onto the weekly dates.
      const rrp = input('rrp');
      return T.align(input('walcl'), input('tga')).map(o => {
        const r = T.valueAtOrBefore(rrp, o.date);
        return { date: o.date, value: o.a / 1e6 - o.b / 1e6 - (r ? r.value : 0) / 1e3 };
      });
    }
    case 'ratio':
      return T.ratioSeries(input('a'), input('b'));
    case 'spread_bp':
      return T.align(input('a'), input('b')).map(o => ({ date: o.date, value: (o.a - o.b) * 100 }));
    case 'forward':
      return T.align(input('short'), input('long')).map(o => ({ date: o.date, value: T.forwardYield(o.a, c.m1, o.b, c.m2) }));
    case 'rolling_corr':
      return T.rollingChangeCorrelation(input('a'), input('b'), c.window, c.a_mode, c.b_mode);
    case 'mean': {
      const inputs = Array.isArray(c.inputs)
        ? c.inputs
        : (c.inputs ? Object.values(c.inputs) : (ind.sources ? ind.sources.filter(s => s.role === 'primary') : []));
      const rawSeriesList = inputs.map(src => getRaw(src)).filter(s => s && s.length);
      if (!rawSeriesList.length) throw new Error('no available inputs for mean composite');
      const mode = ind.frequency === 'monthly' ? 'month' : 'date';
      return T.alignMean(rawSeriesList, mode);
    }
    default:
      throw new Error('unknown composite type ' + c.type);
  }
}

/** Transforms that read other indicators' series. Returns undefined when `name` is not cross-series. */
function crossTransform(name, ind, series, ctx) {
  const other = id => {
    const s = ctx.series.get(id);
    if (!s || !s.length) throw new Error('needs ' + id);
    return s;
  };
  switch (name) {
    case 'curve_regime': {
      const c2 = T.change(other('UST2Y'), 1, 'w', 'bp').value;
      const c10 = T.change(other('UST10Y'), 1, 'w', 'bp').value;
      return { value: T.curveRegime(c2, c10), chg_2y_1w_bp: c2, chg_10y_1w_bp: c10 };
    }
    case 'share_of_nominal_move': {
      const out = {};
      const tagMap = {
        REAL10Y: 'realShareOf10yMove',
        BEI10Y: 'beiShareOf10yMove',
        TERM_PREMIUM_10Y: 'tpShareOf10yMove'
      };
      out.tag = tagMap[ind?.id] || 'shareOf10yMove';
      const joined = T.align(series, other('UST10Y'));
      if (joined.length < 2) throw new Error('needs aligned series with UST10Y');
      const cur = joined[joined.length - 1];
      out.date = cur.date;
      for (const [label, n, unit] of [['4w', 4, 'w'], ['13w', 13, 'w']]) {
        const base = T.valueAtOrBefore(joined, T.shiftDate(cur.date, n, unit));
        if (!base) {
          out['share_' + label] = null;
          continue;
        }
        const own = T.round((cur.a - base.a) * 100, 1);
        const nominal = T.round((cur.b - base.b) * 100, 1);
        out['own_chg_' + label + '_bp'] = own;
        out['nominal_chg_' + label + '_bp'] = nominal;
        out['share_' + label] = Math.abs(nominal) < 5 ? null : T.round(own / nominal, 2);
      }
      out.note = '名义利率变动不足 5bp 时不计算占比';
      return out;
    }
    case 'chg_since_event_bp': {
      if (!ctx.eventDate) return { value: null, note: '未指定 --event 日期' };
      const base = T.valueAtOrBefore(series, ctx.eventDate);
      if (!base) throw new Error('no observation before event');
      return { value: T.round((T.last(series).value - base.value) * 100, 1), from: base.date };
    }
    case 'rel_to_spx': {
      const ratio = T.ratioSeries(series, other('SPX'));
      return {
        chg_4w_pct: T.change(ratio, 4, 'w', 'pct').value,
        chg_13w_pct: T.change(ratio, 13, 'w', 'pct').value
      };
    }
    case 'divergence_vs_spx': {
      // SPX at a 20-session low while VIX is not at a 20-session high.
      const joined = T.align(other('SPX'), series).slice(-21);
      if (joined.length < 21) throw new Error('need 21 aligned sessions');
      const prior = joined.slice(0, 20);
      const cur = joined[20];
      const spxNewLow = cur.a <= Math.min(...prior.map(o => o.a));
      const vixNewHigh = cur.b >= Math.max(...prior.map(o => o.b));
      return { value: spxNewLow && !vixNewHigh, spx_20d_low: spxNewLow, vix_20d_high: vixNewHigh, date: cur.date };
    }
    case 'chg_since_spx_high_bp': {
      const dd = T.drawdown(other('SPX'));
      const base = T.valueAtOrBefore(series, dd.high_1y_date);
      return { value: T.round((T.last(series).value - base.value) * 100, 1), spx_high_date: dd.high_1y_date, spx_drawdown_pct: dd.value };
    }
    case 'crack_vs_wti': {
      const j = T.align(series, other('WTI'));
      const cur = j[j.length - 1];
      return { value: T.round(cur.a * 42 - cur.b, 2), unit: 'USD/bbl', date: cur.date };
    }
    case 'gap_vs_core_cpi': {
      const joined = T.align(series, other('CPI_CORE'));
      if (joined.length < 13) throw new Error('need at least 13 aligned monthly observations for Core PCE vs Core CPI');
      const cur = joined[joined.length - 1];
      const base = T.valueAtOrBefore(joined, T.shiftDate(cur.date, 12, 'm'));
      if (!base) throw new Error('no aligned observation 12m before ' + cur.date);
      const pce = T.round((cur.a / base.a - 1) * 100, 4);
      const cpi = T.round((cur.b / base.b - 1) * 100, 4);
      return { value: T.round(pce - cpi, 2), core_pce_yoy: pce, core_cpi_yoy: cpi, date: cur.date };
    }
    case 'distance_to_key_level_bp': {
      const levels = (ctx.params.key_levels || {})[ind.id];
      if (!levels || !levels.length) return { value: null, note: 'analysis_params.json 未设置 key_levels.' + ind.id };
      const cur = T.last(series).value;
      // Rates and spreads quoted in % get a bp distance; prices (gold, FX, indices) get a % distance.
      if (ind.unit === '%') return { value: levels.map(l => ({ level: l, distance_bp: T.round((cur - l) * 100, 1) })) };
      return { value: levels.map(l => ({ level: l, distance_pct: T.round((cur / l - 1) * 100, 2) })) };
    }
    case 'implied_oil_disruption': {
      const oil = ctx.params.oil || {};
      if (!oil.baseline_brent) return { value: null, note: 'analysis_params.json 未设置 oil.baseline_brent' };
      return T.impliedOilDisruption(T.last(series).value, oil.baseline_brent, oil.elasticity || 0.15, oil.global_supply_mbd || 105);
    }
    default:
      return undefined;
  }
}

function summarizeAuctions(rows, asof) {
  const visible = rows.filter(r => r.date <= asof);
  const out = {};
  for (const term of providers.AUCTION_TERMS) {
    const hist = visible.filter(r => r.term === term);
    if (!hist.length) continue;
    const latest = hist[hist.length - 1];
    const prior = hist.slice(-7, -1);
    const avg = k => {
      const xs = prior.map(r => r[k]).filter(v => v != null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    out[term] = {
      date: latest.date,
      high_yield: latest.high_yield,
      bid_to_cover: latest.bid_to_cover,
      bid_to_cover_vs_avg6: latest.bid_to_cover != null && avg('bid_to_cover') != null ? T.round(latest.bid_to_cover - avg('bid_to_cover'), 3) : null,
      indirect_share: T.round(latest.indirect_share, 3),
      indirect_share_vs_avg6: latest.indirect_share != null && avg('indirect_share') != null ? T.round(latest.indirect_share - avg('indirect_share'), 3) : null,
      dealer_share: T.round(latest.dealer_share, 3),
      dealer_share_vs_avg6: latest.dealer_share != null && avg('dealer_share') != null ? T.round(latest.dealer_share - avg('dealer_share'), 3) : null,
      soma_accepted: latest.soma_accepted
    };
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} [opts.asof]      YYYY-MM-DD; history is cut at this date (default: today, UTC)
 * @param {string} [opts.eventDate] YYYY-MM-DD for chg_since_event_bp
 * @param {string[]} [opts.lens]    restrict to indicators of these lenses (esther/brooks/both)
 * @param {boolean} [opts.noCache]
 */
async function buildSnapshot(opts = {}) {
  const asof = opts.asof || new Date().toISOString().slice(0, 10);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (opts.lens && opts.lens.length) {
    const keep = new Set(opts.lens.concat('both'));
    registry.indicators = registry.indicators.filter(i => keep.has(i.lens || 'esther'));
  }
  const params = loadParams();
  const { fetched, errors: sourceErrors } = await fetchAll(registry, { asof, noCache: opts.noCache });
  const getRaw = src => {
    const s = fetched.get(sourceKey(src));
    return s ? T.truncate(s, asof) : null;
  };

  // Pass 1: resolve each indicator's series (primary → fallback, or composite).
  const series = new Map();
  const resolved = {};
  for (const ind of registry.indicators) {
    const r = { name: ind.name, dimension: ind.dimension, layer: ind.layer, lens: ind.lens, frequency: ind.frequency, unit: ind.unit };
    if (ind.composite) {
      try {
        const s = buildComposite(ind, getRaw);
        if (s.length) {
          series.set(ind.id, s);
          r.source = 'composite:' + ind.composite.type;
        } else {
          r.error = 'composite produced no observations';
        }
      } catch (err) {
        r.error = err.message;
      }
    } else {
      const candidates = ind.sources.filter(s => s.provider === 'fred' || s.provider === 'yahoo');
      const primaries = candidates.filter(s => s.role === 'primary');
      if (primaries.length > 1) {
        // Multi-source primary indicator (e.g. REGIONAL_SURVEYS: Philly Fed + NY Empire State)
        const validSeries = primaries.map(src => ({ src, s: getRaw(src) })).filter(item => item.s && item.s.length);
        if (validSeries.length > 1) {
          const mode = ind.frequency === 'monthly' ? 'month' : 'date';
          const combined = T.alignMean(validSeries.map(v => v.s), mode);
          if (combined && combined.length) {
            series.set(ind.id, combined);
            r.source = 'mean(' + validSeries.map(v => sourceKey(v.src)).join(', ') + ')';
          }
        } else if (validSeries.length === 1) {
          series.set(ind.id, validSeries[0].s);
          r.source = sourceKey(validSeries[0].src);
        }
      }
      if (!series.has(ind.id)) {
        for (const src of candidates.filter(s => s.role !== 'realtime')) {
          const s = getRaw(src);
          if (s && s.length) {
            series.set(ind.id, s);
            r.source = sourceKey(src) + (src.role === 'primary' ? '' : ' (' + src.role + ')');
            break;
          }
        }
      }
      if (!r.source) {
        const runtime = ind.sources.find(s => s.provider === 'openmarket');
        const manual = ind.sources.find(s => s.provider === 'manual');
        if (runtime && !candidates.length) r.status = 'runtime_openmarket';
        else if (manual) r.status = 'manual_input_required';
        else r.error = candidates.map(s => sourceErrors[sourceKey(s)] || sourceKey(s) + ' unavailable').join('; ') || 'no fetchable source';
      }
    }
    const realtime = ind.sources.find(s => s.provider === 'openmarket');
    if (realtime) r.realtime_source = { exchange: realtime.exchange, symbol: realtime.symbol || null, query: realtime.query || null };
    resolved[ind.id] = r;
  }

  // Pass 2: transforms (cross-series ones can now see every resolved series).
  const ctx = { series, params, eventDate: opts.eventDate };
  for (const ind of registry.indicators) {
    const r = resolved[ind.id];
    const s = series.get(ind.id);
    if (!s) continue;
    const latest = T.last(s);
    r.latest = { date: latest.date, value: T.round(latest.value, 4) };
    const age = daysBetween(latest.date, asof);
    r.age_days = age;
    r.stale = age > (ind.stale_days || STALE_DAYS[ind.frequency] || 30);
    r.transforms = {};
    for (const name of ind.transforms || []) {
      if (RUNTIME_TRANSFORMS.has(name)) {
        r.transforms[name] = { value: null, note: '需在运行时通过 OpenMarket 或人工补充' };
        continue;
      }
      try {
        let v = T.applySeriesTransform(name, s);
        if (v === undefined) v = crossTransform(name, ind, s, ctx);
        if (v === undefined) throw new Error('unsupported transform');
        r.transforms[name] = v;
      } catch (err) {
        r.transforms[name] = { value: null, error: err.message };
      }
    }
    if (opts.withRules !== false && ind.rules && ind.rules.length) r.rules = ind.rules;
  }

  let auctions = null;
  let auctionError = null;
  if (registry.indicators.some(i => i.id === 'UST_AUCTIONS')) {
    try {
      auctions = summarizeAuctions(await providers.fetchTreasuryAuctions({ asof, noCache: opts.noCache }), asof);
      resolved.UST_AUCTIONS.source = 'treasury:auctions_query';
      resolved.UST_AUCTIONS.latest_by_term = auctions;
      delete resolved.UST_AUCTIONS.error;
    } catch (err) {
      auctionError = err.message;
      resolved.UST_AUCTIONS.error = err.message;
    }
  }

  const ids = Object.keys(resolved);
  const ok = ids.filter(id => resolved[id].latest || resolved[id].latest_by_term);
  return {
    meta: {
      asof,
      generated_at: new Date().toISOString(),
      registry_version: registry.version,
      event_date: opts.eventDate || null,
      lens: opts.lens && opts.lens.length ? opts.lens : ['esther', 'brooks', 'both'],
      counts: {
        indicators: ids.length,
        ok: ok.length,
        stale: ids.filter(id => resolved[id].stale).length,
        runtime_openmarket: ids.filter(id => resolved[id].status === 'runtime_openmarket').length,
        manual_input_required: ids.filter(id => resolved[id].status === 'manual_input_required').length,
        failed: ids.filter(id => resolved[id].error).length
      },
      source_errors: Object.assign({}, sourceErrors, auctionError ? { 'treasury:auctions_query': auctionError } : {}),
      caveats: [
        'FRED 返回的是当前版本数据；回测历史日期时，就业、GDP 等会被修订的序列可能含有事后修订（非实时版本）',
        'Yahoo 为非官方接口，个别标的可能临时失败；失败项见 source_errors',
        'realtime_source 指向 OpenMarket，需要 agent 在运行时通过 MCP 读取；证伪和止损以本快照的收盘值为准'
      ]
    },
    indicators: resolved
  };
}

module.exports = { buildSnapshot, summarizeAuctions, crossTransform, buildComposite, STALE_DAYS };
