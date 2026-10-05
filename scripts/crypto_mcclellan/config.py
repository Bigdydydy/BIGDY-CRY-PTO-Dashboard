"""
Configuration for the Crypto McClellan Oscillator (Module 1-B).

Two breadth tracks share one methodology:
  - Core track:     CoinGecko Top 100 by market cap, re-ranked every day
  - Frontier track: hot on-chain meme tokens on Solana / BSC / Robinhood Chain
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
RAW_CACHE_DIR = DATA_DIR / "raw_cache"          # seeder download cache (git-ignored)
CORE_STORE_FILE = DATA_DIR / "core_daily.csv"
FRONTIER_STORE_FILE = DATA_DIR / "frontier_snapshots.csv"
FRONTIER_REGISTRY_FILE = DATA_DIR / "frontier_registry.json"
OUTPUT_JSON_FILE = BASE_DIR.parent.parent / "data" / "crypto_mcclellan.json"

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MacroQuant/2.0",
                "Accept": "application/json"}

# A run before 02:00 UTC still belongs to the previous UTC day: the daily cron
# fires at 23:30 UTC and GitHub Actions can start it late.
TRADE_DATE_LAG_HOURS = 2

# -------------------------------------------------------------
# McClellan parameters (classic ratio-adjusted form)
# -------------------------------------------------------------
EMA_FAST = 19
EMA_SLOW = 39
RATIO_SCALE = 1000.0
WARMUP_DAYS = 40            # breadth days before the oscillator is published
BAND_LOW_PCT = 10           # oscillator percentile bands drawn on the chart
BAND_HIGH_PCT = 90
BAND_MIN_OBS = 60           # minimum published days before bands are drawn

# Max calendar gap between two observations that still counts as a daily change
MAX_GAP_DAYS = 3

# -------------------------------------------------------------
# Core track (CoinGecko Top N, point-in-time)
# -------------------------------------------------------------
CORE_TOP_N = 100
CORE_CANDIDATE_N = 300      # candidates stored daily so the Top N can be re-ranked
COINGECKO_BASE = "https://api.coingecko.com/api/v3"
COINGECKO_HISTORY_DAYS = 365  # public API limit

# Stablecoins, wrapped / bridged / staked derivatives and tokenized RWAs.
# Pegged assets the list misses are caught by the volatility / peg filters below.
EXCLUDED_SYMBOLS = {
    # Stablecoins
    "usdt", "usdc", "dai", "fdusd", "usde", "usds", "tusd", "busd", "pyusd", "usd1",
    "crvusd", "frax", "lusd", "ustc", "usdd", "gho", "eurt", "eurc", "usdx", "rlusd",
    "usdtb", "usdg", "bfusd", "susde", "susds", "sdai", "usdy", "usd0", "usdf", "dola",
    "usdb", "usdl", "ylds", "srusd", "frxusd", "a7a5",
    # Wrapped / pegged
    "wbtc", "weth", "wsol", "wbnb", "wmatic", "tbtc", "renbtc", "kbtc", "cbbtc", "lbtc",
    "solvbtc", "btcb", "wbeth", "clbtc", "fbtc", "ubtc", "wtrx", "whype", "weeth", "wavax",
    # Liquid staking / restaking
    "steth", "wsteth", "ezeth", "rseth", "bnsol", "msol", "jitosol", "jupsol", "cbeth",
    "reth", "sfrxeth", "ankreth", "meth", "oseth", "sweth", "stsol", "bbsol", "khype",
    "sthype", "ethx", "pufeth", "lseth", "stkaave",
    # Tokenized commodities / treasuries
    "xaut", "paxg", "kau", "kag", "figr_heloc", "buidl", "usyc", "ousg", "ustb", "benji", "syrupusdc", "syrupusdt",
}
EXCLUDED_NAME_KEYWORDS = ("wrapped", "bridged", "staked", "restaked", "liquid staking",
                          "binance-peg", "tokenized", "stablecoin", "heloc")

STABLE_MEDIAN_ABS_RET = 0.0015   # median |daily return| below this = stable-like
PEG_MEDIAN_ABS_DIFF = 0.0025     # median |ret - ret_ref| below this = derivative of ref
PEG_REFERENCE_IDS = ("bitcoin", "ethereum", "solana", "binancecoin", "tether-gold")
FILTER_MIN_OBS = 20              # observations needed for the peg test
STABLE_MIN_OBS = 3               # a real crypto asset never sits this still for 3 days

# -------------------------------------------------------------
# Frontier meme track (on-chain heat, accumulated forward only)
# -------------------------------------------------------------
GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2"
DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/{chain}/{addresses}"
DEXSCREENER_BATCH = 30
GECKOTERMINAL_SPACING_SEC = 3.0   # free tier rate limit is tight

# GeckoTerminal network id -> DexScreener chain id
MEME_CHAINS = {
    "solana": "solana",
    "bsc": "bsc",
    "robinhood": "robinhood",
}

# Per-chain admission thresholds. Robinhood Chain pools are an order of
# magnitude smaller, so a single global threshold would exclude it entirely.
MEME_GATEKEEPER = {
    "solana":    {"min_liquidity_usd": 100_000, "min_volume_24h_usd": 1_000_000, "min_fdv_usd": 1_000_000},
    "bsc":       {"min_liquidity_usd": 150_000, "min_volume_24h_usd": 750_000, "min_fdv_usd": 3_000_000},
    "robinhood": {"min_liquidity_usd": 40_000,  "min_volume_24h_usd": 150_000, "min_fdv_usd": 400_000},
}
MEME_RETENTION_DAYS = 7          # tracked this long after the last day it qualified
# A tracked token whose pool vanished (no quote) or whose liquidity fell below
# this floor is counted as a decline: rugs must not silently drop out.
MEME_DEAD_LIQUIDITY_USD = 5_000
MEME_MIN_CONSTITUENTS = 20       # days with fewer members are flagged low-sample
MEME_CHAIN_MIN_MEMBERS = 3       # chains below this sit out of the equal-weight RAMO

# External heat anchor: DefiLlama DEX volume momentum, ln(MA7 / MA28) per
# chain, equal-weighted across chains like the Frontier RAMO.
DEFILLAMA_DEX_URL = ("https://api.llama.fi/overview/dexs/{chain}?excludeTotalDataChart=false"
                     "&excludeTotalDataChartBreakdown=true&dataType=dailyVolume")
DEFILLAMA_CHAINS = {"solana": "solana", "bsc": "bsc", "robinhood": "robinhood"}
DEX_VOLUME_FILE = DATA_DIR / "dex_volume.csv"
ANCHOR_FAST, ANCHOR_SLOW = 7, 28
ANCHOR_LAG_DAYS = 2              # DefiLlama daily totals settle about two days late
ANCHOR_MIN_CORR_DAYS = 30        # published days needed before the anchor correlation is shown
MEME_REGISTRY_PRUNE_DAYS = 30

# Base tokens that are never memes: chain natives, quote assets, tokenized stocks.
MEME_NON_MEME_SYMBOLS = {
    "SOL", "WSOL", "BNB", "WBNB", "ETH", "WETH", "BTC", "WBTC", "BTCB", "CBBTC",
    "USDC", "USDT", "USD1", "USDG", "USDE", "FDUSD", "DAI", "PYUSD", "JUP", "JTO",
    "RAY", "CAKE", "HOOD", "NVDA", "TSLA", "AAPL", "AMZN", "MSFT", "GOOGL", "META",
    "COIN", "MSTR", "PLTR", "AMD", "NFLX", "SPY", "QQQ", "CRCL",
}
