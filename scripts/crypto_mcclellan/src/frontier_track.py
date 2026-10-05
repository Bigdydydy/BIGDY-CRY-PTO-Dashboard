"""
Frontier meme track: on-chain heat on Solana / BSC / Robinhood Chain.

Daily flow (run near the UTC close):
  1. Discover candidates from GeckoTerminal trending + top-volume pools.
  2. Admit tokens passing the per-chain gatekeeper (liquidity, 24h volume, FDV).
  3. Keep every admitted token tracked for MEME_RETENTION_DAYS after the last
     day it qualified, so tokens that crash after their pump are still counted.
  4. Price every tracked token (plus yesterday's members) via DexScreener and
     append one snapshot row per token.

There is no reliable way to rebuild which pools were hot in the past, so this
track accumulates forward from its first run only.

frontier_snapshots.csv columns:
    date, key, chain, symbol, address, price, liquidity_usd, volume_24h_usd,
    fdv_usd, qualified, tracked, first_qualified, status

status is "ok" or "dead" (pool gone / liquidity below MEME_DEAD_LIQUIDITY_USD).
"""

import csv
import json
import time
from pathlib import Path

import config
from src.breadth import day_gap
from src.http_client import get_json

FIELDS = ["date", "key", "chain", "symbol", "address", "price", "liquidity_usd",
          "volume_24h_usd", "fdv_usd", "qualified", "tracked", "first_qualified", "status"]


def norm_addr(addr: str) -> str:
    # EVM addresses are case-insensitive; Solana base58 addresses are not
    return addr.lower() if addr.startswith("0x") else addr


def make_key(chain: str, addr: str) -> str:
    return f"{chain}:{norm_addr(addr)}"


def _f(x) -> float:
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


# -------------------------------------------------------------
# Storage
# -------------------------------------------------------------

