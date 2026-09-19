import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../config.js';
import { eventBus } from '../eventBus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEARNING_STATE_FILE = path.join(__dirname, '../storage/smart_learning_state.json');

/**
 * Smart Learning Agent (Adaptive Reinforcement & Experience-Based Funnel)
 * Continuously evaluates closed trade performance to refine entry conviction,
 * dev safety caps, and buyer thresholds to actively enhance overall win rate.
 * Can be toggled ON (Adaptive Learning) or OFF (Fixed Static Rules).
 */
export class SmartAgent {
  constructor(options = {}) {
    this.learningEnabled = options.learningEnabled ?? true;

    // Baseline configuration
    this.baseMinCompositeScore = options.minCompositeScore || 70;
    this.baseMaxDevHolding = 8.0;
    this.baseMinExternalBuyers = 2;

    // Dynamically tuned criteria (adaptive)
    this.effectiveMinCompositeScore = this.baseMinCompositeScore;
    this.effectiveMaxDevHolding = this.baseMaxDevHolding;
    this.effectiveMinExternalBuyers = this.baseMinExternalBuyers;

    // Experience memory
    this.experiences = [];
    this.totalLearnedTrades = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.recentWinRate = 0;
    this.adaptationsCount = 0;

    this.loadLearningState();
  }

  /**
   * Loads persisted learning state from storage
   */
  loadLearningState() {
    try {
      if (fs.existsSync(LEARNING_STATE_FILE)) {
        const raw = fs.readFileSync(LEARNING_STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data) {
          if (data.learningEnabled !== undefined) this.learningEnabled = data.learningEnabled;
          if (Array.isArray(data.experiences)) this.experiences = data.experiences;
          if (data.totalLearnedTrades !== undefined) this.totalLearnedTrades = data.totalLearnedTrades;
          if (data.totalWins !== undefined) this.totalWins = data.totalWins;
          if (data.totalLosses !== undefined) this.totalLosses = data.totalLosses;
          if (data.recentWinRate !== undefined) this.recentWinRate = data.recentWinRate;
          if (data.adaptationsCount !== undefined) this.adaptationsCount = data.adaptationsCount;
          if (data.effectiveMinCompositeScore !== undefined) this.effectiveMinCompositeScore = data.effectiveMinCompositeScore;
          if (data.effectiveMaxDevHolding !== undefined) this.effectiveMaxDevHolding = data.effectiveMaxDevHolding;
          if (data.effectiveMinExternalBuyers !== undefined) this.effectiveMinExternalBuyers = data.effectiveMinExternalBuyers;
          log(`[AI LEARNER] Loaded knowledge base: ${this.experiences.length} experiences, Win Rate: ${this.recentWinRate}%, Adaptive Min Score: ${this.effectiveMinCompositeScore}`);
        }
      }
    } catch (e) {
      log(`[AI LEARNER WARN] Could not load state: ${e.message}`);
    }
  }

