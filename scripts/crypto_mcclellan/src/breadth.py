"""
Pure breadth / McClellan computations (no I/O, stdlib only).

Membership is always fixed *ex ante*: a constituent counts toward day t only
if it was in the universe at the previous observation p, and its advance or
decline is close(t) vs close(p). This keeps a coin that pumped into the Top
100 (or onto a DEX trending list) from being counted as an advance on the
very day that pump got it selected.
"""

from datetime import date as _date
from statistics import median

import config


def day_gap(d1: str, d2: str) -> int:
    return (_date.fromisoformat(d2) - _date.fromisoformat(d1)).days


def ratio_adjusted(adv: int, dec: int) -> float:
    """RAMO = (Adv - Dec) / (Adv + Dec) * 1000, bounded to [-1000, +1000]."""
    total = adv + dec
    return (adv - dec) / total * config.RATIO_SCALE if total > 0 else 0.0


def ema(values, span: int):
    """Exponential moving average seeded with the first value (adjust=False)."""
    alpha = 2.0 / (span + 1.0)
    out, prev = [], None
    for v in values:
        prev = v if prev is None else alpha * v + (1.0 - alpha) * prev
        out.append(prev)
    return out


def mcclellan(ramo_values, warmup: int = config.WARMUP_DAYS):
    """
    Oscillator = EMA19(RAMO) - EMA39(RAMO); Summation Index = running sum of the
    oscillator. Both are None until `warmup` breadth days have accumulated, and
    the summation starts from 0 on the first published day.
    """
    fast = ema(ramo_values, config.EMA_FAST)
    slow = ema(ramo_values, config.EMA_SLOW)
    osc, summ, running = [], [], 0.0
    for i, (f, s) in enumerate(zip(fast, slow)):
        if i + 1 < warmup:
            osc.append(None)
            summ.append(None)
            continue
        o = f - s
        running += o
        osc.append(o)
        summ.append(running)
    return osc, summ


