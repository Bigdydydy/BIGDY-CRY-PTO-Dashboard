"""
Frontier Meme Track Collector (On-chain Speculative Universe)
Extracts trending and high-liquidity Meme tokens across Solana, Base, and BSC
from GeckoTerminal and DexScreener APIs.
Enforces the 4-Stage Gatekeeper & 7-Day Anti-Survivorship Bias Retention Buffer.
"""

import sys
import time
import json
import urllib.request
from pathlib import Path
import pandas as pd
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config

class FrontierMemeCollector:
    def __init__(self, cache_dir=config.CACHE_DIR):
        self.cache_dir = Path(cache_dir)
        self.registry_file = self.cache_dir / "meme_tracking_registry.json"
        self.headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MacroQuant/1.0"}

    def _load_registry(self) -> dict:
        if self.registry_file.exists():
            try:
                with open(self.registry_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _save_registry(self, registry: dict):
        with open(self.registry_file, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)

    def fetch_geckoterminal_trending(self, network: str) -> list:
        """
        Fetch trending pools from GeckoTerminal for network (solana, base, bsc, etc.)
        """
        url = config.GECKOTERMINAL_TRENDING_URL.format(network=network)
        pools = []
        try:
            req = urllib.request.Request(url, headers=self.headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for item in data.get("data", []):
                    attr = item.get("attributes", {})
                    name = attr.get("name", "")
                    symbol = name.split("/")[0].strip().upper()
                    base_price = float(attr.get("base_token_price_usd") or 0.0)
                    fdv = float(attr.get("fdv_usd") or 0.0)
                    liq = float(attr.get("reserve_in_usd") or 0.0)
                    vol24 = float(attr.get("volume_usd", {}).get("h24") or 0.0)
                    pct24 = float(attr.get("price_change_percentage", {}).get("h24") or 0.0)

                    pools.append({
                        "id": item.get("id"),
                        "symbol": symbol,
                        "name": name,
                        "chain": network,
                        "price_usd": base_price,
                        "fdv_usd": fdv,
                        "liquidity_usd": liq,
                        "volume_24h": vol24,
                        "price_change_24h": pct24
                    })
            print(f"[Frontier] GeckoTerminal {network} returned {len(pools)} trending pools.")
        except Exception as e:
            print(f"[Frontier Warning] GeckoTerminal {network} failed: {e}")
        return pools

    def fetch_dexscreener_seeds(self) -> list:
        """
        Fetch DexScreener search results for major meme anchors.
        """
        meme_anchors = ["PEPE", "WIF", "BONK", "BRETT", "POPCAT", "MOG", "SPX", "GOAT", "FARTCOIN", "PNUT", "CHILLGUY", "TRUMP", "VIRTUAL", "AI16Z"]
        all_pairs = []
        for anchor in meme_anchors[:8]: # Fetch first 8 to avoid rate limits
            url = f"{config.DEXSCREENER_SEARCH_URL}{anchor}"
            try:
                time.sleep(0.1)
                req = urllib.request.Request(url, headers=self.headers)
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    pairs = data.get("pairs", [])
                    for p in pairs[:3]: # Take top 3 pairs per anchor
                        sym = p.get("baseToken", {}).get("symbol", "").upper()
                        chain = p.get("chainId", "unknown")
                        pct24 = float(p.get("priceChange", {}).get("h24") or 0.0)
                        liq = float(p.get("liquidity", {}).get("usd") or 0.0)
                        vol24 = float(p.get("volume", {}).get("h24") or 0.0)
                        fdv = float(p.get("fdv") or 0.0)
                        price = float(p.get("priceUsd") or 0.0)

                        all_pairs.append({
                            "id": f"{chain}_{p.get('pairAddress')}",
                            "symbol": sym,
                            "name": p.get("baseToken", {}).get("name", sym),
                            "chain": chain,
                            "price_usd": price,
                            "fdv_usd": fdv,
                            "liquidity_usd": liq,
                            "volume_24h": vol24,
                            "price_change_24h": pct24
                        })
            except Exception as e:
                pass
        print(f"[Frontier] DexScreener seed queries returned {len(all_pairs)} candidate pairs.")
        return all_pairs

    def collect_and_gatekeep(self) -> pd.DataFrame:
        """
        Merge candidate pools, apply gatekeeper thresholds, and update
        the 7-day retention registry to eliminate survivorship bias.
        """
        registry = self._load_registry()
        current_time = time.time()
        retention_window = config.MEME_GATEKEEPER["retention_days"] * 86400.0

        candidates = []
        # 1. Fetch from GeckoTerminal
        for net in ["solana", "base", "bsc"]:
            candidates.extend(self.fetch_geckoterminal_trending(net))

        # 2. Fetch from DexScreener
        candidates.extend(self.fetch_dexscreener_seeds())

        # Apply Gatekeeper Criteria
        min_liq = config.MEME_GATEKEEPER["min_liquidity_usd"]
        min_vol = config.MEME_GATEKEEPER["min_volume_24h_usd"]
        min_fdv = config.MEME_GATEKEEPER["min_fdv_usd"]

        newly_qualified = 0
        for item in candidates:
            sym = item["symbol"].lower()
            if sym in config.EXCLUDED_SYMBOLS:
                continue

            # Check if meets qualification standards
            if item["liquidity_usd"] >= min_liq and item["volume_24h"] >= min_vol and item["fdv_usd"] >= min_fdv:
                key = f"{item['chain']}_{item['symbol']}"
                if key not in registry:
                    newly_qualified += 1
                    registry[key] = {
                        "symbol": item["symbol"],
                        "name": item["name"],
                        "chain": item["chain"],
                        "first_seen": current_time,
                        "retention_until": current_time + retention_window,
                        "price_change_24h": item["price_change_24h"],
                        "volume_24h": item["volume_24h"],
                        "liquidity_usd": item["liquidity_usd"],
                        "fdv_usd": item["fdv_usd"]
                    }
                else:
                    # Update live quote and extend retention
                    registry[key]["retention_until"] = max(registry[key].get("retention_until", 0), current_time + retention_window)
                    registry[key]["price_change_24h"] = item["price_change_24h"]
                    registry[key]["volume_24h"] = item["volume_24h"]
                    registry[key]["liquidity_usd"] = item["liquidity_usd"]
                    registry[key]["fdv_usd"] = item["fdv_usd"]
            elif f"{item['chain']}_{item['symbol']}" in registry:
                # Even if it dropped below threshold today, update price change for decline tracking!
                key = f"{item['chain']}_{item['symbol']}"
                registry[key]["price_change_24h"] = item["price_change_24h"]
                registry[key]["volume_24h"] = item["volume_24h"]

        # Clean expired tokens (older than retention window)
        active_tokens = {}
        for k, v in registry.items():
            if v.get("retention_until", 0) > current_time:
                active_tokens[k] = v

        self._save_registry(active_tokens)

        # Build DataFrame of Active Tracking Meme Universe
        records = []
        for k, v in active_tokens.items():
            pct = float(v.get("price_change_24h", 0.0))
            records.append({
                "key": k,
                "symbol": v["symbol"],
                "name": v.get("name", v["symbol"]),
                "chain": v.get("chain", "solana"),
                "price_change_24h": pct,
                "volume_24h": float(v.get("volume_24h", 0.0)),
                "liquidity_usd": float(v.get("liquidity_usd", 0.0)),
                "fdv_usd": float(v.get("fdv_usd", 0.0)),
                "is_advance": 1 if pct > 0 else 0,
                "is_decline": 1 if pct < 0 else 0,
                "is_unchanged": 1 if pct == 0 else 0
            })

        df = pd.DataFrame(records)
        if not df.empty:
            df = df.sort_values("volume_24h", ascending=False).head(config.MEME_GATEKEEPER["max_basket_size"])

        cache_file = self.cache_dir / "frontier_meme_latest.csv"
        df.to_csv(cache_file, index=False)
        print(f"[Frontier] Active qualified Meme universe: {len(df)} tokens (Newly added: {newly_qualified}).")
        return df

    def compute_breadth_stats(self, df: pd.DataFrame = None) -> dict:
        if df is None or df.empty:
            df = self.collect_and_gatekeep()

        adv_count = int(df["is_advance"].sum()) if not df.empty else 0
        dec_count = int(df["is_decline"].sum()) if not df.empty else 0
        unch_count = int(df["is_unchanged"].sum()) if not df.empty else 0
        total = adv_count + dec_count

        adv_vol = float(df[df["is_advance"] == 1]["volume_24h"].sum()) if not df.empty else 0.0
        dec_vol = float(df[df["is_decline"] == 1]["volume_24h"].sum()) if not df.empty else 0.0
        tot_vol = adv_vol + dec_vol

        ramo = ((adv_count - dec_count) / total * config.RATIO_SCALE) if total > 0 else 0.0
        vramo = ((adv_vol - dec_vol) / tot_vol * config.RATIO_SCALE) if tot_vol > 0 else 0.0

        stats = {
            "track": "Frontier Meme (Solana / Base / BSC)",
            "advances": adv_count,
            "declines": dec_count,
            "unchanged": unch_count,
            "total_constituents": len(df),
            "ramo": ramo,
            "vramo": vramo,
            "adv_volume_usd": adv_vol,
            "dec_volume_usd": dec_vol,
            "top_gainers": df.nlargest(3, "price_change_24h")[["symbol", "chain", "price_change_24h"]].to_dict(orient="records") if not df.empty else [],
            "top_losers": df.nsmallest(3, "price_change_24h")[["symbol", "chain", "price_change_24h"]].to_dict(orient="records") if not df.empty else []
        }
        return stats

if __name__ == "__main__":
    col = FrontierMemeCollector()
    df = col.collect_and_gatekeep()
    st = col.compute_breadth_stats(df)
    print("\n--- Frontier Meme Track Stats ---")
    print(json.dumps(st, indent=2))