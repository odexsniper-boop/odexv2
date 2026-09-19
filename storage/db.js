import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../config.js';
import { supabaseManager } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'bot.db');

class DatabaseManager {
  constructor() {
    this.db = null;
    this.connected = false;
    this.init();
  }

  init() {
    try {
      this.db = new DatabaseSync(DB_FILE);
      
      // Performance PRAGMAs: Write-Ahead Logging for high concurrency & speed
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');

      this._createTables();
      this.connected = true;
      log(`[DATABASE] Connected to SQLite database: ${path.resolve(DB_FILE)} (Status: READY)`);

      this._seedInitialData();

      // Check if custom supabase config is persisted
      const sbConfig = this.getSetting('supabase_config', null);
      if (sbConfig && sbConfig.url && sbConfig.key) {
        supabaseManager.init(sbConfig.url, sbConfig.key);
      }
    } catch (err) {
      log(`[DATABASE ERROR] Failed to connect to SQLite: ${err.message}`);
      this.connected = false;
    }
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        entry_price_sol REAL,
        exit_price_sol REAL,
        initial_sol REAL,
        pnl_sol REAL,
        pnl_percent REAL,
        exit_reason TEXT,
        opened_at TEXT,
        closed_at TEXT,
        raw_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS positions (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        creator TEXT,
        entry_price_sol REAL,
        current_price_sol REAL,
        peak_price_sol REAL,
        initial_sol_spent REAL,
        unrealized_pnl_percent REAL,
        status TEXT,
        tokens_held_raw TEXT,
        hit_tiers TEXT,
        updated_at TEXT,
        raw_data TEXT
      );

      CREATE TABLE IF NOT EXISTS tokens_detected (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        pool_address TEXT,
        market_cap REAL,
        liquidity REAL,
        stage TEXT,
        composite_score REAL,
        detected_at TEXT,
        last_updated TEXT,
        raw_data TEXT
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        timestamp INTEGER,
        iso TEXT,
        price_sol REAL,
        market_cap REAL,
        liquidity REAL,
        raw_data TEXT
      );

      CREATE TABLE IF NOT EXISTS smart_learning (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT,
        composite_score REAL,
        dev_holding REAL,
        external_buyers INTEGER,
        pnl_percent REAL,
        outcome TEXT,
        timestamp INTEGER,
        raw_data TEXT
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL COLLATE NOCASE,
        username TEXT,
        password_hash TEXT,
        salt TEXT,
        provider TEXT DEFAULT 'local',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
      CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_mint ON snapshots(mint);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
  }

  /**
   * Automatically seeds existing historical JSON records into SQLite on first initialization
   */
  _seedInitialData() {
    try {
      // 1. Seed trades_state.json if trades table is empty
      const countTrades = this.db.prepare('SELECT COUNT(*) as c FROM trades').get();
      const stateFile = path.join(__dirname, 'trades_state.json');
      if (countTrades.c === 0 && fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const state = JSON.parse(raw);
        if (state.tradeHistory && Array.isArray(state.tradeHistory)) {
          for (const t of state.tradeHistory) {
            this.saveTrade(t);
          }
          log(`[DATABASE] Migrated ${state.tradeHistory.length} historical trades into SQLite`);
        }
      }

      // 2. Seed smart learning state if empty
      const countExp = this.db.prepare('SELECT COUNT(*) as c FROM smart_learning').get();
      const learningFile = path.join(__dirname, 'smart_learning_state.json');
      if (countExp.c === 0 && fs.existsSync(learningFile)) {
        const raw = fs.readFileSync(learningFile, 'utf8');
        const lState = JSON.parse(raw);
        if (lState.experiences && Array.isArray(lState.experiences)) {
          for (const exp of lState.experiences) {
            this.recordLearningExperience(exp);
          }
          log(`[DATABASE] Migrated ${lState.experiences.length} AI learning experiences into SQLite`);
        }
      }

      // 3. Seed default user account if users table is empty
      const countUsers = this.db.prepare('SELECT COUNT(*) as c FROM users').get();
      if (countUsers.c === 0) {
        // trader@solana-sniper.io / password: password123
        const defaultSalt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        const defaultHash = 'bd2a0d77b0b3bb3fb91967ef947b311b65783ebacd8eaaa0b773bee021252e0c186602982b6ef9824ffdac2449f9d5f9bdc892479778e2d6c2c9e748927e4c12';
        this.createUser('trader@solana-sniper.io', 'KO Trader', defaultHash, defaultSalt, 'local');
        log('[DATABASE] Seeded default user account: trader@solana-sniper.io (Password: password123)');
      }
    } catch (err) {
      log(`[DATABASE WARN] Seeding initial data: ${err.message}`);
    }
  }

  saveTrade(trade) {
    if (trade) {
      supabaseManager.saveTrade(trade).catch(() => {});
    }
    if (!this.connected || !this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO trades (
          mint, symbol, name, entry_price_sol, exit_price_sol,
          initial_sol, pnl_sol, pnl_percent, exit_reason,
          opened_at, closed_at, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        trade.mint || '',
        trade.symbol || '',
        trade.name || '',
        Number(trade.entryPriceSol || trade.entry_price_sol || 0),
        Number(trade.exitPriceSol || trade.exit_price_sol || 0),
        Number(trade.initialSolSpent || trade.initial_sol || 0),
        Number(trade.pnlSol || trade.pnl_sol || trade.netProfitSol || trade.profitSol || 0),
        Number(trade.pnlPercent || trade.pnl_percent || trade.finalPnlPercent || 0),
        trade.exitReason || trade.exit_reason || trade.reason || '',
        trade.openedAt || trade.opened_at || '',
        trade.closedAt || trade.closed_at || new Date().toISOString(),
        JSON.stringify(trade)
      );
    } catch (e) {
      log(`[DATABASE ERROR] saveTrade: ${e.message}`);
    }
  }

  getTrades(limit = 100) {
    if (!this.connected || !this.db) return [];
    try {
      const rows = this.db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`).all(limit);
      return rows.map(r => {
        try {
          return { ...JSON.parse(r.raw_data), id: r.id };
        } catch {
          return r;
        }
      });
    } catch (e) {
      log(`[DATABASE ERROR] getTrades: ${e.message}`);
      return [];
    }
  }

  savePositions(positionsList) {
    if (positionsList) {
      supabaseManager.savePositions(positionsList).catch(() => {});
    }
    if (!this.connected || !this.db) return;
    try {
      this.db.exec('BEGIN TRANSACTION;');
      this.db.exec('DELETE FROM positions;');
      const stmt = this.db.prepare(`
        INSERT INTO positions (
          mint, symbol, name, creator, entry_price_sol, current_price_sol,
          peak_price_sol, initial_sol_spent, unrealized_pnl_percent,
          status, tokens_held_raw, hit_tiers, updated_at, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of positionsList) {
        stmt.run(
          p.mint,
          p.symbol || '',
          p.name || '',
          p.creator || '',
          Number(p.entryPriceSol || 0),
          Number(p.currentPriceSol || 0),
          Number(p.peakPriceSol || 0),
          Number(p.initialSolSpent || 0),
          Number(p.unrealizedPnlPercent || 0),
          p.status || 'ACTIVE',
          p.tokensHeldRaw || '0',
          JSON.stringify(p.hitTiers || []),
          new Date().toISOString(),
          JSON.stringify(p)
        );
      }
      this.db.exec('COMMIT;');
    } catch (e) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      log(`[DATABASE ERROR] savePositions: ${e.message}`);
    }
  }