def quantile(values, q: float):
    """Linear-interpolated quantile, q in [0, 1]."""
    vals = sorted(values)
    if not vals:
        return None
    pos = (len(vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)


def percentile_rank(values, x: float):
    """Share of `values` at or below x, in percent."""
    if not values:
        return None
    return sum(1 for v in values if v <= x) / len(values) * 100.0


# -------------------------------------------------------------
# Core track
# -------------------------------------------------------------

def core_returns_by_coin(by_date: dict):
    """{coin_id: {date: daily_return}} over consecutive observations."""
    dates = sorted(by_date)
    out = {}
    for p, t in zip(dates, dates[1:]):
        if day_gap(p, t) > config.MAX_GAP_DAYS:
            continue
        prev_day, cur_day = by_date[p], by_date[t]
        for cid, (close, _mcap) in cur_day.items():
            prev = prev_day.get(cid)
            if prev and prev[0] > 0 and close > 0:
                out.setdefault(cid, {})[t] = close / prev[0] - 1.0
    return out


def static_excluded(symbol: str, name: str):
    """Reason string if the symbol / name marks a stablecoin or derivative, else None."""
    if (symbol or "").lower() in config.EXCLUDED_SYMBOLS:
        return "symbol"
    lname = (name or "").lower()
    if any(k in lname for k in config.EXCLUDED_NAME_KEYWORDS):
        return "name"
    return None


def core_exclusions(by_date: dict, meta: dict):
    """
    Coin ids excluded from the Core universe:
      1. symbol on the static list or name containing a derivative keyword
      2. stable-like: median |daily return| below STABLE_MEDIAN_ABS_RET
      3. pegged derivative: tracks a reference asset (BTC/ETH/SOL/BNB/gold)
         with median |ret - ret_ref| below PEG_MEDIAN_ABS_DIFF
    """
    excluded = {}
    for cid, (symbol, name) in meta.items():
        reason = static_excluded(symbol, name)
        if reason:
            excluded[cid] = reason

    rets = core_returns_by_coin(by_date)
    for cid, series in rets.items():
        if cid in excluded or len(series) < config.STABLE_MIN_OBS:
            continue
        if median(abs(r) for r in series.values()) < config.STABLE_MEDIAN_ABS_RET:
            excluded[cid] = "stable"
            continue
        if len(series) < config.FILTER_MIN_OBS:
            continue
        for ref in config.PEG_REFERENCE_IDS:
            if ref == cid or ref not in rets:
                continue
            common = [d for d in series if d in rets[ref]]
            if len(common) < config.FILTER_MIN_OBS:
                continue
            if median(abs(series[d] - rets[ref][d]) for d in common) < config.PEG_MEDIAN_ABS_DIFF:
                excluded[cid] = f"peg:{ref}"
                break
    return excluded


def core_breadth(by_date: dict, excluded, top_n: int = config.CORE_TOP_N):
    """
    Daily Core breadth. Universe for day t = Top N by market cap at the
    previous observation p (excluded coins skipped).
    Returns [{date, adv, dec, unch, n, members: [(cid, ret)]}].
    """
    dates = sorted(by_date)
    out = []
    for p, t in zip(dates, dates[1:]):
        if day_gap(p, t) > config.MAX_GAP_DAYS:
            continue
        prev_day, cur_day = by_date[p], by_date[t]
        ranked = sorted(
            (cid for cid, (_c, mcap) in prev_day.items() if mcap > 0 and cid not in excluded),
            key=lambda cid: prev_day[cid][1], reverse=True,
        )[:top_n]
        adv = dec = unch = 0
        members = []
        for cid in ranked:
            cur = cur_day.get(cid)
            prev_close = prev_day[cid][0]
            if not cur or cur[0] <= 0 or prev_close <= 0:
                continue
            r = cur[0] / prev_close - 1.0
            members.append((cid, r))
            if r > 0:
                adv += 1
            elif r < 0:
                dec += 1
            else:
                unch += 1
        out.append({"date": t, "adv": adv, "dec": dec, "unch": unch,
                    "n": len(members), "members": members})
    return out


# -------------------------------------------------------------
# Frontier track
# -------------------------------------------------------------

def frontier_breadth(by_date: dict):
    """
    Daily Frontier breadth from snapshot rows {date: {key: row}}.
    Members for day t = tokens flagged `tracked` in snapshot p with a price on p.
    A token qualifying for the first time on t is first counted on t+1, and a
    member that is `dead` on t (pool gone / liquidity collapsed) is a decline.

    `ramo` is chain-equal-weighted: the mean of each chain's own RAMO (chains
    with fewer than MEME_CHAIN_MIN_MEMBERS members sit out), so a sudden surge
    of listings on one chain cannot dominate the reading. `ramo_pooled` counts
    every member together and is kept as a diagnostic.

    Diagnostics per day, used to check the basket is not distorted by churn:
      dead         members counted as declines because their pool died
      entries      tokens joining the member set for t+1
      exits        members not carried into t+1
      age_median   median days since each member first qualified
    """
    dates = sorted(by_date)
    out = []
    for p, t in zip(dates, dates[1:]):
        if day_gap(p, t) > config.MAX_GAP_DAYS:
            continue
        prev_day, cur_day = by_date[p], by_date[t]
        adv = dec = unch = dead = 0
        chains, members, ages = {}, [], []
        for key, prow in prev_day.items():
            if not prow["tracked"] or prow["price"] <= 0:
                continue
            crow = cur_day.get(key)
            if not crow:
                continue
            if crow["dead"]:
                r = -1.0
                dead += 1
            elif crow["price"] > 0:
                r = crow["price"] / prow["price"] - 1.0
            else:
                continue
            members.append((key, r))
            ages.append(day_gap(prow["first_qualified"], t))
            c = chains.setdefault(prow["chain"], {"adv": 0, "dec": 0, "n": 0})
            c["n"] += 1
            if r > 0:
                adv += 1
                c["adv"] += 1
            elif r < 0:
                dec += 1
                c["dec"] += 1
            else:
                unch += 1
        prev_set = {k for k, r in prev_day.items() if r["tracked"]}
        cur_set = {k for k, r in cur_day.items() if r["tracked"]}
        pooled = ratio_adjusted(adv, dec)
        eligible = [c for c in chains.values() if c["n"] >= config.MEME_CHAIN_MIN_MEMBERS]
        ramo = (sum(ratio_adjusted(c["adv"], c["dec"]) for c in eligible) / len(eligible)
                if eligible else pooled)
        out.append({"date": t, "adv": adv, "dec": dec, "unch": unch,
                    "n": len(members), "chains": chains, "members": members,
                    "ramo": ramo, "ramo_pooled": pooled,
                    "dead": dead,
                    "entries": len(cur_set - prev_set),
                    "exits": len(prev_set - cur_set),
                    "age_median": median(ages) if ages else None})
    return out
