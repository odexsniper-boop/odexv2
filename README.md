# Solana Momentum Reclaim Bot & Web Dashboard (ODEX V2)

An ultra-low-latency Solana Pump.fun momentum reclaim and sniping engine with an integrated real-time AMOLED web dashboard.

---

## Architecture Overview

1. **Stage 1: Narrative Engine (`engines/narrativeEngine.js`)**
   - Filters tokens by meme hook, cultural themes (AI Meta, Viral Animals, Influencer Meta, CTOs), and social footprint (Twitter/X, Telegram, Website).
   - Drops >90% of bot spam before capital commitment.

2. **Stage 2: Money Flow & Manipulation Engine (`engines/manipulationEngine.js`)**
   - Audits net volume delta, buyer breadth, buy/sell ratios, and dev wallet dumping.
   - Immediate veto if creator dumps or top non-curve holders exceed 35%.

3. **Stage 3: 3-Candle Pattern Trigger (`engines/priceEngine.js`)**
   - Detects breakout-retest higher-low consolidations or momentum accelerations.
   - Evaluated by the adaptive `SmartAgent` before execution.

4. **Execution Engine (`engines/executionEngine.js`)**
   - Background blockhash cache, pre-warmed token ATA resolution, and Jito MEV bundle routing.

5. **Position Manager (`engines/positionManager.js`)**
   - Automated stop-loss (-16%), trailing stops (+25% activation), tiered take-profits (+35%, +100%), and honeypot front-run liquidation.

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Fill in your Solana RPC URL, Telegram bot credentials (optional), and trading wallet keypair.

### 3. Launch the Web Dashboard
```bash
npm run dashboard
```
Open your browser at **`http://localhost:3005`**.

### 4. Run Strategy Discovery Bot Standalone
```bash
npm start
```
