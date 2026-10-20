"""Causal, same-universe price indices and descriptive breadth diagnostics."""

import math
from collections import deque
from datetime import date, timedelta
from statistics import median, stdev

import config
from src.anchor import pearson
from src.breadth import day_gap, percentile_rank


def _individual_history(by_date):
    """Only consecutive, actually observed prices qualify for a full window."""
    windows, out = {}, {}
    for d in sorted(by_date):
        day = out.setdefault(d, {})
        for cid, (price, _cap) in by_date[d].items():
            if not math.isfinite(price) or price <= 0:
                continue
            history = windows.setdefault(cid, deque())
            if history and day_gap(history[-1][0], d) != 1:
                history.clear()
            history.append((d, price))
            while len(history) > config.STRUCTURE_DRAWDOWN_DAYS + 1:
                history.popleft()
            dd = None
            if len(history) == config.STRUCTURE_DRAWDOWN_DAYS + 1:
                dd = 100 * (1 - price / max(p for _d, p in history))
            above = None
            if len(history) >= config.STRUCTURE_MA_DAYS:
                recent = list(history)[-config.STRUCTURE_MA_DAYS:]
                above = price > sum(p for _d, p in recent) / len(recent)
            day[cid] = (dd, above)
    return out


def _empty_point(row):
    return {
        "date": row["date"], "ready": False, "index_ready": False,
        "status": "incomplete_quotes", "consecutive_days": 0,
        "ew_index": None, "cw_index": None,
        "ew_drawdown_52w": None, "cw_drawdown_52w": None,
        "drawdown_gap_pp": None, "gap_percentile": None,
        "median_constituent_drawdown_52w": None, "drawdown_eligible": 0,
        "pct_above_sma200": None, "sma200_eligible": 0,
        "constituents": row.get("n", 0),
        "expected_constituents": row.get("expected_n", row.get("n", 0)),
        "coverage_pct": row.get("coverage_pct", 0.0),
        "realized_vol_30d": None, "alt_btc_corr_30d": None,
        "volatility_observations": 0,
    }


