"""
Historical Breadth Seeder
Generates and seeds 1-year daily historical Advance/Decline time series
for both Core Track and Frontier Meme Track to warm up EMA19, EMA39,
and calculate the McClellan Summation Index (MSI).
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np
import yfinance as yf

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config

CORE_BASKET_TICKERS = [
    "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "DOGE-USD",
    "ADA-USD", "AVAX-USD", "LINK-USD", "SUI20947-USD", "NEAR-USD", "APT21794-USD",
    "SHIB-USD", "RENDER-USD", "TAO22974-USD", "INJ-USD", "AAVE-USD", "UNI7083-USD",
    "LTC-USD", "BCH-USD", "DOT-USD", "ICP-USD", "XLM-USD", "ETC-USD",
    "HBAR-USD", "ATOM-USD", "FIL-USD", "POL-USD", "TIA22861-USD", "FET-USD"
]

MEME_BASKET_TICKERS = [
    "DOGE-USD", "SHIB-USD", "PEPE24478-USD", "WIF-USD", "BONK-USD",
    "FLOKI-USD", "BRETT-USD", "POPCAT-USD", "MOG-USD", "SPX6900-USD",
    "TURBO-USD", "BOME-USD", "MEME28301-USD", "BABYDOGE-USD", "NEIRO-USD"
]

class HistoricalBreadthSeeder:
    def __init__(self, data_dir=config.DATA_DIR):
        self.data_dir = Path(data_dir)
        self.output_file = self.data_dir / "historical_breadth_series.csv"

    def generate_historical_breadth(self, start_date: str = "2023-10-01") -> pd.DataFrame:
        if self.output_file.exists():
            try:
                df = pd.read_csv(self.output_file, index_col=0, parse_dates=True)
                if len(df) > 100:
                    print(f"[Seeder] Loaded historical breadth series from cache ({len(df)} days).")
                    return df
            except Exception:
                pass

        print(f"[Seeder] Downloading historical candles for Core & Meme baskets to construct breadth history...")
        all_tickers = list(set(CORE_BASKET_TICKERS + MEME_BASKET_TICKERS))
        data = yf.download(all_tickers, start=start_date, auto_adjust=True, progress=False, threads=False)

        if isinstance(data.columns, pd.MultiIndex):
            close = data["Close"]
            vol = data["Volume"]
        else:
            close = data
            vol = None

        close = close.dropna(how="all").ffill()

        # Compute daily returns
        ret = close.pct_change(fill_method=None).dropna(how="all")

        # 1. Core Breadth
        core_cols = [c for c in CORE_BASKET_TICKERS if c in ret.columns]
        core_ret = ret[core_cols]

        core_adv = (core_ret > 0).sum(axis=1)
        core_dec = (core_ret < 0).sum(axis=1)
        core_tot = core_adv + core_dec
        core_ramo = ((core_adv - core_dec) / core_tot.replace(0, np.nan) * config.RATIO_SCALE).fillna(0.0)

        # 2. Meme Breadth
        meme_cols = [c for c in MEME_BASKET_TICKERS if c in ret.columns]
        if not meme_cols:
            meme_cols = core_cols # fallback
        meme_ret = ret[meme_cols]

        # Meme tokens exhibit higher beta and wider dispersion
        meme_adv = (meme_ret > 0).sum(axis=1)
        meme_dec = (meme_ret < 0).sum(axis=1)
        meme_tot = meme_adv + meme_dec
        meme_ramo = ((meme_adv - meme_dec) / meme_tot.replace(0, np.nan) * config.RATIO_SCALE).fillna(0.0)

        # Combine into master daily breadth dataframe
        res = pd.DataFrame(index=ret.index)
        res["core_adv"] = core_adv
        res["core_dec"] = core_dec
        res["core_ramo"] = core_ramo

        res["frontier_adv"] = meme_adv
        res["frontier_dec"] = meme_dec
        res["frontier_ramo"] = meme_ramo

        if "BTC-USD" in close.columns:
            res["btc_close"] = close["BTC-USD"]

        res.to_csv(self.output_file)
        print(f"[Seeder] Successfully seeded historical breadth ({len(res)} days from {res.index.min().date()} to {res.index.max().date()}).")
        return res

if __name__ == "__main__":
    seeder = HistoricalBreadthSeeder()
    df = seeder.generate_historical_breadth()
    print(df.tail(5))