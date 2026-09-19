"""
Configuration for Crypto Dual-Track McClellan Oscillator System
"""

from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"
OUTPUT_DIR = BASE_DIR / "output"

for d in [DATA_DIR, CACHE_DIR, OUTPUT_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# -------------------------------------------------------------
# 1. Core Track (CEX / Institutional Base Universe)
# -------------------------------------------------------------
# CoinGecko Top Coins endpoint (free public)
COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h"
BINANCE_24HR_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr"

# Negative Filter List: Assets to exclude from Advances/Declines
# (Stablecoins, wrapped assets, and LSTs/LRTs distort market breadth)
EXCLUDED_SYMBOLS = {
    # Stablecoins
    "usdt", "usdc", "dai", "fdusd", "usde", "usds", "tusd", "busd", "pyusd",
    "crvusd", "frax", "lusd", "ustc", "usdd", "gho", "eurt", "usdx",
    # Wrapped & Pegged Tokens
    "wbtc", "weth", "wsol", "wmatic", "tbtc", "renbtc", "kbtc", "cbbtc",
    # Liquid Staking & Restaking Tokens (LST / LRT)
    "steth", "wsteth", "ezeth", "rseth", "weeth", "bnsol", "msol", "jitosol",
    "cbeth", "reth", "sfrxeth", "ankreth",
    # Tokenized Commodities
    "xaut", "paxg"
}

# -------------------------------------------------------------
# 2. Frontier Meme Track (On-chain Speculative Universe)
# -------------------------------------------------------------
# Supported chains for on-chain meme extraction
MEME_CHAINS = ["solana", "base", "bsc", "ethereum"]

# DexScreener & GeckoTerminal endpoints
DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search?q="
DEXSCREENER_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1"
GECKOTERMINAL_TRENDING_URL = "https://api.geckoterminal.com/api/v2/networks/{network}/trending_pools"

# Dynamic Gatekeeper Thresholds for On-chain Meme Qualification
MEME_GATEKEEPER = {
    "min_liquidity_usd": 300_000.0,   # Floor: $300k locked pool depth
    "min_volume_24h_usd": 1_500_000.0, # Floor: $1.5M daily turnover
    "min_fdv_usd": 10_000_000.0,       # Floor: $10M market cap (Hall of Fame grade)
    "retention_days": 7,              # Days a token stays in tracking once qualified (prevents survivorship bias)
    "max_basket_size": 100            # Max top qualified meme tokens to monitor
}

# -------------------------------------------------------------
# 3. McClellan Oscillator Mathematical Parameters
# -------------------------------------------------------------
EMA_FAST = 19
EMA_SLOW = 39
RATIO_SCALE = 1000.0

# Alert Thresholds
OSC_OVERBOUGHT = 50.0
OSC_OVERSOLD = -50.0
SPREAD_DIVERGENCE_ALERT = 40.0  # Frontier - Core >= 40 indicates acute Meme siphon