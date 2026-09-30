"""
Core Track Collector (CEX & Top 100/300 Spot Universe)
Fetches and cleans top spot assets from CoinGecko / Binance.
Applies negative filter to eliminate stablecoins, wrapped tokens, and LSTs.
"""

import sys
import json
import urllib.request
from pathlib import Path
import pandas as pd
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config
from src.collectors.daily_close_store import DailyCloseStore, effective_pct_change

class CoreTrackCollector:
    def __init__(self, cache_dir=config.CACHE_DIR, close_store: DailyCloseStore = None):
        self.cache_dir = Path(cache_dir)
        self.close_store = close_store or DailyCloseStore(cache_dir)
        self.headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MacroQuant/1.0"}

    def fetch_coingecko_top(self, per_page: int = 100) -> list:
        """
        Fetch top spot market coins from CoinGecko public API.
        """
        url = f"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page={per_page}&page=1&sparkline=false&price_change_percentage=24h"
        try:
            req = urllib.request.Request(url, headers=self.headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, list) and len(data) > 0:
                    print(f"[Core] CoinGecko returned {len(data)} coins.")
                    return data
        except Exception as e:
            print(f"[Core Warning] CoinGecko fetch failed ({e}), falling back to Binance...")
        return []

    def fetch_binance_fallback(self) -> list:
        """
        Fallback: Fetch top liquid spot USDT pairs from Binance 24hr ticker API.
        """
        url = config.BINANCE_24HR_TICKER_URL
        try:
            req = urllib.request.Request(url, headers=self.headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                usdt_pairs = []
                for item in data:
                    sym = item.get("symbol", "")
                    if sym.endswith("USDT") and not sym.endswith("UPUSDT") and not sym.endswith("DOWNUSDT"):
                        base = sym[:-4].lower()
                        vol_usd = float(item.get("quoteVolume", 0.0))
                        pct = float(item.get("priceChangePercent", 0.0))
                        last_p = float(item.get("lastPrice", 0.0))
                        # Only include liquid pairs with 24h volume > $1M
                        if vol_usd >= 1_000_000.0:
                            usdt_pairs.append({
                                "symbol": base,
                                "name": base.upper(),
                                "current_price": last_p,
                                "price_change_percentage_24h": pct,
                                "total_volume": vol_usd,
                                "market_cap": vol_usd * 10.0 # volume-proxy ordering
                            })

                # Sort by volume descending and take top 100
                usdt_pairs.sort(key=lambda x: x["total_volume"], reverse=True)
                top_pairs = usdt_pairs[:100]
                print(f"[Core] Binance fallback returned {len(top_pairs)} active pairs.")
                return top_pairs
        except Exception as e:
            print(f"[Core Error] Binance fallback failed: {e}")
            return []

    def collect_and_clean(self) -> pd.DataFrame:
        """
        Fetch from CoinGecko or fallback, apply negative filter,
        and classify Advances / Declines.
        """
        raw_list = self.fetch_coingecko_top(per_page=100)
        if not raw_list:
            raw_list = self.fetch_binance_fallback()

        if not raw_list:
            raise RuntimeError("Failed to collect Core track data from both CoinGecko and Binance!")

        today = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d")

        cleaned_records = []
        for coin in raw_list:
            sym = str(coin.get("symbol", "")).lower()
            if sym in config.EXCLUDED_SYMBOLS:
                continue

            pct_change = coin.get("price_change_percentage_24h")
            if pct_change is None:
                continue

            price = float(coin.get("current_price") or 0.0)
            key = sym.upper()
            prev_close = self.close_store.previous_close("core", key, today)
            pct, basis = effective_pct_change(price, prev_close, float(pct_change))
            vol = float(coin.get("total_volume") or 0.0)
            mcap = float(coin.get("market_cap") or 0.0)

            cleaned_records.append({
                "symbol": sym.upper(),
                "name": coin.get("name", sym.upper()),
                "price_usd": price,
                "price_change_24h": pct,
                "pct_basis": basis,
                "volume_24h": vol,
                "market_cap": mcap,
                "is_advance": 1 if pct > 0 else 0,
                "is_decline": 1 if pct < 0 else 0,
                "is_unchanged": 1 if pct == 0 else 0
            })

            self.close_store.record("core", key, today, price)

        self.close_store.save()
        df = pd.DataFrame(cleaned_records)

        # Cache snapshot
        cache_file = self.cache_dir / "core_latest.csv"
        df.to_csv(cache_file, index=False)
        print(f"[Core] Cleaned constituents count: {len(df)} (filtered {len(raw_list) - len(df)} stable/wrapped/LST assets).")
        return df

    def compute_breadth_stats(self, df: pd.DataFrame = None) -> dict:
        """
        Compute Advances, Declines, Volume-Weighted Breadth for Core.
        """
        if df is None:
            df = self.collect_and_clean()

        adv_count = int(df["is_advance"].sum())
        dec_count = int(df["is_decline"].sum())
        unch_count = int(df["is_unchanged"].sum())
        total = adv_count + dec_count

        adv_vol = float(df[df["is_advance"] == 1]["volume_24h"].sum())
        dec_vol = float(df[df["is_decline"] == 1]["volume_24h"].sum())
        tot_vol = adv_vol + dec_vol

        # Ratio-Adjusted Net Advances (RAMO)
        ramo = ((adv_count - dec_count) / total * config.RATIO_SCALE) if total > 0 else 0.0
        # Volume-Weighted RAMO
        vramo = ((adv_vol - dec_vol) / tot_vol * config.RATIO_SCALE) if tot_vol > 0 else 0.0

        stats = {
            "track": "Core (CEX / Top 100)",
            "advances": adv_count,
            "declines": dec_count,
            "unchanged": unch_count,
            "total_constituents": len(df),
            "close_basis_count": int((df["pct_basis"] == "close_to_close").sum()) if "pct_basis" in df else 0,
            "rolling_basis_count": int((df["pct_basis"] == "rolling_24h").sum()) if "pct_basis" in df else len(df),
            "ramo": ramo,
            "vramo": vramo,
            "adv_volume_usd": adv_vol,
            "dec_volume_usd": dec_vol,
            "top_gainers": df.nlargest(3, "price_change_24h")[["symbol", "price_change_24h"]].to_dict(orient="records"),
            "top_losers": df.nsmallest(3, "price_change_24h")[["symbol", "price_change_24h"]].to_dict(orient="records")
        }
        return stats

if __name__ == "__main__":
    col = CoreTrackCollector()
    df = col.collect_and_clean()
    st = col.compute_breadth_stats(df)
    print("\n--- Core Track Stats ---")
    print(json.dumps(st, indent=2))