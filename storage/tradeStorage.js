import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../config.js';
import { dbManager } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_FILE = path.join(__dirname, 'trades_state.json');

export class TradeStorage {
  static loadState() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
        return JSON.parse(raw);
      }
      // Fallback to database if JSON file is absent
      const positions = dbManager.getPositions();
      const tradeHistory = dbManager.getTrades(100);
      if (positions.length > 0 || tradeHistory.length > 0) {
        return { positions, tradeHistory, vetoCount: 0 };
      }
    } catch (e) {
      log(`[STORAGE WARN] Could not load state: ${e.message}`);
    }
    return { positions: [], tradeHistory: [], vetoCount: 0 };
  }

  static saveState(positionsMap, tradeHistory, vetoCount = 0) {
    try {
      const positions = Array.from(positionsMap.values()).map(p => ({
        ...p,
        tokensHeldRaw: p.tokensHeldRaw ? p.tokensHeldRaw.toString() : '0',
        initialTokensRaw: p.initialTokensRaw ? p.initialTokensRaw.toString() : '0',
        lastKnownVirtualSol: p.lastKnownVirtualSol ? p.lastKnownVirtualSol.toString() : '30000000000',
        lastKnownVirtualTok: p.lastKnownVirtualTok ? p.lastKnownVirtualTok.toString() : '1073000000000000',
        hitTiers: Array.from(p.hitTiers || []),
      }));

      const state = {
        positions,
        tradeHistory: tradeHistory.slice(0, 100),
        vetoCount,
        lastSaved: new Date().toISOString(),
      };

      // 1. Persist to JSON file (preserving complete backward compatibility)
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(state, null, 2), 'utf8');

      // 2. Persist to connected SQLite database
      dbManager.savePositions(positions);
      if (tradeHistory.length > 0) {
        // Save latest trade
        dbManager.saveTrade(tradeHistory[0]);
      }
    } catch (e) {
      log(`[STORAGE ERR] Failed to save state: ${e.message}`);
    }
  }
}
