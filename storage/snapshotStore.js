import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../config.js';
import { dbManager } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SNAPSHOT_LOG_PATH = path.join(DATA_DIR, 'snapshots.jsonl');
const OUTCOMES_LOG_PATH = path.join(DATA_DIR, 'outcomes.jsonl');

/**
 * In-memory buffer of time-series snapshots per token mint
 * Map<mint, Array<Snapshot>>
 */
class SnapshotStore {
  constructor() {
    this.memoryStore = new Map();
  }

  /**
   * Records a point-in-time state snapshot
   * @param {string} mint - Token mint address
   * @param {object} snapshotData - Market metrics, holders, volumes, scores
   */
  record(mint, snapshotData) {
    const timestamp = Date.now();
    const entry = {
      timestamp,
      iso: new Date(timestamp).toISOString(),
      ...snapshotData,
    };

    if (!this.memoryStore.has(mint)) {
      this.memoryStore.set(mint, []);
    }

    const series = this.memoryStore.get(mint);
    series.push(entry);

    // Keep up to 60 snapshots in memory per token (~10-15 mins of high frequency tracking)
    if (series.length > 60) {
      series.shift();
    }

    // Append asynchronously to persistent JSONL log for future ML training
    try {
      fs.appendFile(
        SNAPSHOT_LOG_PATH,
        JSON.stringify({ mint, ...entry }) + '\n',
        (err) => {
          if (err) log('Error appending snapshot:', err.message);
        }
      );
      dbManager.recordSnapshot(mint, entry);
    } catch (e) {
      // Non-blocking log error
    }

    return entry;
  }

  /**
   * Retrieves all recorded snapshots for a given mint
   */
  getHistory(mint) {
    return this.memoryStore.get(mint) || [];
  }

  /**
   * Gets the most recent snapshot for a mint
   */
  getLatest(mint) {
    const series = this.memoryStore.get(mint);
    if (!series || series.length === 0) return null;
    return series[series.length - 1];
  }

  /**
   * Finds the closest snapshot to a specific target age/delta in milliseconds
   */
  getSnapshotAgo(mint, deltaMs) {
    const series = this.memoryStore.get(mint);
    if (!series || series.length < 2) return null;

    const targetTime = Date.now() - deltaMs;
    // Find closest snapshot
    let closest = series[0];
    let minDiff = Math.abs(closest.timestamp - targetTime);

    for (let i = 1; i < series.length; i++) {
      const diff = Math.abs(series[i].timestamp - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = series[i];
      }
    }

    return closest;
  }

  /**
   * Records forward outcome for machine learning dataset (e.g. +50% hit, rugged, etc.)
   */
  recordOutcome(mint, outcome) {
    const entry = {
      mint,
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      ...outcome,
    };

    fs.appendFile(
      OUTCOMES_LOG_PATH,
      JSON.stringify(entry) + '\n',
      (err) => {
        if (err) log('Error logging outcome:', err.message);
      }
    );
    dbManager.recordLearningExperience(entry);
  }

  /**
   * Cleans up token from memory when tracking expires
   */
  delete(mint) {
    this.memoryStore.delete(mint);
  }
}

export const snapshotStore = new SnapshotStore();