def build_structure(rows, by_date):
    """Daily EW and lagged-cap-weighted returns, never total-market-cap changes.

    Missing member quotes invalidate a whole basket observation. A gap starts
    a new base-100 segment; no missing losses are redistributed to survivors.
    """
    individual = _individual_history(by_date)
    series, index_history, returns, prior_gaps = [], [], deque(), []
    last_date, segment_start, ew, cw = None, None, 100.0, 100.0
    for row in rows:
        point = _empty_point(row)
        d = row["date"]
        p = row.get("previous_date") or (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        universe = row.get("universe", [cid for cid, _r in row.get("members", [])])
        prev_day, cur_day = by_date.get(p, {}), by_date.get(d, {})
        quoted = [cid for cid in universe if cid in prev_day and cid in cur_day
                  and all(math.isfinite(v) and v > 0
                          for v in (prev_day[cid][0], prev_day[cid][1], cur_day[cid][0]))]
        point["coverage_pct"] = 100 * len(quoted) / len(universe) if universe else 0.0
        valid = (bool(universe) and day_gap(p, d) == 1
                 and row.get("complete", True) and len(quoted) == len(universe)
                 and len(universe) == point["expected_constituents"])
        if not valid:
            last_date, segment_start = None, None
            index_history, returns = [], deque()
            series.append(point)
            continue
        if last_date != p:
            ew = cw = 100.0
            segment_start = p
            index_history, returns = [(p, ew, cw)], deque()
        daily = {cid: cur_day[cid][0] / prev_day[cid][0] - 1 for cid in universe}
        cap_total = sum(prev_day[cid][1] for cid in universe)
        ew_return = sum(daily.values()) / len(universe)
        cw_return = sum(daily[cid] * (prev_day[cid][1] / cap_total) for cid in universe)
        ew *= 1 + ew_return
        cw *= 1 + cw_return
        if not all(math.isfinite(v) and v > 0 for v in (ew, cw)):
            last_date, segment_start = None, None
            index_history, returns = [], deque()
            series.append(point)
            continue
        index_history.append((d, ew, cw))
        cutoff = (date.fromisoformat(d) - timedelta(days=config.STRUCTURE_DRAWDOWN_DAYS)).isoformat()
        index_history = [v for v in index_history if v[0] >= cutoff]
        point.update({
            "index_ready": True, "status": "warming_up",
            "consecutive_days": day_gap(segment_start, d),
            "ew_index": ew, "cw_index": cw,
        })
        if segment_start <= cutoff:
            edd = 100 * (1 - ew / max(v[1] for v in index_history))
            cdd = 100 * (1 - cw / max(v[2] for v in index_history))
            gap = edd - cdd
            point.update({
                "ready": True, "status": "ready",
                "ew_drawdown_52w": edd, "cw_drawdown_52w": cdd,
                "drawdown_gap_pp": gap,
                "gap_percentile": (percentile_rank(prior_gaps, gap)
                                   if len(prior_gaps) >= config.BAND_MIN_OBS else None),
            })
            prior_gaps.append(gap)

        own = [individual.get(d, {}).get(cid, (None, None)) for cid in universe]
        drawdowns = [v[0] for v in own if v[0] is not None]
        above = [v[1] for v in own if v[1] is not None]
        point.update({
            "median_constituent_drawdown_52w": median(drawdowns) if drawdowns else None,
            "drawdown_eligible": len(drawdowns),
            "pct_above_sma200": 100 * sum(above) / len(above) if above else None,
            "sma200_eligible": len(above),
        })

        alts = [r for cid, r in daily.items() if cid != "bitcoin"]
        btc_prev, btc_cur = prev_day.get("bitcoin"), cur_day.get("bitcoin")
        btc_return = (btc_cur[0] / btc_prev[0] - 1
                      if btc_prev and btc_cur and btc_prev[0] > 0 else None)
        returns.append((ew_return, sum(alts) / len(alts) if alts else None, btc_return))
        while len(returns) > config.STRUCTURE_VOL_DAYS:
            returns.popleft()
        point["volatility_observations"] = len(returns)
        if len(returns) == config.STRUCTURE_VOL_DAYS:
            point["realized_vol_30d"] = stdev(v[0] for v in returns) * math.sqrt(365) * 100
            if all(v[1] is not None and v[2] is not None for v in returns):
                point["alt_btc_corr_30d"] = pearson([v[1] for v in returns], [v[2] for v in returns])
        for key, value in point.items():
            if isinstance(value, float):
                point[key] = round(value, 4) if math.isfinite(value) else None
        series.append(point)
        last_date = d

    return {
        "methodology": {
            "universe": "same_previous_observation_core_universe",
            "weighting": "daily_rebalanced_equal_vs_previous_market_cap",
            "index_base": 100,
            "drawdown_calendar_days": config.STRUCTURE_DRAWDOWN_DAYS,
            "drawdown_observations_required": config.STRUCTURE_DRAWDOWN_DAYS + 1,
            "drawdown_sign": "positive_depth",
            "gap_unit": "percentage_points",
            "gap_percentile_basis": "strictly_prior_ready_observations",
            "gap_percentile_min_observations": config.BAND_MIN_OBS,
            "sma_days": config.STRUCTURE_MA_DAYS,
            "volatility_days": config.STRUCTURE_VOL_DAYS,
            "volatility_annualization_days": 365,
            "correlation": "30_paired_daily_core_ex_bitcoin_equal_weight_returns_vs_bitcoin",
            "missing_quotes": "invalidate_basket_and_restart_segment",
            "predictive_validation": "not_performed",
            "fixed_danger_threshold": None,
        },
        "current": series[-1] if series else None,
        "series": series,
    }
