-- Supabase Database Schema for Solana Sniper Bot
-- Run this in your Supabase project's SQL Editor to set up the backend persistence tables

-- 1. Trades History Table
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL PRIMARY KEY,
    mint TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    entry_price_sol DOUBLE PRECISION,
    exit_price_sol DOUBLE PRECISION,
    initial_sol DOUBLE PRECISION,
    pnl_sol DOUBLE PRECISION,
    pnl_percent DOUBLE PRECISION,
    exit_reason TEXT,
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at DESC);

-- 2. Open Positions Table
CREATE TABLE IF NOT EXISTS positions (
    mint TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    creator TEXT,
    entry_price_sol DOUBLE PRECISION,
    current_price_sol DOUBLE PRECISION,
    peak_price_sol DOUBLE PRECISION,
    initial_sol_spent DOUBLE PRECISION,
    unrealized_pnl_percent DOUBLE PRECISION,
    status TEXT DEFAULT 'ACTIVE',
    tokens_held_raw TEXT,
    hit_tiers JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    raw_data JSONB
);

-- 3. Detected Tokens Table
CREATE TABLE IF NOT EXISTS tokens_detected (
    mint TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    pool_address TEXT,
    market_cap DOUBLE PRECISION,
    liquidity DOUBLE PRECISION,
    stage TEXT,
    composite_score DOUBLE PRECISION,
    detected_at TIMESTAMPTZ,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    raw_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_tokens_detected_score ON tokens_detected(composite_score DESC);

-- 4. Snapshots & Telemetry Table
CREATE TABLE IF NOT EXISTS snapshots (
    id BIGSERIAL PRIMARY KEY,
    mint TEXT NOT NULL,
    timestamp BIGINT,
    iso TIMESTAMPTZ,
    price_sol DOUBLE PRECISION,
    market_cap DOUBLE PRECISION,
    liquidity DOUBLE PRECISION,
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_mint ON snapshots(mint);

-- 5. System & Strategy Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) policies (Optional: Allows service role or public read)
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens_detected ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read-write for trades" ON trades FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read-write for positions" ON positions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read-write for tokens_detected" ON tokens_detected FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read-write for snapshots" ON snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read-write for system_settings" ON system_settings FOR ALL USING (true) WITH CHECK (true);
