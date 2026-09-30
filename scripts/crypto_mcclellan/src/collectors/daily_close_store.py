"""
Daily Close Store
Persists per-symbol UTC daily closes so that Advance/Decline classification
uses a consistent close-to-close basis aligned with the seeded historical
breadth series, instead of the sliding rolling-24h window returned by
market APIs. Every stored (date, track, key) row also acts as a
point-in-time snapshot of which constituents were live that day.
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config

BASIS_CLOSE_TO_CLOSE = "close_to_close"
BASIS_ROLLING_24H = "rolling_24h"

CLOSE_STORE_FILE = "daily_closes.csv"


def effective_pct_change(current_price, previous_close, api_rolling_pct):
    """
    Resolve the daily percent change used for breadth classification.
    Prefers UTC close-to-close against the stored previous daily close;
    falls back to the API rolling-24h change when no prior close exists
    (first observation of a constituent).

    Returns (pct_change, basis).
    """
    if (previous_close is not None and np.isfinite(previous_close)
            and previous_close > 0 and current_price is not None
            and np.isfinite(current_price) and current_price > 0):
        return (current_price / previous_close - 1.0) * 100.0, BASIS_CLOSE_TO_CLOSE

    if api_rolling_pct is not None and np.isfinite(api_rolling_pct):
        return float(api_rolling_pct), BASIS_ROLLING_24H

    return 0.0, BASIS_ROLLING_24H


class DailyCloseStore:
    """
    Long-format CSV store keyed by (date, track, key):
        date      YYYY-MM-DD (UTC)
        track     e.g. "core" | "frontier"
        key       constituent identifier (symbol for core, chain_symbol for frontier)
        close_usd USD close price recorded for that UTC date
    """

    def __init__(self, cache_dir=config.CACHE_DIR, file_name=CLOSE_STORE_FILE):
        self.path = Path(cache_dir) / file_name
        self.frame = self._load()

    def _load(self) -> pd.DataFrame:
        cols = {"date": str, "track": str, "key": str, "close_usd": float}
        if self.path.exists():
            try:
                df = pd.read_csv(self.path, dtype=cols)
                df = df.dropna(subset=list(cols.keys()))
                return df.sort_values(["track", "key", "date"]).reset_index(drop=True)
            except Exception as e:
                print(f"[CloseStore] Failed to load {self.path.name}: {e}; starting fresh.")
        return pd.DataFrame(columns=list(cols.keys()))

    def record(self, track: str, key: str, date: str, close_usd: float):
        """Upsert one (track, key, date) close."""
        if close_usd is None or not np.isfinite(close_usd) or close_usd <= 0:
            return
        mask = ((self.frame["track"] == track)
                & (self.frame["key"] == key)
                & (self.frame["date"] == date))
        if mask.any():
            self.frame.loc[mask, "close_usd"] = float(close_usd)
        else:
            self.frame.loc[len(self.frame)] = {
                "date": date, "track": track, "key": key, "close_usd": float(close_usd)
            }

    def upsert_frame(self, long_df: pd.DataFrame):
        """
        Bulk upsert from a long dataframe with columns [date, track, key, close_usd].
        Incoming rows win on duplicate (date, track, key).
        """
        if long_df is None or long_df.empty:
            return
        long_df = long_df[["date", "track", "key", "close_usd"]].dropna()
        long_df = long_df[long_df["close_usd"] > 0]
        long_df["date"] = long_df["date"].astype(str)
        combined = pd.concat([self.frame, long_df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["date", "track", "key"], keep="last")
        self.frame = combined.sort_values(["track", "key", "date"]).reset_index(drop=True)

    def previous_close(self, track: str, key: str, as_of_date: str):
        """Latest stored close strictly before as_of_date, or None."""
        sub = self.frame[(self.frame["track"] == track)
                         & (self.frame["key"] == key)
                         & (self.frame["date"] < as_of_date)]
        if sub.empty:
            return None
        return float(sub["close_usd"].iloc[-1])

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.frame.to_csv(self.path, index=False)