def load_store(path: Path = config.FRONTIER_STORE_FILE):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def save_store(rows, path: Path = config.FRONTIER_STORE_FILE):
    rows = sorted(rows, key=lambda r: (r["date"], r["chain"], r["key"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def index_store(rows):
    """{date: {key: {chain, price, tracked, dead, first_qualified}}}"""
    by_date = {}
    for r in rows:
        by_date.setdefault(r["date"], {})[r["key"]] = {
            "chain": r["chain"],
            "price": _f(r["price"]),
            "tracked": r["tracked"] == "1",
            "dead": r.get("status") == "dead",
            "first_qualified": r.get("first_qualified") or r["date"],
        }
    return by_date


def load_registry(path: Path = config.FRONTIER_REGISTRY_FILE):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_registry(registry, path: Path = config.FRONTIER_REGISTRY_FILE):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(registry, indent=1, ensure_ascii=False, sort_keys=True), encoding="utf-8")


# -------------------------------------------------------------
# Discovery & gatekeeper
# -------------------------------------------------------------

def _parse_pools(chain: str, payload: dict):
    symbols = {t["id"]: t.get("attributes", {}).get("symbol", "")
               for t in payload.get("included", []) if t.get("type") == "token"}
    for pool in payload.get("data", []):
        attr = pool.get("attributes", {})
        base_id = (pool.get("relationships", {}).get("base_token", {}).get("data") or {}).get("id", "")
        if not base_id.startswith(f"{chain}_"):
            continue
        addr = base_id.split("_", 1)[1]
        symbol = symbols.get(base_id) or attr.get("name", "").split("/")[0].strip()
        yield {
            "chain": chain,
            "address": norm_addr(addr),
            "symbol": symbol.strip().upper()[:24],
            "price": _f(attr.get("base_token_price_usd")),
            "liquidity_usd": _f(attr.get("reserve_in_usd")),
            "volume_24h_usd": _f((attr.get("volume_usd") or {}).get("h24")),
            "fdv_usd": _f(attr.get("fdv_usd")),
        }


def discover(chain: str):
    """
    Candidate tokens on one chain, aggregated across the pools seen:
    liquidity / FDV take the max, 24h volume is summed, price comes from the
    deepest pool.
    """
    endpoints = [
        f"{config.GECKOTERMINAL_BASE}/networks/{chain}/trending_pools?include=base_token",
        f"{config.GECKOTERMINAL_BASE}/networks/{chain}/pools?sort=h24_volume_usd_desc&include=base_token",
    ]
    tokens = {}
    for url in endpoints:
        try:
            payload = get_json(url, backoff_sec=20.0)
        except Exception as e:
            print(f"[Frontier] {chain} discovery failed ({url.split('/')[-1][:30]}): {e}")
            continue
        finally:
            time.sleep(config.GECKOTERMINAL_SPACING_SEC)
        for p in _parse_pools(chain, payload):
            if p["symbol"] in config.MEME_NON_MEME_SYMBOLS or p["symbol"].lower() in config.EXCLUDED_SYMBOLS:
                continue
            key = make_key(chain, p["address"])
            t = tokens.get(key)
            if t is None:
                tokens[key] = dict(p)
                continue
            if p["liquidity_usd"] > t["liquidity_usd"]:
                t["price"] = p["price"]
                t["liquidity_usd"] = p["liquidity_usd"]
            t["volume_24h_usd"] += p["volume_24h_usd"]
            t["fdv_usd"] = max(t["fdv_usd"], p["fdv_usd"])
    return tokens


def qualifies(token: dict) -> bool:
    g = config.MEME_GATEKEEPER[token["chain"]]
    return (token["liquidity_usd"] >= g["min_liquidity_usd"]
            and token["volume_24h_usd"] >= g["min_volume_24h_usd"]
            and token["fdv_usd"] >= g["min_fdv_usd"])


# -------------------------------------------------------------
# Pricing
# -------------------------------------------------------------

def quote_tokens(chain: str, addresses):
    """
    DexScreener batch quote; the deepest pair whose base is the token wins.
    Returns (quotes, failed) where `failed` holds addresses whose batch request
    errored, so a transient API failure is never mistaken for a dead pool.
    """
    ds_chain = config.MEME_CHAINS[chain]
    quotes, failed = {}, set()
    addrs = sorted(set(addresses))
    for i in range(0, len(addrs), config.DEXSCREENER_BATCH):
        batch = addrs[i:i + config.DEXSCREENER_BATCH]
        url = config.DEXSCREENER_TOKENS_URL.format(chain=ds_chain, addresses=",".join(batch))
        try:
            pairs = get_json(url, backoff_sec=10.0)
        except Exception as e:
            print(f"[Frontier] DexScreener {chain} quote failed: {e}")
            failed.update(batch)
            continue
        for p in pairs if isinstance(pairs, list) else []:
            base = norm_addr((p.get("baseToken") or {}).get("address", ""))
            if base not in batch:
                continue
            liq = _f((p.get("liquidity") or {}).get("usd"))
            if base in quotes and quotes[base]["liquidity_usd"] >= liq:
                continue
            quotes[base] = {
                "price": _f(p.get("priceUsd")),
                "liquidity_usd": liq,
                "volume_24h_usd": _f((p.get("volume") or {}).get("h24")),
                "fdv_usd": _f(p.get("fdv")),
                "symbol": ((p.get("baseToken") or {}).get("symbol") or "").upper()[:24],
            }
        time.sleep(0.3)
    return quotes, failed


def gt_quote_tokens(chain: str, addresses):
    """
    GeckoTerminal token quotes (price + total pool reserve), used to confirm a
    token DexScreener reports as illiquid: DexScreener does not index every
    pool type (e.g. some newer BSC pools), and a coverage gap must not be
    recorded as a rug. Returns (quotes, failed) like quote_tokens.
    """
    quotes, failed = {}, set()
    addrs = sorted(set(addresses))
    for i in range(0, len(addrs), config.DEXSCREENER_BATCH):
        batch = addrs[i:i + config.DEXSCREENER_BATCH]
        url = f"{config.GECKOTERMINAL_BASE}/networks/{chain}/tokens/multi/{','.join(batch)}"
        try:
            payload = get_json(url, backoff_sec=20.0)
        except Exception as e:
            print(f"[Frontier] GeckoTerminal {chain} quote failed: {e}")
            failed.update(batch)
            continue
        finally:
            time.sleep(config.GECKOTERMINAL_SPACING_SEC)
        for t in payload.get("data", []):
            attr = t.get("attributes", {})
            addr = norm_addr(attr.get("address") or t.get("id", "").split("_", 1)[-1])
            quotes[addr] = {
                "price": _f(attr.get("price_usd")),
                "liquidity_usd": _f(attr.get("total_reserve_in_usd")),
                "volume_24h_usd": _f((attr.get("volume_usd") or {}).get("h24")),
                "fdv_usd": _f(attr.get("fdv_usd")),
                "symbol": (attr.get("symbol") or "").upper()[:24],
            }
    return quotes, failed


# -------------------------------------------------------------
# Daily update
# -------------------------------------------------------------

def update(trade_date: str, store_rows):
    """
    Run discovery, gatekeeping and pricing for trade_date.
    Returns (new snapshot rows for trade_date, updated registry).
    """
    registry = load_registry()

    discovered = {}
    for chain in config.MEME_CHAINS:
        found = discover(chain)
        discovered.update(found)
        print(f"[Frontier] {chain}: {len(found)} candidates, "
              f"{sum(1 for t in found.values() if qualifies(t))} qualified")

    qualified = {k for k, t in discovered.items() if qualifies(t)}
    for key in qualified:
        t = discovered[key]
        entry = registry.get(key, {"first_qualified": trade_date})
        entry.update({"chain": t["chain"], "address": t["address"], "symbol": t["symbol"],
                      "last_qualified": trade_date})
        entry["first_qualified"] = min(entry["first_qualified"], trade_date)
        registry[key] = entry

    tracked = {k for k, e in registry.items()
               if e["first_qualified"] <= trade_date
               and 0 <= day_gap(e["last_qualified"], trade_date) <= config.MEME_RETENTION_DAYS}

    # Yesterday's members get priced today even if their retention just ended
    prev_dates = sorted({r["date"] for r in store_rows if r["date"] < trade_date})
    prev_members = set()
    if prev_dates:
        prev_members = {r["key"] for r in store_rows if r["date"] == prev_dates[-1] and r["tracked"] == "1"}

    to_price = tracked | prev_members
    by_chain = {}
    for key in to_price:
        chain, addr = key.split(":", 1)
        by_chain.setdefault(chain, []).append(addr)

    rows = []
    for chain, addrs in by_chain.items():
        quotes, failed = quote_tokens(chain, addrs)
        # Second opinion before anything is treated as dead or skipped
        suspects = [a for a in addrs if a not in failed and (
            a not in quotes or quotes[a]["price"] <= 0
            or quotes[a]["liquidity_usd"] < config.MEME_DEAD_LIQUIDITY_USD)]
        if suspects:
            gt_quotes, gt_failed = gt_quote_tokens(chain, suspects)
            failed |= gt_failed
            for a in suspects:
                g = gt_quotes.get(a)
                if g and g["price"] > 0 and g["liquidity_usd"] >= config.MEME_DEAD_LIQUIDITY_USD:
                    quotes[a] = g
        for addr in addrs:
            key = make_key(chain, addr)
            entry = registry.get(key, {})
            if addr in failed and addr not in quotes and key not in discovered:
                continue  # no reliable reading today; neither alive nor dead
            q = quotes.get(addr)
            if q is None and key in prev_members:
                # The quote request succeeded but the pool is gone: a rug, recorded as dead
                q = {"price": 0.0, "liquidity_usd": 0.0, "volume_24h_usd": 0.0, "fdv_usd": 0.0}
            q = q or discovered.get(key)
            if not q:
                continue
            dead = q["price"] <= 0 or q["liquidity_usd"] < config.MEME_DEAD_LIQUIDITY_USD
            if dead and key not in prev_members:
                continue  # not a member yet, nothing to measure
            rows.append({
                "date": trade_date,
                "key": key,
                "chain": chain,
                "symbol": entry.get("symbol") or q.get("symbol", ""),
                "address": addr,
                "price": f"{q['price']:.8g}",
                "liquidity_usd": str(int(q["liquidity_usd"])),
                "volume_24h_usd": str(int(q["volume_24h_usd"])),
                "fdv_usd": str(int(q["fdv_usd"])),
                "qualified": "1" if key in qualified else "0",
                "tracked": "1" if key in tracked and not dead else "0",
                "first_qualified": entry.get("first_qualified", trade_date),
                "status": "dead" if dead else "ok",
            })

    registry = {k: e for k, e in registry.items()
                if day_gap(e["last_qualified"], trade_date) <= config.MEME_REGISTRY_PRUNE_DAYS}
    print(f"[Frontier] {trade_date}: {len(tracked)} tracked, {len(rows)} priced")
    return rows, registry


def upsert(rows, new_rows):
    """Replace every row of the dates present in new_rows (a rerun redoes the day)."""
    dates = {r["date"] for r in new_rows}
    return [r for r in rows if r["date"] not in dates] + list(new_rows)
