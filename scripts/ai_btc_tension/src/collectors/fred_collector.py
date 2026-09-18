"""
FRED Data Collector
Collects Fed Balance Sheet (WALCL), TGA (WDTGAL), Reverse Repo (WLRRAL),
10Y Real Rate (DFII10), US HY Spread (BAMLH0A0HYM2), US IG Spread (BAMLC0A0CM).
Calculates Net Fed Liquidity = WALCL - WDTGAL - (WLRRAL * 1000 if WLRRAL is in billions, or WLRRAL directly).
Note: In FRED, WALCL, WDTGAL, WLRRAL are all reported in Millions of Dollars.
Net Fed Liquidity ($ Millions) = WALCL - WDTGAL - WLRRAL.
"""

import subprocess
import io
import pandas as pd
import numpy as np
from pathlib import Path
import config

class FREDCollector:
    def __init__(self, data_dir=config.FRED_DIR):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def fetch_series(self, series_id: str, force_reload: bool = False) -> pd.Series:
        cache_path = self.data_dir / f"{series_id}.csv"
        if cache_path.exists() and not force_reload:
            try:
                df = pd.read_csv(cache_path, index_col=0, parse_dates=True)
                if series_id in df.columns and len(df) > 50:
                    print(f"[FRED] Loaded {series_id} from cache ({len(df)} rows)")
                    return df[series_id]
            except Exception:
                pass

        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
        cmd = ["curl.exe", "-s", "-L", "-m", "12", url]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")

        if res.returncode != 0 or not res.stdout or "date" not in res.stdout.lower():
            raise RuntimeError(f"Failed to fetch {series_id} from FRED: {res.stderr}")

        df = pd.read_csv(io.StringIO(res.stdout))
        df.columns = ["date", series_id]
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df[series_id] = pd.to_numeric(df[series_id], errors="coerce")
        df = df.dropna(subset=["date"]).set_index("date").sort_index()

        df.to_csv(cache_path)
        print(f"[FRED] Fetched {series_id}: {len(df)} records ({df.index.min().date()} to {df.index.max().date()})")
        return df[series_id]

    def fetch_all(self, force_reload: bool = False) -> pd.DataFrame:
        series_dict = {}
        for sid in config.FRED_SERIES:
            try:
                s = self.fetch_series(sid, force_reload=force_reload)
                series_dict[sid] = s
            except Exception as e:
                print(f"[FRED Warning] Failed to fetch {sid}: {e}")

        df = pd.DataFrame(series_dict)
        # Resample onto business days and forward-fill
        df = df.resample("B").last().ffill()

        # Compute Net Fed Liquidity ($ Millions):
        # All WALCL, WDTGAL, WLRRAL are in $ Millions in FRED weekly H.4.1 table
        if "WALCL" in df and "WDTGAL" in df and "WLRRAL" in df:
            df["Fed_Net_Liquidity_M"] = df["WALCL"] - df["WDTGAL"] - df["WLRRAL"]
            df["Fed_Net_Liquidity_B"] = df["Fed_Net_Liquidity_M"] / 1000.0

        # 1. Overnight Money Market Repo Spread: SOFR - IORB (%)
        if "SOFR" in df and "IORB" in df:
            df["repo_spread"] = (df["SOFR"] - df["IORB"]).fillna(0.0)
        else:
            df["repo_spread"] = 0.0

        # 2. ACM 10Y Term Premium: THREEFYTP10 (%)
        if "THREEFYTP10" in df:
            df["term_premium"] = df["THREEFYTP10"].ffill()
            df["delta_term_premium"] = df["term_premium"] - df["term_premium"].shift(1)
        else:
            df["term_premium"] = 0.0
            df["delta_term_premium"] = 0.0

        combined_path = self.data_dir / "fred_combined.csv"
        df.to_csv(combined_path)
        print(f"[FRED] Combined dataset saved ({df.shape[0]} days, {df.shape[1]} series, repo_spread & term_premium included)")
        return df

if __name__ == "__main__":
    c = FREDCollector()
    df = c.fetch_all()
    print(df.tail(3))