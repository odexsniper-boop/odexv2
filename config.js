import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env
dotenv.config({ path: path.join(__dirname, '.env') });

export const CONFIG = {
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    ALERT_CHANNEL: process.env.TELEGRAM_ALERT_CHANNEL || '',
  },
  SOLANA: {
    RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
    PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || '',
  },
  SECURITY: {
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '',
  },
  TRADING: {
    USE_RPC_BLAST: true, // Set to false to revert back to Jito MEV protection
  },
  POLLING: {
    SCAN_INTERVAL_MS: 20000,         // Discovery interval (20s)
    TRACK_INTERVAL_MS: 15000,        // Tracking interval per candidate (15s)
    RATE_LIMIT_DELAY_MS: 1800,       // Conservative spacing between GeckoTerminal calls (prevents 429)
    MAX_TRACKED_TOKENS: 15,          // Focus on top 15 highest potential tokens concurrently
  },
  LIFECYCLE_WINDOWS: {
    STATE_0_MAX_AGE_SEC: 30,         // 0 - 30s: Just created
    STATE_1_MAX_AGE_SEC: 180,        // 30s - 3m: Discovery & Velocity
    STATE_2_MAX_AGE_SEC: 600,        // 3m - 10m: Validation & Persistence
    STATE_3_MAX_AGE_SEC: 1800,       // 10m - 30m: Confirmation & Structure
    ABSOLUTE_MAX_AGE_SEC: 2400,      // 40m: Tracker expiry
  },
  HARD_FAILS: {
    MAX_TOP10_CONCENTRATION: 38.0,   // Max Top 10 non-LP concentration %
    MAX_DEV_HOLDING_PERCENT: 12.0,   // Max developer wallet share %
    MAX_SNIPER_BUNDLE_PERCENT: 25.0, // Max initial bundle/sniper cluster %
    MIN_LIQUIDITY_USD: 15000,        // Absolute minimum liquidity
    MIN_LIQ_MC_RATIO: 0.08,          // Minimum 8% liquidity-to-market-cap
    MAX_WASH_TRADE_RATIO: 0.85,      // >85% repeat transactions with tiny unique buyers
  },
  SCORING: {
    WEIGHTS: {
      SAFETY: 0.30,
      MOMENTUM: 0.30,
      SMART_MONEY: 0.20,
      STRUCTURE: 0.20,
    },
    THRESHOLD_ENTRY: 80,             // Score required for 🟢 ENTRY WINDOW alert
    THRESHOLD_WATCH: 68,             // Score required for 🟡 WATCH alert
  },
  DRY_RUN: process.env.DRY_RUN === 'true' || process.env.DRY_RUN === undefined,
};

// Standard logging utility
export function log(...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}
