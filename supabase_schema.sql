-- ==============================================================================
-- ODEX SOLANA SNIPER BOT - MULTI-USER SUPABASE DATABASE SCHEMA
-- Features: Row Level Security (RLS), Supabase Auth Integration, Multi-Tenancy
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USER PROFILES (Linked to Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username TEXT,
  email TEXT,
  phone TEXT,
  avatar_url TEXT,
  sol_address TEXT,
  two_factor_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now())
);

-- 3. USER TRADING SETTINGS (Isolated per user)
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  buy_size_sol NUMERIC DEFAULT 0.1,
  slippage_percent NUMERIC DEFAULT 15,
  slippage_bps INTEGER DEFAULT 1500,
  priority_fee_sol NUMERIC DEFAULT 0.001,
  priority_fee_micro_lamports BIGINT DEFAULT 8333,
  gas_tip_sol NUMERIC DEFAULT 0.01,
  jito_tip_lamports BIGINT DEFAULT 10000000,
  auto_buy_enabled BOOLEAN DEFAULT FALSE,
  learning_enabled BOOLEAN DEFAULT TRUE,
  trading_mode TEXT DEFAULT 'PAPER', -- 'LIVE' or 'PAPER'
  max_concurrent_positions INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now())
);

-- 4. USER WALLETS (Encrypted or Paper Keypairs per user)
CREATE TABLE IF NOT EXISTS public.user_wallets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  public_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  label TEXT DEFAULT 'Main Trading Wallet',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now())
);

-- 5. USER POSITIONS (Isolated per user)
CREATE TABLE IF NOT EXISTS public.user_positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  creator TEXT,
  entry_price_sol NUMERIC DEFAULT 0,
  current_price_sol NUMERIC DEFAULT 0,
  peak_price_sol NUMERIC DEFAULT 0,
  initial_sol_spent NUMERIC DEFAULT 0,
  unrealized_pnl_percent NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE',
  tokens_held_raw TEXT DEFAULT '0',
  hit_tiers JSONB DEFAULT '[]'::JSONB,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  raw_data JSONB,
  CONSTRAINT uq_user_mint UNIQUE (user_id, mint)
);

-- 6. USER CLOSED TRADES (Isolated trade history per user)
CREATE TABLE IF NOT EXISTS public.user_trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  entry_price_sol NUMERIC DEFAULT 0,
  exit_price_sol NUMERIC DEFAULT 0,
  initial_sol NUMERIC DEFAULT 0,
  pnl_sol NUMERIC DEFAULT 0,
  pnl_percent NUMERIC DEFAULT 0,
  exit_reason TEXT,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now())
);

-- 6b. GLOBAL TRADES (For node & bot cloud persistence)
CREATE TABLE IF NOT EXISTS public.trades (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  entry_price_sol NUMERIC DEFAULT 0,
  exit_price_sol NUMERIC DEFAULT 0,
  initial_sol NUMERIC DEFAULT 0,
  pnl_sol NUMERIC DEFAULT 0,
  pnl_percent NUMERIC DEFAULT 0,
  exit_reason TEXT,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  CONSTRAINT uq_trade_mint_closed UNIQUE (mint, closed_at)
);

-- 6c. GLOBAL ACTIVE POSITIONS
CREATE TABLE IF NOT EXISTS public.positions (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT UNIQUE NOT NULL,
  symbol TEXT,
  name TEXT,
  creator TEXT,
  entry_price_sol NUMERIC DEFAULT 0,
  current_price_sol NUMERIC DEFAULT 0,
  peak_price_sol NUMERIC DEFAULT 0,
  initial_sol_spent NUMERIC DEFAULT 0,
  unrealized_pnl_percent NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE',
  tokens_held_raw TEXT DEFAULT '0',
  hit_tiers JSONB DEFAULT '[]'::JSONB,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  raw_data JSONB
);

-- 7. GLOBAL SHARED MARKET DISCOVERY (Shared by all users)
CREATE TABLE IF NOT EXISTS public.tokens_detected (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  pool_address TEXT,
  market_cap NUMERIC DEFAULT 0,
  liquidity NUMERIC DEFAULT 0,
  stage TEXT,
  composite_score NUMERIC DEFAULT 0,
  detected_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  last_updated TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  raw_data JSONB
);

-- 8. GLOBAL SHARED TELEMETRY SNAPSHOTS
CREATE TABLE IF NOT EXISTS public.snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  timestamp BIGINT,
  iso TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now()),
  price_sol NUMERIC DEFAULT 0,
  market_cap NUMERIC DEFAULT 0,
  liquidity NUMERIC DEFAULT 0,
  raw_data JSONB
);

-- 9. GLOBAL SYSTEM SETTINGS (Admin / Node Configuration)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::TEXT, now())
);

-- ==============================================================================
-- INDEXES FOR MAXIMUM QUERY PERFORMANCE
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_user_wallets_user ON public.user_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_positions_user ON public.user_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_trades_user ON public.user_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_user_trades_mint ON public.user_trades(mint);
CREATE INDEX IF NOT EXISTS idx_snapshots_mint ON public.snapshots(mint);
CREATE INDEX IF NOT EXISTS idx_tokens_detected_stage ON public.tokens_detected(stage);

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ==============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokens_detected ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read trades" ON public.trades FOR SELECT USING (true);
CREATE POLICY "Service can manage trades" ON public.trades FOR ALL USING (true);

CREATE POLICY "Public read positions" ON public.positions FOR SELECT USING (true);
CREATE POLICY "Service can manage positions" ON public.positions FOR ALL USING (true);

-- 1. Profiles: Users can view and modify only their own profile
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can insert/update own profile" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- 2. User Settings: Users can only manage their own trading settings
CREATE POLICY "Users own settings" ON public.user_settings
  FOR ALL USING (auth.uid() = user_id);

-- 3. Wallets: Users can only see and manage their own Solana keys
CREATE POLICY "Users own wallets" ON public.user_wallets
  FOR ALL USING (auth.uid() = user_id);

-- 4. Positions: Users can only see and execute on their own positions
CREATE POLICY "Users own positions" ON public.user_positions
  FOR ALL USING (auth.uid() = user_id);

-- 5. Trades: Users can only see their own trade history
CREATE POLICY "Users own trades" ON public.user_trades
  FOR ALL USING (auth.uid() = user_id);

-- 6. Shared Market Discovery: Any authenticated/anon user can read live pump.fun token stream
CREATE POLICY "Public read tokens_detected" ON public.tokens_detected
  FOR SELECT USING (true);

CREATE POLICY "Service can insert tokens_detected" ON public.tokens_detected
  FOR ALL USING (true);

-- 7. Snapshots: Public read
CREATE POLICY "Public read snapshots" ON public.snapshots
  FOR SELECT USING (true);

CREATE POLICY "Service can insert snapshots" ON public.snapshots
  FOR ALL USING (true);

-- 8. System settings: Service / admin read
CREATE POLICY "Public read system settings" ON public.system_settings
  FOR SELECT USING (true);

-- ==============================================================================
-- AUTOMATIC PROFILE & DEFAULT SETTINGS TRIGGER ON AUTH SIGN-UP
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert profile
  INSERT INTO public.profiles (id, email, username)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;

  -- Insert default user trading settings
  INSERT INTO public.user_settings (user_id, buy_size_sol, slippage_percent, auto_buy_enabled, trading_mode)
  VALUES (NEW.id, 0.1, 15, FALSE, 'PAPER')
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to execute upon auth.users insert
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
