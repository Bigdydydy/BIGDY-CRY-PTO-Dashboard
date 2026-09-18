"""
Configuration for AI-BTC Financing Tension Index & Transmission Analysis Engine
"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
FRED_DIR = DATA_DIR / "fred"
SEC_DIR = DATA_DIR / "sec_edgar"
MARKET_DIR = DATA_DIR / "market"
OUTPUT_DIR = BASE_DIR / "output"

for d in [DATA_DIR, FRED_DIR, SEC_DIR, MARKET_DIR, OUTPUT_DIR]:
    d.mkdir(parents=True, exist_ok=True)

SEC_USER_AGENT = "HedgeFundMacroResearch macro_quant@fundresearch.org"

FRED_SERIES = {
    "WALCL": "Fed Total Assets ($ Millions)",
    "WDTGAL": "Treasury General Account ($ Millions)",
    "WLRRAL": "Fed Reverse Repo ($ Billions)",
    "DFII10": "10Y Real Rate (%)",
    "BAMLH0A0HYM2": "US High Yield OAS Spread (%)",
    "BAMLC0A0CM": "US Investment Grade OAS Spread (%)",
    "DGS10": "10Y Treasury Nominal Yield (%)",
    "SOFR": "Secured Overnight Financing Rate (%)",
    "IORB": "Interest on Reserve Balances (%)",
    "THREEFYTP10": "ACM 10-Year Treasury Term Premium (%)",
}

AI_COMPANIES = {
    "MSFT": {"cik": "0000789019", "name": "Microsoft Corporation", "role": "Hyperscaler / OpenAI Backer"},
    "GOOGL": {"cik": "0001652044", "name": "Alphabet Inc.", "role": "Hyperscaler / Gemini"},
    "AMZN": {"cik": "0001018724", "name": "Amazon.com Inc.", "role": "Hyperscaler / AWS / Anthropic"},
    "META": {"cik": "0001326801", "name": "Meta Platforms, Inc.", "role": "Open-Source AI / Llama"},
    "NVDA": {"cik": "0001045810", "name": "NVIDIA Corporation", "role": "AI Silicon / Compute Bottleneck"},
    "ORCL": {"cik": "0001341439", "name": "Oracle Corporation", "role": "AI Cloud Infrastructure"},
    "SMCI": {"cik": "0001375365", "name": "Super Micro Computer", "role": "AI Server Hardware"},
}

MINER_HPC_COMPANIES = {
    "CORZ": {"cik": "0001984822", "name": "Core Scientific, Inc.", "power_mw": 800, "hpc_partner": "CoreWeave"},
    "IREN": {"cik": "0001878848", "name": "Iris Energy Limited", "power_mw": 500, "hpc_partner": "Next-Gen Cloud/GPU"},
    "WULF": {"cik": "0001083301", "name": "TeraWulf Inc.", "power_mw": 300, "hpc_partner": "Zero-Carbon HPC"},
    "CIFR": {"cik": "0001819989", "name": "Cipher Mining Inc.", "power_mw": 350, "hpc_partner": "HPC Co-location"},
    "CLSK": {"cik": "0000827876", "name": "CleanSpark, Inc.", "power_mw": 400, "hpc_partner": "Power Arbitrage"},
    "HUT": {"cik": "0001964789", "name": "Hut 8 Corp.", "power_mw": 300, "hpc_partner": "HPC/Colocation"},
    "MARA": {"cik": "0001507605", "name": "MARA Holdings, Inc.", "power_mw": 1100, "hpc_partner": "Pure-Play Mining"},
    "RIOT": {"cik": "0001167419", "name": "Riot Platforms, Inc.", "power_mw": 1000, "hpc_partner": "Pure-Play Mining"},
}

HPC_MINER_BASKET = ["CORZ", "IREN", "WULF"]
PURE_MINER_BASKET = ["MARA", "RIOT", "CLSK"]

MARKET_TICKERS = {
    "BTC-USD": "Bitcoin Spot USD",
    "QQQ": "Invesco QQQ Trust (Nasdaq 100)",
    "DX-Y.NYB": "US Dollar Index (DXY)",
    "UUP": "Invesco DB US Dollar Index Bullish Fund (Fallback DXY)",
    "^VIX": "CBOE Volatility Index",
    "BTC=F": "CME Bitcoin Futures (Front Month)",
    "CORZ": "Core Scientific",
    "IREN": "Iris Energy",
    "WULF": "TeraWulf",
    "CIFR": "Cipher Mining",
    "CLSK": "CleanSpark",
    "MARA": "MARA Holdings",
    "RIOT": "Riot Platforms",
    "MSFT": "Microsoft",
    "NVDA": "NVIDIA",
}

I_COMPUTE_WEIGHTS = {
    "miner_hpc_spread": 0.40,
    "capex_to_ocf": 0.25,
    "capex_growth_surprise": 0.20,
    "credit_cost_spread": 0.15,
}

I_CRYPTO_WEIGHTS = {
    "basis_inversion_risk": 0.35,
    "basis_momentum_drain": 0.25,
    "cross_vol_shock": 0.20,
    "miner_equity_squeeze": 0.20,
}

P_AI_WEIGHTS = I_COMPUTE_WEIGHTS
P_BTC_WEIGHTS = I_CRYPTO_WEIGHTS

ROLLING_WINDOW_ZSCORE = 252
EVENT_STUDY_WINDOWS = [(-1, 1), (-1, 5), (-1, 20)]