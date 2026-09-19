"""
McClellan Oscillator Calculation Engine
Implements:
  1. Ratio-Adjusted Net Advances (RAMO)
  2. Dual Exponential Moving Averages (EMA19, EMA39)
  3. McClellan Oscillator = EMA19 - EMA39
  4. McClellan Summation Index (MSI) = Cumsum(Oscillator)
"""

import pandas as pd
import numpy as np
import config

class McClellanEngine:
    def __init__(self, fast_span: int = config.EMA_FAST, slow_span: int = config.EMA_SLOW, scale: float = config.RATIO_SCALE):
        self.fast_span = fast_span
        self.slow_span = slow_span
        self.scale = scale

    def calculate_ramo_series(self, adv_series: pd.Series, dec_series: pd.Series) -> pd.Series:
        """
        Calculate daily Ratio-Adjusted Net Advances:
          RAMO = (Adv - Dec) / (Adv + Dec) * 1000.0
        """
        total = adv_series + dec_series
        ramo = (adv_series - dec_series) / total.replace(0, np.nan) * self.scale
        return ramo.fillna(0.0)

    def calculate_oscillator(self, ramo_series: pd.Series) -> pd.DataFrame:
        """
        Compute fast EMA, slow EMA, McClellan Oscillator, and Summation Index.
        """
        res = pd.DataFrame(index=ramo_series.index)
        res["ramo"] = ramo_series

        # EMA with standard span (fast=19, slow=39)
        res["ema_fast"] = ramo_series.ewm(span=self.fast_span, adjust=False).mean()
        res["ema_slow"] = ramo_series.ewm(span=self.slow_span, adjust=False).mean()

        # McClellan Oscillator
        res["oscillator"] = res["ema_fast"] - res["ema_slow"]

        # McClellan Summation Index (MSI): Cumulative Sum of Oscillator
        res["summation_index"] = 1000.0 + res["oscillator"].cumsum()

        return res

    def process_breadth_dataframe(self, breadth_df: pd.DataFrame, prefix: str = "core") -> pd.DataFrame:
        """
        Processes a dataframe with {prefix}_adv and {prefix}_dec columns.
        """
        adv = breadth_df[f"{prefix}_adv"]
        dec = breadth_df[f"{prefix}_dec"]
        ramo = self.calculate_ramo_series(adv, dec)

        osc_df = self.calculate_oscillator(ramo)
        osc_df.columns = [f"{prefix}_{col}" for col in osc_df.columns]
        return osc_df