  /**
   * Persists learning state to storage
   */
  saveLearningState() {
    try {
      const data = {
        learningEnabled: this.learningEnabled,
        effectiveMinCompositeScore: this.effectiveMinCompositeScore,
        effectiveMaxDevHolding: this.effectiveMaxDevHolding,
        effectiveMinExternalBuyers: this.effectiveMinExternalBuyers,
        totalLearnedTrades: this.totalLearnedTrades,
        totalWins: this.totalWins,
        totalLosses: this.totalLosses,
        recentWinRate: this.recentWinRate,
        adaptationsCount: this.adaptationsCount,
        experiences: this.experiences.slice(-100),
        lastUpdated: new Date().toISOString(),
      };
      fs.writeFileSync(LEARNING_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      log(`[AI LEARNER ERR] Failed to save state: ${e.message}`);
    }
  }

  /**
   * Toggles adaptive learning on or off
   */
  setLearning(enabled) {
    this.learningEnabled = !!enabled;
    if (!this.learningEnabled) {
      // Revert to fixed baseline rules
      this.effectiveMinCompositeScore = this.baseMinCompositeScore;
      this.effectiveMaxDevHolding = this.baseMaxDevHolding;
      this.effectiveMinExternalBuyers = this.baseMinExternalBuyers;
      log(`[AI LEARNER] Adaptive Learning DISABLED. Reverted to baseline static rules.`);
    } else {
      this.recalculateParameters();
      log(`[AI LEARNER] Adaptive Learning ENABLED. Optimal parameters active.`);
    }
    this.saveLearningState();
    eventBus.emit('LEARNING_STATUS_UPDATED', this.getMetrics());
    return this.learningEnabled;
  }

  /**
   * Continuous online learning from closed trades
   */
  learnFromTrade(tradeRecord) {
    const pnl = Number(tradeRecord.finalPnlPercent || 0);
    const isWin = pnl >= 0;

    const experience = {
      mint: tradeRecord.mint,
      name: tradeRecord.name,
      pnl,
      isWin,
      reason: tradeRecord.reason || 'UNKNOWN',
      devPercent: Number(tradeRecord.devPercent || 0),
      bundleCount: Number(tradeRecord.bundleCount || tradeRecord.bundledBuysCount || 0),
      entryScore: Number(tradeRecord.entryScore || 0),
      timestamp: Date.now(),
    };

    this.experiences.push(experience);
    this.totalLearnedTrades++;
    if (isWin) this.totalWins++;
    else this.totalLosses++;

    if (this.learningEnabled) {
      this.recalculateParameters(experience);
    } else {
      this.saveLearningState();
    }
  }

  /**
   * Recalculates adaptive rules based on historical win/loss telemetry
   */
  recalculateParameters(recentExperience = null) {
    if (this.experiences.length === 0) return;

    // Focus on recent rolling window (last 15-20 trades)
    const recent = this.experiences.slice(-20);
    const wins = recent.filter(e => e.isWin).length;
    this.recentWinRate = Math.round((wins / recent.length) * 100);

    // 1. Conviction Threshold Optimization
    if (this.recentWinRate < 55) {
      // Underperforming: tighten selectivity strictly to only take premier setups
      this.effectiveMinCompositeScore = Math.min(84, this.baseMinCompositeScore + 10);
    } else if (this.recentWinRate < 70) {
      // Moderate win rate: apply medium selectivity cushion
      this.effectiveMinCompositeScore = Math.min(78, this.baseMinCompositeScore + 5);
    } else {
      // High win rate (>= 70%): allow optimal capture
      this.effectiveMinCompositeScore = this.baseMinCompositeScore;
    }

    // 2. Dev Allocation Analysis (Identify Rug/Dump Vulnerabilities)
    const lossTrades = recent.filter(e => !e.isWin);
    if (lossTrades.length >= 3) {
      const avgDevInLosses = lossTrades.reduce((acc, t) => acc + t.devPercent, 0) / lossTrades.length;
      if (avgDevInLosses > 4.0) {
        // High dev holdings correlated with losses: tighten dev ceiling
        this.effectiveMaxDevHolding = Math.max(4.0, 6.0);
      } else {
        this.effectiveMaxDevHolding = this.baseMaxDevHolding;
      }
    }

    // 3. Buyer Velocity Requirements
    const lowBuyerLosses = lossTrades.filter(t => t.bundleCount <= 2).length;
    if (lowBuyerLosses >= 2 && lossTrades.length >= 3) {
      // Require at least 3 initial bundled buyers to confirm momentum
      this.effectiveMinExternalBuyers = 3;
    } else {
      this.effectiveMinExternalBuyers = this.baseMinExternalBuyers;
    }

    this.adaptationsCount++;
    this.saveLearningState();

    if (recentExperience) {
      log(`🧠 [AI LEARNER] Trade analyzed: ${recentExperience.isWin ? 'WIN (+' : 'LOSS ('}${recentExperience.pnl.toFixed(1)}%) on ${recentExperience.name || recentExperience.mint.slice(0, 8)} | Win Rate: ${this.recentWinRate}% | Adaptive Threshold: Score >= ${this.effectiveMinCompositeScore}, Max Dev <= ${this.effectiveMaxDevHolding.toFixed(1)}%, Min Buyers >= ${this.effectiveMinExternalBuyers}`);
    }

    eventBus.emit('LEARNING_STATUS_UPDATED', this.getMetrics());
  }

  /**
   * System A Gatekeeper: Multi-factor assessment with AI Learning Enhancements
   * @param {Object} tokenInfo
   * @returns {{ shouldTrade: boolean, score: number, reason: string, telemetry: Object }}
   */
  evaluateEntry(tokenInfo) {
    const maxDev = this.learningEnabled ? this.effectiveMaxDevHolding : this.baseMaxDevHolding;
    const minBuyers = this.learningEnabled ? this.effectiveMinExternalBuyers : this.baseMinExternalBuyers;
    const minScore = this.learningEnabled ? this.effectiveMinCompositeScore : this.baseMinCompositeScore;

    const telemetry = {
      devPercent: tokenInfo.devPercent || 0,
      bundleCount: tokenInfo.bundledBuysCount || 0,
      hasBuyers: (tokenInfo.bundledBuysCount >= minBuyers),
      learningActive: this.learningEnabled,
      timestamp: Date.now(),
    };

    // 1. HARD VETO: Dev over-concentration
    if (telemetry.devPercent > maxDev) {
      // Contextual Override: If Dev hasn't sold anything and organic volume/buyers are exceptional
      const isExceptionalOrganic = (tokenInfo.buyVolumeSol >= 3.0 && tokenInfo.uniqueBuyersCount >= 15);
      const devIsSafe = (tokenInfo.devSoldAny === false);
      
      if (isExceptionalOrganic && devIsSafe && telemetry.devPercent <= 15) {
        // Allowed to bypass if dev holding is < 15% and behavior is perfect
        telemetry.devBypassActive = true;
      } else {
        return {
          shouldTrade: false,
          score: 0,
          reason: `DEV_OVERCONCENTRATED (${telemetry.devPercent.toFixed(1)}% > ${maxDev.toFixed(1)}%)`,
          telemetry,
        };
      }
    }

    // 2. HARD VETO: Insufficient buyer velocity
    if (telemetry.bundleCount < minBuyers) {
      return {
        shouldTrade: false,
        score: 25,
        reason: `INSUFFICIENT_BUYERS (${telemetry.bundleCount} < ${minBuyers})`,
        telemetry,
      };
    }

    // 3. SCORING FUNNEL (Starts at 40, must hit required score)
    let score = 40;

    // Clean dev allocation (Max +30 pts)
    if (telemetry.devPercent <= 1.0) score += 30;
    else if (telemetry.devPercent <= 3.0) score += 20;
    else if (telemetry.devPercent <= 6.0) score += 10;

    // Volume / Buyer velocity (Max +30 pts)
    if (telemetry.bundleCount >= 4) score += 30;
    else if (telemetry.bundleCount >= 2) score += 20;

    // 4. AI Experience-Based Conviction Boost / Penalty (When Learning Enabled)
    if (this.learningEnabled && this.experiences.length >= 3) {
      // Reward pristine launches that mirror past winners
      if (telemetry.devPercent <= 2.0 && telemetry.bundleCount >= 4) {
        score += 10; // AI High-Probability Pattern Bonus
      } else if (telemetry.devPercent >= 5.0 && telemetry.bundleCount <= 2) {
        score -= 15; // AI High-Risk Trap Penalty
      }
    }

    const shouldTrade = score >= minScore;
    const reason = shouldTrade ? 'HIGH_CONVICTION_ENTRY' : `SCORE_BELOW_THRESHOLD (${score}/${minScore})`;

    return {
      shouldTrade,
      score,
      reason,
      telemetry,
    };
  }

  /**
   * System B Supervisor: Monitors open position health
   */
  evaluateHolding(position, marketTick) {
    const currentPrice = marketTick.currentPriceSol;
    const entryPrice = position.entryPriceSol;
    const peakPrice = position.peakPriceSol || entryPrice;

    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const dropFromPeak = ((currentPrice - peakPrice) / peakPrice) * 100;

    if (pnlPercent <= -28) return 'STOP_LOSS';
    if (pnlPercent >= 25 && dropFromPeak <= -15) return 'TAKE_PROFIT';
    if (pnlPercent >= 35 && (!position.hitTiers || !position.hitTiers.has(0))) return 'SCALE_OUT';
    if (pnlPercent >= 100) return 'TAKE_PROFIT';

    return 'HOLD';
  }

  /**
   * Current learning metrics for UI and API
   */
  getMetrics() {
    return {
      learningEnabled: this.learningEnabled,
      effectiveMinScore: this.effectiveMinCompositeScore,
      effectiveMaxDev: this.effectiveMaxDevHolding,
      effectiveMinBuyers: this.effectiveMinExternalBuyers,
      totalLearnedTrades: this.totalLearnedTrades,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      recentWinRate: this.recentWinRate,
      adaptationsCount: this.adaptationsCount,
    };
  }
}