  getPositions() {
    if (!this.connected || !this.db) return [];
    try {
      const rows = this.db.prepare('SELECT * FROM positions').all();
      return rows.map(r => {
        try {
          return JSON.parse(r.raw_data);
        } catch {
          return r;
        }
      });
    } catch (e) {
      log(`[DATABASE ERROR] getPositions: ${e.message}`);
      return [];
    }
  }

  saveDetectedToken(token) {
    if (token) {
      supabaseManager.saveDetectedToken(token).catch(() => {});
    }
    if (!this.connected || !this.db || !token?.mint) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO tokens_detected (
          mint, symbol, name, pool_address, market_cap, liquidity,
          stage, composite_score, detected_at, last_updated, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          symbol = excluded.symbol,
          name = excluded.name,
          market_cap = excluded.market_cap,
          liquidity = excluded.liquidity,
          stage = excluded.stage,
          composite_score = excluded.composite_score,
          last_updated = excluded.last_updated,
          raw_data = excluded.raw_data
      `);
      stmt.run(
        token.mint,
        token.symbol || '',
        token.name || '',
        token.poolAddress || '',
        Number(token.marketCapSol || token.marketCap || 0),
        Number(token.liquiditySol || token.liquidity || 0),
        token.state || token.stage || '',
        Number(token.compositeScore || 0),
        token.detectedAt || new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify(token)
      );
    } catch (e) {
      log(`[DATABASE ERROR] saveDetectedToken: ${e.message}`);
    }
  }

  recordSnapshot(mint, snapshotData) {
    if (mint && snapshotData) {
      supabaseManager.recordSnapshot(mint, snapshotData).catch(() => {});
    }
    if (!this.connected || !this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO snapshots (mint, timestamp, iso, price_sol, market_cap, liquidity, raw_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        mint,
        snapshotData.timestamp || Date.now(),
        snapshotData.iso || new Date().toISOString(),
        Number(snapshotData.spotPriceSol || snapshotData.priceSol || 0),
        Number(snapshotData.marketCapSol || 0),
        Number(snapshotData.liquiditySol || 0),
        JSON.stringify(snapshotData)
      );
    } catch (e) {
      // Non-blocking
    }
  }

  recordLearningExperience(exp) {
    if (!this.connected || !this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO smart_learning (
          mint, composite_score, dev_holding, external_buyers,
          pnl_percent, outcome, timestamp, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        exp.mint || '',
        Number(exp.compositeScore || 0),
        Number(exp.devHolding || 0),
        Number(exp.externalBuyers || 0),
        Number(exp.pnlPercent || 0),
        exp.outcome || '',
        exp.timestamp || Date.now(),
        JSON.stringify(exp)
      );
    } catch (e) {
      // Non-blocking
    }
  }

  saveLearningExperience(exp) {
    return this.recordLearningExperience(exp);
  }

  getRecentExperiences(limit = 100) {
    if (!this.connected || !this.db) return [];
    try {
      const rows = this.db.prepare('SELECT raw_data FROM smart_learning ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map(r => {
        try { return JSON.parse(r.raw_data); } catch { return r; }
      });
    } catch {
      return [];
    }
  }

  getSetting(key, defaultValue = null) {
    if (!this.connected || !this.db) return defaultValue;
    try {
      const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  setSetting(key, value) {
    if (key) {
      supabaseManager.setSetting(key, value).catch(() => {});
    }
    if (!this.connected || !this.db) return false;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);
      stmt.run(key, JSON.stringify(value), new Date().toISOString());
      return true;
    } catch (e) {
      log(`[DATABASE ERROR] setSetting: ${e.message}`);
      return false;
    }
  }

  getUserByEmail(email) {
    if (!this.connected || !this.db || !email) return null;
    try {
      const stmt = this.db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)');
      return stmt.get(email.trim()) || null;
    } catch (e) {
      log(`[DATABASE ERROR] getUserByEmail: ${e.message}`);
      return null;
    }
  }

  createUser(email, username, passwordHash, salt, provider = 'local') {
    if (!this.connected || !this.db || !email) return false;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO users (email, username, password_hash, salt, provider, last_login)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        email.trim().toLowerCase(),
        username || email.split('@')[0],
        passwordHash || '',
        salt || '',
        provider,
        new Date().toISOString()
      );
      return true;
    } catch (e) {
      log(`[DATABASE ERROR] createUser: ${e.message}`);
      return false;
    }
  }

  updateUserPassword(email, passwordHash, salt) {
    if (!this.connected || !this.db || !email) return false;
    try {
      this.db.prepare(`
        UPDATE users SET password_hash = ?, salt = ? WHERE LOWER(email) = LOWER(?)
      `).run(passwordHash, salt, email.trim());
      return true;
    } catch (e) {
      log(`[DATABASE ERROR] updateUserPassword: ${e.message}`);
      return false;
    }
  }

  updateUserLogin(email) {
    if (!this.connected || !this.db || !email) return;
    try {
      this.db.prepare('UPDATE users SET last_login = ? WHERE LOWER(email) = LOWER(?)')
        .run(new Date().toISOString(), email.trim());
    } catch (e) {
      // Non-blocking
    }
  }

  getAllUsers() {
    if (!this.connected || !this.db) return [];
    try {
      return this.db.prepare('SELECT id, email, username, provider, created_at, last_login FROM users').all();
    } catch (e) {
      return [];
    }
  }

  getStats() {
    if (!this.connected || !this.db) {
      return { status: 'DISCONNECTED' };
    }
    try {
      const tradesCount = this.db.prepare('SELECT COUNT(*) as count FROM trades').get()?.count || 0;
      const positionsCount = this.db.prepare('SELECT COUNT(*) as count FROM positions').get()?.count || 0;
      const tokensCount = this.db.prepare('SELECT COUNT(*) as count FROM tokens_detected').get()?.count || 0;
      const snapshotsCount = this.db.prepare('SELECT COUNT(*) as count FROM snapshots').get()?.count || 0;
      const learningCount = this.db.prepare('SELECT COUNT(*) as count FROM smart_learning').get()?.count || 0;
      return {
        status: 'CONNECTED',
        databaseFile: DB_FILE,
        tradesCount,
        positionsCount,
        tokensCount,
        snapshotsCount,
        learningCount,
        supabase: supabaseManager.getStatus(),
      };
    } catch (e) {
      return { status: 'CONNECTED', error: e.message, supabase: supabaseManager.getStatus() };
    }
  }
}

export const dbManager = new DatabaseManager();
export const initDatabase = () => dbManager;
export { supabaseManager };
