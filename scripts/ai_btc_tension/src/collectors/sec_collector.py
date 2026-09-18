"""
SEC EDGAR XBRL Data Collector
Collects quarterly CapEx, Operating Cash Flow (OCF), Cash, and Debt Issuance
from the official SEC EDGAR Company Facts API.
Extracts clean quarterly non-cumulative statements.
"""

import json
import time
import requests
import pandas as pd
import numpy as np
from pathlib import Path
import config

class SECEdgarCollector:
    def __init__(self, data_dir=config.SEC_DIR, user_agent=config.SEC_USER_AGENT):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.headers = {"User-Agent": user_agent}

    def fetch_company_facts(self, cik: str, force_reload: bool = False) -> dict:
        cik_clean = str(cik).zfill(10)
        cache_file = self.data_dir / f"CIK{cik_clean}.json"

        if cache_file.exists() and not force_reload:
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass

        url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik_clean}.json"
        time.sleep(0.12)
        resp = requests.get(url, headers=self.headers, timeout=15)
        if resp.status_code != 200:
            raise RuntimeError(f"SEC EDGAR API status {resp.status_code} for CIK {cik_clean}")

        data = resp.json()
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f)

        print(f"[SEC] Saved facts for {data.get('entityName')} (CIK {cik_clean})")
        return data

    def extract_quarterly_tag(self, facts: dict, tag_candidates: list) -> pd.Series:
        us_gaap = facts.get("facts", {}).get("us-gaap", {})
        target_fact = None
        for tag in tag_candidates:
            if tag in us_gaap:
                target_fact = us_gaap[tag]
                break

        if not target_fact:
            return pd.Series(dtype=float)

        usd_items = target_fact.get("units", {}).get("USD", [])
        if not usd_items:
            return pd.Series(dtype=float)

        rows = []
        for it in usd_items:
            form = it.get("form", "")
            if form in ["10-Q", "10-K"] and "end" in it and "start" in it:
                start_dt = pd.to_datetime(it["start"], errors="coerce")
                end_dt = pd.to_datetime(it["end"], errors="coerce")
                if pd.notna(start_dt) and pd.notna(end_dt):
                    dur = (end_dt - start_dt).days
                    rows.append({
                        "end": end_dt,
                        "val": float(it["val"]),
                        "dur": dur,
                        "fp": it.get("fp")
                    })

        if not rows:
            return pd.Series(dtype=float)

        df = pd.DataFrame(rows).sort_values("end")
        # Standard quarterly duration is ~90 days (between 60 and 120 days)
        df_q = df[(df["dur"] >= 60) & (df["dur"] <= 120)].drop_duplicates(subset=["end"], keep="last")
        if df_q.empty:
            return pd.Series(dtype=float)

        s = pd.Series(df_q["val"].values, index=pd.DatetimeIndex(df_q["end"])).sort_index()
        return s

    def parse_company_financials(self, cik: str, ticker: str = "") -> pd.DataFrame:
        facts = self.fetch_company_facts(cik)

        capex_tags = [
            "PaymentsToAcquirePropertyPlantAndEquipment",
            "PaymentsToAcquireProductiveAssets"
        ]
        ocf_tags = [
            "NetCashProvidedByUsedInOperatingActivities"
        ]
        debt_tags = [
            "ProceedsFromIssuanceOfLongTermDebt",
            "ProceedsFromIssuanceOfDebt"
        ]

        s_capex = self.extract_quarterly_tag(facts, capex_tags).abs()
        s_ocf = self.extract_quarterly_tag(facts, ocf_tags)
        s_debt = self.extract_quarterly_tag(facts, debt_tags)

        # Union of dates
        idx = s_capex.index.union(s_ocf.index).union(s_debt.index).sort_values()
        if len(idx) == 0:
            return pd.DataFrame()

        df = pd.DataFrame(index=pd.DatetimeIndex(idx))
        df["capex"] = s_capex.reindex(df.index).ffill()
        df["ocf"] = s_ocf.reindex(df.index).ffill()
        df["debt_issuance"] = s_debt.reindex(df.index).fillna(0.0)

        df["capex_to_ocf"] = df["capex"] / df["ocf"].replace(0, np.nan)
        df["fcf_gap"] = df["capex"] - df["ocf"]
        df["ticker"] = ticker
        return df

    def collect_ai_universe(self) -> pd.DataFrame:
        all_dfs = []
        for ticker, info in config.AI_COMPANIES.items():
            try:
                print(f"[SEC] Collecting AI company {ticker} ({info['name']})...")
                df = self.parse_company_financials(info["cik"], ticker=ticker)
                if not df.empty:
                    df["company"] = info["name"]
                    df["role"] = info["role"]
                    all_dfs.append(df)
            except Exception as e:
                print(f"[SEC Warning] Failed to collect {ticker}: {e}")

        if not all_dfs:
            return pd.DataFrame()

        combined = pd.concat(all_dfs)
        pivot_capex = combined.pivot_table(index=combined.index, columns="ticker", values="capex").sum(axis=1)
        pivot_ocf = combined.pivot_table(index=combined.index, columns="ticker", values="ocf").sum(axis=1)
        pivot_debt = combined.pivot_table(index=combined.index, columns="ticker", values="debt_issuance").sum(axis=1)

        agg_df = pd.DataFrame({
            "total_capex": pivot_capex,
            "total_ocf": pivot_ocf,
            "total_debt_issuance": pivot_debt,
            "aggregate_capex_to_ocf": pivot_capex / pivot_ocf.replace(0, np.nan),
            "aggregate_fcf_gap": pivot_capex - pivot_ocf
        }).dropna(how="all")

        out_path = self.data_dir / "ai_universe_quarterly.csv"
        agg_df.to_csv(out_path)
        print(f"[SEC] AI Universe aggregate financials saved ({len(agg_df)} quarters)")
        return agg_df

if __name__ == "__main__":
    sec = SECEdgarCollector()
    agg = sec.collect_ai_universe()
    print(agg.tail(4))