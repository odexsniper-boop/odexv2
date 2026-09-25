import { createClient } from '@supabase/supabase-js';
import { log } from '../config.js';

function safeClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Set) return Array.from(v);
      if (v instanceof Map) return Object.fromEntries(v);
      return v;
    }));
  } catch {
    return {};
  }
}

class SupabaseManager {
  constructor() {
    this.client = null;
    this.url = process.env.SUPABASE_URL || '';
    this.key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    this.connected = false;
    this.lastSync = null;
    this.lastError = null;
    this.init();
  }

  init(customUrl = null, customKey = null) {
    if (customUrl !== null && customUrl !== undefined) this.url = customUrl;
    if (customKey !== null && customKey !== undefined) this.key = customKey;

    if (!this.url || !this.key) {
      this.connected = false;
      this.client = null;
      log('[SUPABASE] Operating in local SQLite mode (Supabase ready upon config).');
      return false;
    }

    try {
      this.client = createClient(this.url, this.key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
      this.connected = true;
      this.lastError = null;
      log(`[SUPABASE] Initialized client for ${this.url.replace(/(https?:\/\/)([^.]+).*/, '$1$2...')} (Status: READY)`);
      return true;
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      log(`[SUPABASE ERROR] Initialization failed: ${err.message}`);
      return false;
    }
  }

  updateCredentials(url, key) {
    return this.init(url, key);
  }

  /**
   * Save or update closed trade record to Supabase
   */
  async saveTrade(trade) {
    if (!this.connected || !this.client || !trade?.mint) return;
    try {
      const payload = {
        mint: trade.mint || '',
        symbol: trade.symbol || '',
        name: trade.name || '',
        entry_price_sol: Number(trade.entryPriceSol || trade.entry_price_sol || 0),
        exit_price_sol: Number(trade.exitPriceSol || trade.exit_price_sol || 0),
        initial_sol: Number(trade.initialSolSpent || trade.initial_sol || 0),
        pnl_sol: Number(trade.pnlSol || trade.pnl_sol || 0),
        pnl_percent: Number(trade.pnlPercent || trade.pnl_percent || 0),
        exit_reason: trade.exitReason || trade.exit_reason || trade.reason || '',
        opened_at: trade.openedAt || trade.opened_at || null,
        closed_at: trade.closedAt || trade.closed_at || new Date().toISOString(),
        raw_data: safeClone(trade),
      };

      const { error } = await this.client
        .from('trades')
        .insert(payload);

      if (error) {
        log(`[SUPABASE WARN] saveTrade error: ${error.message}`);
        this.lastError = error.message;
      } else {
        this.lastSync = new Date().toISOString();
      }
    } catch (err) {
      this.lastError = err.message;
      log(`[SUPABASE ERROR] saveTrade exception: ${err.message}`);
    }
  }

  /**
   * Save active positions to Supabase
   */
  async savePositions(positionsList) {
    if (!this.connected || !this.client || !Array.isArray(positionsList)) return;
    try {
      if (positionsList.length === 0) {
        // Clear positions if empty
        await this.client.from('positions').delete().neq('mint', '');
        return;
      }

      const rows = positionsList.map(p => ({
        mint: p.mint,
        symbol: p.symbol || '',
        name: p.name || '',
        creator: p.creator || '',
        entry_price_sol: Number(p.entryPriceSol || 0),
        current_price_sol: Number(p.currentPriceSol || 0),
        peak_price_sol: Number(p.peakPriceSol || 0),
        initial_sol_spent: Number(p.initialSolSpent || 0),
        unrealized_pnl_percent: Number(p.unrealizedPnlPercent || 0),
        status: p.status || 'ACTIVE',
        tokens_held_raw: p.tokensHeldRaw ? String(p.tokensHeldRaw) : '0',
        hit_tiers: p.hitTiers || [],
        updated_at: new Date().toISOString(),
        raw_data: safeClone(p),
      }));

      const { error } = await this.client
        .from('positions')
        .upsert(rows, { onConflict: 'mint' });

      if (error) {
        log(`[SUPABASE WARN] savePositions error: ${error.message}`);
        this.lastError = error.message;
      } else {
        this.lastSync = new Date().toISOString();
      }
    } catch (err) {
      this.lastError = err.message;
      log(`[SUPABASE ERROR] savePositions exception: ${err.message}`);
    }
  }

  /**
   * Save or update detected token record
   */
  async saveDetectedToken(token) {
    if (!this.connected || !this.client || !token?.mint) return;
    try {
      const payload = {
        mint: token.mint,
        symbol: token.symbol || '',
        name: token.name || '',
        pool_address: token.poolAddress || '',
        market_cap: Number(token.marketCapSol || token.marketCap || 0),
        liquidity: Number(token.liquiditySol || token.liquidity || 0),
        stage: token.state || token.stage || '',
        composite_score: Number(token.compositeScore || 0),
        detected_at: token.detectedAt || new Date().toISOString(),
        last_updated: new Date().toISOString(),
        raw_data: safeClone(token),
      };

      const { error } = await this.client
        .from('tokens_detected')
        .upsert(payload, { onConflict: 'mint' });

      if (error) {
        // Non-blocking log
        this.lastError = error.message;
      } else {
        this.lastSync = new Date().toISOString();
      }
    } catch (err) {
      this.lastError = err.message;
    }
  }

  /**
   * Save telemetry snapshot
   */
  async recordSnapshot(mint, snapshotData) {
    if (!this.connected || !this.client || !mint) return;
    try {
      const payload = {
        mint,
        timestamp: snapshotData.timestamp || Date.now(),
        iso: snapshotData.iso || new Date().toISOString(),
        price_sol: Number(snapshotData.spotPriceSol || snapshotData.priceSol || 0),
        market_cap: Number(snapshotData.marketCapSol || 0),
        liquidity: Number(snapshotData.liquiditySol || 0),
        raw_data: safeClone(snapshotData),
      };

      await this.client.from('snapshots').insert(payload);
    } catch {
      // Non-blocking
    }
  }

  /**
   * Save system setting
   */
  async setSetting(key, value) {
    if (!this.connected || !this.client || !key) return;
    try {
      const payload = {
        key,
        value,
        updated_at: new Date().toISOString(),
      };
      await this.client.from('system_settings').upsert(payload, { onConflict: 'key' });
    } catch (err) {
      log(`[SUPABASE WARN] setSetting: ${err.message}`);
    }
  }

  /**
   * Get trade history from Supabase
   */
  async getTrades(limit = 100) {
    if (!this.connected || !this.client) return [];
    try {
      const { data, error } = await this.client
        .from('trades')
        .select('*')
        .order('id', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []).map(r => r.raw_data || r);
    } catch (err) {
      log(`[SUPABASE ERROR] getTrades: ${err.message}`);
      return [];
    }
  }

  /**
   * Full synchronization of local SQLite records to Supabase
   */
  async syncAllFromLocal(dbManager) {
    if (!this.connected || !this.client || !dbManager) {
      return { success: false, reason: 'Supabase not connected or dbManager unavailable' };
    }

    try {
      let syncedTrades = 0;
      let syncedPositions = 0;
      let syncedTokens = 0;

      // 1. Sync Trades
      const trades = dbManager.getTrades(200);
      if (trades && trades.length > 0) {
        for (const t of trades) {
          await this.saveTrade(t);
          syncedTrades++;
        }
      }

      // 2. Sync Positions
      const positions = dbManager.getPositions();
      if (positions && positions.length > 0) {
        await this.savePositions(positions);
        syncedPositions = positions.length;
      }

      this.lastSync = new Date().toISOString();
      return {
        success: true,
        syncedTrades,
        syncedPositions,
        syncedTokens,
        timestamp: this.lastSync,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * ============================================================================
   * MULTI-USER SUPABASE EXTENSIONS (Additive & Backward-Compatible)
   * ============================================================================
   */

  /**
   * Validates Supabase JWT token and extracts user details
   */
  async verifyUserToken(token) {
    if (!this.connected || !this.client || !token) return null;
    try {
      const { data: { user }, error } = await this.client.auth.getUser(token);
      if (error || !user) return null;
      return user;
    } catch {
      return null;
    }
  }

  /**
   * Fetch profile for specific authenticated user
   */
  async getUserProfile(userId) {
    if (!this.connected || !this.client || !userId) return null;
    try {
      const { data, error } = await this.client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      log(`[SUPABASE WARN] getUserProfile: ${err.message}`);
      return null;
    }
  }

  /**
   * Save or update user profile
   */
  async saveUserProfile(userId, profileData) {
    if (!this.connected || !this.client || !userId) return false;
    try {
      const payload = {
        id: userId,
        ...profileData,
        updated_at: new Date().toISOString()
      };
      const { error } = await this.client
        .from('profiles')
        .upsert(payload, { onConflict: 'id' });
      return !error;
    } catch (err) {
      log(`[SUPABASE ERROR] saveUserProfile: ${err.message}`);
      return false;
    }
  }

  /**
   * Fetch user-specific trading settings
   */
  async getUserSettings(userId) {
    if (!this.connected || !this.client || !userId) return null;
    try {
      const { data, error } = await this.client
        .from('user_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (err) {
      log(`[SUPABASE WARN] getUserSettings: ${err.message}`);
      return null;
    }
  }

  /**
   * Save user-specific trading settings
   */
  async saveUserSettings(userId, settings) {
    if (!this.connected || !this.client || !userId) return false;
    try {
      const payload = {
        user_id: userId,
        buy_size_sol: Number(settings.buySizeSol ?? settings.buy_size_sol ?? 0.1),
        slippage_percent: Number(settings.slippagePercent ?? settings.slippage_percent ?? 15),
        slippage_bps: Number(settings.slippageBps ?? settings.slippage_bps ?? 1500),
        priority_fee_sol: Number(settings.priorityFeeSol ?? settings.priority_fee_sol ?? 0.001),
        priority_fee_micro_lamports: Number(settings.priorityFeeMicroLamports ?? settings.priority_fee_micro_lamports ?? 8333),
        gas_tip_sol: Number(settings.gasTipSol ?? settings.gas_tip_sol ?? 0.01),
        jito_tip_lamports: Number(settings.jitoTipLamports ?? settings.jito_tip_lamports ?? 10000000),
        auto_buy_enabled: Boolean(settings.autoBuyEnabled ?? settings.auto_buy_enabled ?? false),
        learning_enabled: Boolean(settings.learningEnabled ?? settings.learning_enabled ?? true),
        trading_mode: settings.tradingMode ?? settings.trading_mode ?? 'PAPER',
        updated_at: new Date().toISOString()
      };
      const { error } = await this.client
        .from('user_settings')
        .upsert(payload, { onConflict: 'user_id' });
      return !error;
    } catch (err) {
      log(`[SUPABASE ERROR] saveUserSettings: ${err.message}`);
      return false;
    }
  }

  /**
   * Get user wallets
   */
  async getUserWallets(userId) {
    if (!this.connected || !this.client || !userId) return [];
    try {
      const { data, error } = await this.client
        .from('user_wallets')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (err) {
      log(`[SUPABASE WARN] getUserWallets: ${err.message}`);
      return [];
    }
  }

  /**
   * Save user wallet
   */
  async saveUserWallet(userId, wallet) {
    if (!this.connected || !this.client || !userId || !wallet?.publicKey) return false;
    try {
      const payload = {
        user_id: userId,
        public_key: wallet.publicKey,
        encrypted_secret: wallet.encryptedSecret || wallet.privateKey || '',
        label: wallet.label || 'Trading Wallet',
        is_active: wallet.isActive !== false,
        updated_at: new Date().toISOString()
      };
      const { error } = await this.client
        .from('user_wallets')
        .insert(payload);
      return !error;
    } catch (err) {
      log(`[SUPABASE ERROR] saveUserWallet: ${err.message}`);
      return false;
    }
  }

  /**
   * Get user positions
   */
  async getUserPositions(userId) {
    if (!this.connected || !this.client || !userId) return [];
    try {
      const { data, error } = await this.client
        .from('user_positions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'ACTIVE');
      if (error) throw error;
      return (data || []).map(r => r.raw_data || r);
    } catch (err) {
      log(`[SUPABASE WARN] getUserPositions: ${err.message}`);
      return [];
    }
  }

  /**
   * Save user positions
   */
  async saveUserPositions(userId, positionsList) {
    if (!this.connected || !this.client || !userId || !Array.isArray(positionsList)) return;
    try {
      if (positionsList.length === 0) {
        await this.client.from('user_positions').delete().eq('user_id', userId);
        return;
      }
      const rows = positionsList.map(p => ({
        user_id: userId,
        mint: p.mint,
        symbol: p.symbol || '',
        name: p.name || '',
        creator: p.creator || '',
        entry_price_sol: Number(p.entryPriceSol || 0),
        current_price_sol: Number(p.currentPriceSol || 0),
        peak_price_sol: Number(p.peakPriceSol || 0),
        initial_sol_spent: Number(p.initialSolSpent || 0),
        unrealized_pnl_percent: Number(p.unrealizedPnlPercent || 0),
        status: p.status || 'ACTIVE',
        tokens_held_raw: p.tokensHeldRaw ? String(p.tokensHeldRaw) : '0',
        hit_tiers: p.hitTiers || [],
        updated_at: new Date().toISOString(),
        raw_data: safeClone(p),
      }));
      await this.client
        .from('user_positions')
        .upsert(rows, { onConflict: 'user_id,mint' });
    } catch (err) {
      log(`[SUPABASE ERROR] saveUserPositions: ${err.message}`);
    }
  }

  /**
   * Get user trades
   */
  async getUserTrades(userId, limit = 100) {
    if (!this.connected || !this.client || !userId) return [];
    try {
      const { data, error } = await this.client
        .from('user_trades')
        .select('*')
        .eq('user_id', userId)
        .order('closed_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(r => r.raw_data || r);
    } catch (err) {
      log(`[SUPABASE WARN] getUserTrades: ${err.message}`);
      return [];
    }
  }

  /**
   * Save user trade
   */
  async saveUserTrade(userId, trade) {
    if (!this.connected || !this.client || !userId || !trade?.mint) return;
    try {
      const payload = {
        user_id: userId,
        mint: trade.mint || '',
        symbol: trade.symbol || '',
        name: trade.name || '',
        entry_price_sol: Number(trade.entryPriceSol || trade.entry_price_sol || 0),
        exit_price_sol: Number(trade.exitPriceSol || trade.exit_price_sol || 0),
        initial_sol: Number(trade.initialSolSpent || trade.initial_sol || 0),
        pnl_sol: Number(trade.pnlSol || trade.pnl_sol || 0),
        pnl_percent: Number(trade.pnlPercent || trade.pnl_percent || 0),
        exit_reason: trade.exitReason || trade.exit_reason || trade.reason || '',
        opened_at: trade.openedAt || trade.opened_at || null,
        closed_at: trade.closedAt || trade.closed_at || new Date().toISOString(),
        raw_data: trade,
      };
      await this.client.from('user_trades').insert(payload);
    } catch (err) {
      log(`[SUPABASE ERROR] saveUserTrade: ${err.message}`);
    }
  }

  /**
   * Get diagnostic status
   */
  getStatus() {
    return {
      enabled: Boolean(this.url && this.key),
      connected: this.connected,
      url: this.url ? this.url.replace(/(https?:\/\/)([^.]+).*/, '$1$2...') : 'NOT_CONFIGURED',
      fullUrl: this.url || '',
      lastSync: this.lastSync,
      lastError: this.lastError,
    };
  }
}

export const supabaseManager = new SupabaseManager();

