# 加密双轨麦克莱伦振荡器系统 (Crypto Dual-Track McClellan Oscillator Platform)

## 1. 为什么传统美股 McClellan 无法直接用于 Crypto？

传统美股（NYSE/NASDAQ）具有相对稳定的上市标的池与明确的收盘时间（美东 16:00），直接计算 `Advances - Declines`（上涨家数减下跌家数）即可获得有效的市场广度。但在加密市场：
1. **极端幂律分布与垃圾币噪音**：如果全网统计几万个代币，极低流动性的链上土狗会制造巨大的虚假“上涨/下跌”。
2. **非标资产污染**：稳定币（USDT/USDC）与流动性质押代币（stETH 等）在 0 轴附近的微幅波动会严重稀释广度信号。
3. **上市标的数量随年份暴增**：若采用绝对数值 `(Adv - Dec)`，指标振幅会随年份扩张导致历史分位阈值失效。
4. **流动性割裂与 Meme 轮动**：存量资金常在主流 CEX 现货与链上高频 Meme（Solana、Base、BSC、Robinhood）之间发生“抽血式”轮动。

---

## 2. 核心架构与组成成分设计

本项目构建专为加密市场结构设计的**双轨市场广度与流动性剪刀差监控系统**：

### 轨道 1：机构基石轨 (Core Track)
- **标的池**：CoinGecko Top 100/300 现货 + 币安高频 USDT 现货交易对。
- **严格负面清单过滤**：
  - **稳定币**：`USDT`, `USDC`, `DAI`, `FDUSD`, `USDe`, `USDS` 等；
  - **流动性质押与再质押资产**：`stETH`, `wstETH`, `ezETH`, `weETH`, `bnsol` 等；
  - **包装与跨链资产**：`WBTC`, `WETH` 等。
- **产出**：反映合规资本与主流现货的健康广度水位。

### 轨道 2：链上 Meme 投机前沿轨 (Frontier Meme Track)
- **标的池**：DexScreener & GeckoTerminal 跨链热点池（覆盖 Solana、Base、BSC 等生态）。
- **四道动态准入门槛 (Dynamic Gatekeeper)**：
  1. **锁仓流动性 (LP)**：$\ge \$300,000$（剔除单机盘与易撤池项目）；
  2. **24h 真实成交额**：$\ge \$1,500,000$（确保有充分换手）；
  3. **完全稀释市值 (FDV)**：$\ge \$10,000,000$（DexScreener Hall of Fame 级别实质门槛）；
  4. **7 天退出冷却缓冲 (Anti-Survivorship Bias Buffer)**：代币一旦入选，强制在池中追踪 **7 天**，即使随后暴跌 80% 也如实计入“下跌家数（Declines）”，彻底解决链上 Meme 唯有赢家留存的幸存者偏差！

---

## 3. 数学与量化指标定义

### 比率调整净上涨值 (RAMO)
$$\text{RAMO}_t = \frac{\text{Advances}_t - \text{Declines}_t}{\text{Advances}_t + \text{Declines}_t} \times 1000.0$$
*数值严格落在 $[-1000, +1000]$ 区间内，不受成分数量动态变动影响。*

### 双重指数平滑与振荡器
$$\text{EMA}_{\text{fast}, t} = \text{EMA}_{19}(\text{RAMO}_t)$$
$$\text{EMA}_{\text{slow}, t} = \text{EMA}_{39}(\text{RAMO}_t)$$
$$\text{McClellan Oscillator}_t = \text{EMA}_{19, t} - \text{EMA}_{39, t}$$

### 麦克莱伦累加指数 (McClellan Summation Index, MSI)
$$\text{MSI}_t = \text{MSI}_{t-1} + \text{McClellan Oscillator}_t$$
*用于跟踪跨越数周乃至数月的宏观牛熊广度大中枢。*

### 流动性剪刀差 (Liquidity Divergence Spread)
$$\text{Spread}_t = \text{Oscillator}_{\text{Frontier}} - \text{Oscillator}_{\text{Core}}$$

---

## 4. 四类市场机制状态诊断

| 状态类型 | 状态名称 | 判定特征 | 策略/风险含义 |
| :--- | :--- | :--- | :--- |
| **Q1** | **全域共振繁荣 (Co-Expansion)** | Core $> 0$, Frontier $> 0$ | 风险偏好全面打开，全市场增量流动性充沛，顺势持仓。 |
| **Q2** | **末日轮动·流动性抽血 (Meme Siphon) ⚠️** | Frontier $\ge +20$, Core $\le 0$ 或 Spread $\ge +35$ | **极度危险见顶信号！** 散户饥渴冲入链上 Meme，主流现货流血阴跌，存量博弈衰竭。 |
| **Q3** | **优质资产吸筹·前沿去杠杆 (Quality Flow)** | Core $> 0$, Frontier $\le -15$ | Meme 泡沫快速刺破，资金回流具备造血能力的主流币，优质资产反弹。 |
| **Q4** | **全域冰点出清·极度超卖 (Deep Freeze)** | Core $< -25$, Frontier $< -25$ | 情绪极度绝望，全网无差别杀跌，历史上属于非对称建仓窗口。 |

---

## 5. 一键运行与更新

```bash
# 进入工程目录
cd crypto_mcclellan_oscillator

# 一键执行日度数据采集、广度测算与看板渲染
python run_pipeline.py
```

执行完成后，在浏览器中打开 `output/crypto_mcclellan_dashboard.html` 查看高密度、交互式量化仪表盘。