"""
Market Data Collector
Collects BTC-USD, CME Futures (BTC=F), QQQ, DXY/UUP, VIX, Miner basket (CORZ, IREN, CIFR, etc.)
Calculates CME Annualized Basis, Log Returns, and Volatility.
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np
import yfinance as yf

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config

class MarketDataCollector:
    def __init__(self, data_dir=config.MARKET_DIR):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def fetch_tickers(self, start_date: str = "2022-01-01", force_reload: bool = False) -> pd.DataFrame:
        cache_path = self.data_dir / "market_prices.csv"
        if cache_path.exists() and not force_reload:
            try:
                df = pd.read_csv(cache_path, index_col=0, parse_dates=True)
                missing = [t for t in config.MARKET_TICKERS.keys() if t not in df.columns and t not in ["DX-Y.NYB", "UUP"]]
                if len(df) > 100 and not missing:
                    print(f"[Market] Loaded market prices from cache ({len(df)} rows)")
                    return df
                elif missing:
                    print(f"[Market] Missing tickers {missing} in cache, downloading fresh market data...")
            except Exception:
                pass

        tickers = list(config.MARKET_TICKERS.keys())
        print(f"[Market] Downloading {len(tickers)} tickers via yfinance: {tickers}")
        data = yf.download(tickers, start=start_date, auto_adjust=True, progress=False, threads=False)

        if isinstance(data.columns, pd.MultiIndex):
            close_df = data["Close"]
        else:
            close_df = data

        # Synthesize DXY from UUP if DX-Y.NYB has missing values
        if "DX-Y.NYB" in close_df and "UUP" in close_df:
            close_df["DXY"] = close_df["DX-Y.NYB"].fillna(close_df["UUP"] * 3.75)
        elif "DX-Y.NYB" in close_df:
            close_df["DXY"] = close_df["DX-Y.NYB"]
        elif "UUP" in close_df:
            close_df["DXY"] = close_df["UUP"] * 3.75

        # Forward fill weekends for non-crypto assets to align with daily crypto trading
        close_df = close_df.ffill().dropna(subset=["BTC-USD"])

        # Compute CME Basis: (BTC=F - BTC-USD) / BTC-USD * 12.0 (annualized ~1 month)
        if "BTC=F" in close_df and "BTC-USD" in close_df:
            raw_basis = (close_df["BTC=F"] - close_df["BTC-USD"]) / close_df["BTC-USD"]
            close_df["CME_Annualized_Basis"] = raw_basis * 12.0
        else:
            close_df["CME_Annualized_Basis"] = 0.05  # baseline 5% annualized contango

        close_df.to_csv(cache_path)
        print(f"[Market] Market prices saved ({len(close_df)} days from {close_df.index.min().date()} to {close_df.index.max().date()})")
        return close_df

    def compute_returns_and_factors(self, df: pd.DataFrame = None) -> pd.DataFrame:
        if df is None:
            df = self.fetch_tickers()

        factors = pd.DataFrame(index=df.index)

        # Asset Log Returns
        factors["btc_ret"] = np.log(df["BTC-USD"] / df["BTC-USD"].shift(1))
        factors["qqq_ret"] = np.log(df["QQQ"] / df["QQQ"].shift(1))
        factors["dxy_ret"] = np.log(df["DXY"] / df["DXY"].shift(1))
        factors["vix_level"] = df["^VIX"]
        factors["vix_delta"] = df["^VIX"] - df["^VIX"].shift(1)
        factors["basis"] = df["CME_Annualized_Basis"].fillna(0.05)
        factors["basis_delta_30d"] = factors["basis"] - factors["basis"].rolling(30, min_periods=5).mean()

        # Miner Basket Returns
        miner_tickers = [m for m in ["CORZ", "IREN", "WULF", "CIFR", "CLSK", "MARA", "RIOT"] if m in df.columns]
        if miner_tickers:
            miner_ret_df = np.log(df[miner_tickers] / df[miner_tickers].shift(1))
            factors["miner_basket_ret"] = miner_ret_df.mean(axis=1)

        # Miner HPC Pivot vs Pure-Play Mining Arbitrage Spread
        hpc_tickers = [m for m in getattr(config, "HPC_MINER_BASKET", ["CORZ", "IREN", "WULF"]) if m in df.columns]
        pure_tickers = [m for m in getattr(config, "PURE_MINER_BASKET", ["MARA", "RIOT", "CLSK"]) if m in df.columns]

        if hpc_tickers and pure_tickers:
            hpc_price_mean = df[hpc_tickers].mean(axis=1)
            pure_price_mean = df[pure_tickers].mean(axis=1)
            ratio = (hpc_price_mean / pure_price_mean.replace(0, np.nan)).ffill().bfill()
            factors["hpc_vs_pure_ratio"] = ratio
            # Log ratio of HPC basket to pure-play basket
            log_ratio = np.log(ratio.replace(0, np.nan)).ffill().fillna(0.0)
            factors["miner_hpc_log_spread"] = log_ratio
        else:
            factors["hpc_vs_pure_ratio"] = 1.0
            factors["miner_hpc_log_spread"] = 0.0

        # Hyperscaler Returns
        ai_stock_tickers = [a for a in ["MSFT", "NVDA"] if a in df.columns]
        if ai_stock_tickers:
            ai_ret_df = np.log(df[ai_stock_tickers] / df[ai_stock_tickers].shift(1))
            factors["ai_stock_basket_ret"] = ai_ret_df.mean(axis=1)

        factors["btc_close"] = df["BTC-USD"]
        factors["qqq_close"] = df["QQQ"]

        factors_path = self.data_dir / "market_factors.csv"
        factors.to_csv(factors_path)
        print(f"[Market] Computed market factors saved ({len(factors)} rows)")
        return factors

if __name__ == "__main__":
    m = MarketDataCollector()
    p = m.fetch_tickers()
    f = m.compute_returns_and_factors(p)
    print(f.tail(3))