"""
Layer 3: Event Study Engine (事件窗口检验)
Tests BTC Cumulative Abnormal Returns (CAR) around major AI Capex guidance updates
and Miner AI/HPC financing/convertible debt announcements across [-1, +1], [-1, +5], [-1, +20] windows.
"""

import pandas as pd
import numpy as np

# Landmark Macro AI Capex Revisions & Miner HPC Financing Events
HISTORICAL_EVENTS = [
    {"date": "2023-11-21", "ticker": "NVDA", "type": "AI Capex Guidance Upward Surprise", "desc": "NVIDIA Q3 FY24 blockbuster datacenter revs, confirms surging cloud capex"},
    {"date": "2024-01-30", "ticker": "MSFT", "type": "AI Capex Surge", "desc": "Microsoft Q2 FY24 earnings: Capex accelerated to $11.5B for AI inf"},
    {"date": "2024-04-25", "ticker": "GOOGL", "type": "AI Capex Guidance Upward Surprise", "desc": "Alphabet Q1 2024: Capex guidance sharply upgraded to $12B/quarter for AI"},
    {"date": "2024-06-03", "ticker": "CORZ", "type": "Miner HPC Conversion Landmark", "desc": "Core Scientific signs landmark 200MW 12-year AI host deal with CoreWeave"},
    {"date": "2024-07-23", "ticker": "GOOGL", "type": "AI Capex Spike", "desc": "Alphabet Q2 2024: Capex surges to $13.2B, intensifies AI ROI debate"},
    {"date": "2024-07-30", "ticker": "MSFT", "type": "AI Capex Record", "desc": "Microsoft Q4 FY24: Quarterly Capex hits record $19B for AI datacenters"},
    {"date": "2024-08-01", "ticker": "WULF", "type": "Miner HPC Convertible Offering", "desc": "TeraWulf announces $350M convertible notes offering to finance AI data center buildout"},
    {"date": "2024-10-29", "ticker": "GOOGL", "type": "AI Capex Guidance Extension", "desc": "Alphabet Q3 2024: Confirms 2025 Capex will increase further"},
    {"date": "2024-10-30", "ticker": "MSFT", "type": "AI Capex Acceleration", "desc": "Microsoft Q1 FY25: Capex expands to $20B/quarter"},
    {"date": "2024-11-20", "ticker": "NVDA", "type": "AI Capex Validation", "desc": "NVIDIA Blackwell launch: Hyperscaler commitment to buildouts confirmed"},
]

class EventStudyEngine:
    def __init__(self, windows=[(-1, 1), (-1, 5), (-1, 20)]):
        self.windows = windows

    def evaluate_events(self, residual_series: pd.Series, btc_ret_series: pd.Series) -> pd.DataFrame:
        """
        Calculate CAR (Cumulative Abnormal Return) using macro orthogonal residuals,
        as well as raw cumulative returns around event dates.
        """
        results = []
        valid_dates = set(residual_series.index)

        for ev in HISTORICAL_EVENTS:
            ev_date = pd.to_datetime(ev["date"])
            # Find nearest trading day
            avail_dates = [d for d in valid_dates if d >= ev_date]
            if not avail_dates:
                continue
            actual_t0 = min(avail_dates)
            t0_loc = residual_series.index.get_loc(actual_t0)

            row = {
                "event_date": ev["date"],
                "trading_day": actual_t0.strftime("%Y-%m-%d"),
                "ticker": ev["ticker"],
                "event_type": ev["type"],
                "description": ev["desc"]
            }

            for pre, post in self.windows:
                start_loc = max(0, t0_loc + pre)
                end_loc = min(len(residual_series) - 1, t0_loc + post)

                # Window slice
                window_resid = residual_series.iloc[start_loc:end_loc + 1]
                window_raw = btc_ret_series.iloc[start_loc:end_loc + 1]

                car = float(window_resid.sum() * 100.0) # percentage
                raw_cum = float(window_raw.sum() * 100.0)
                
                # Standard error and t-stat of CAR
                w_len = len(window_resid)
                vol = window_resid.std() * 100.0 if w_len > 1 else 1.0
                se_car = float(vol * np.sqrt(w_len))
                t_car = float(car / se_car) if se_car > 0 else 0.0

                tag = f"[{pre},{post}]"
                row[f"CAR_{tag}"] = round(car, 2)
                row[f"RawCum_{tag}"] = round(raw_cum, 2)
                row[f"SE_{tag}"] = round(se_car, 2)
                row[f"t_{tag}"] = round(t_car, 2)

            results.append(row)

        df_results = pd.DataFrame(results)
        print(f"[EventStudy] Processed {len(df_results)} macro events with OOS CAR and standard errors.")
        return df_results