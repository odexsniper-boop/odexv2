import { CONFIG, log } from '../config.js';
import { eventBus } from '../eventBus.js';

export class HardSafetyFilter {
  constructor(options = {}) {
    this.maxDevPercent = options.maxDevPercent || 10.0; // Max 10% dev allocation
    this.maxBundlePercent = options.maxBundlePercent || 20.0; // Max 20% bundled buys
    this.maxBundleWallets = options.maxBundleWallets || 3; // Max 3 coordinated wallets
  }

  /**
   * Fast In-Memory Hard Gate: Evaluates whether a token is safe to enter (<5ms)
   * @param {Object} tokenInfo
   * @returns {{ pass: boolean, reason: string, metrics: Object }}
   */
  evaluate(tokenInfo) {
    const metrics = {
      devPercent: tokenInfo.devPercent || 0,
      bundlePercent: tokenInfo.bundlePercent || 0,
      bundledBuysCount: tokenInfo.bundledBuysCount || 0,
      creator: tokenInfo.creator || 'UNKNOWN',
      isKnownRugger: !!tokenInfo.isKnownRugger,
    };

    // 0. Rugger Blacklist Check (Past rug history)
    if (metrics.isKnownRugger) {
      const verdict = {
        pass: false,
        reason: `CREATOR_FLAGGED_RUGGER (${metrics.creator.slice(0, 8)}... has history of rug dumps)`,
        metrics,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 1. Dev Allocation Check
    if (metrics.devPercent > this.maxDevPercent) {
      const verdict = {
        pass: false,
        reason: `DEV_OVERALLOCATED (${metrics.devPercent.toFixed(1)}% > ${this.maxDevPercent}%)`,
        metrics,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 2. Coordinated Bundle Check (same-slot sniper clusters)
    if (metrics.bundledBuysCount > this.maxBundleWallets) {
      const verdict = {
        pass: false,
        reason: `HIGH_BUNDLE_RISK (${metrics.bundledBuysCount} wallets in launch slot)`,
        metrics,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 3. Bundled supply concentration
    if (metrics.bundlePercent > this.maxBundlePercent) {
      const verdict = {
        pass: false,
        reason: `BUNDLE_SUPPLY_HIGH (${metrics.bundlePercent.toFixed(1)}% > ${this.maxBundlePercent}%)`,
        metrics,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // Passed all hard gates
    const verdict = {
      pass: true,
      reason: 'CLEAN_LAUNCH_PASSED',
      metrics,
    };
    eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
    return verdict;
  }
}

export function evaluateHardFails(audit) {
  const hardFailTriggers = [];
  if (audit.mintDisabled === false) hardFailTriggers.push('MINT_AUTHORITY_ENABLED');
  if (audit.freezeDisabled === false) hardFailTriggers.push('FREEZE_AUTHORITY_ENABLED');
  if (audit.devPercent > 8.0) hardFailTriggers.push(`DEV_HOLDING_HIGH_${audit.devPercent}%`);
  if (audit.bundlePercent > 20.0) hardFailTriggers.push(`BUNDLE_HIGH_${audit.bundlePercent}%`);
  if (audit.top10Percent > 40.0) hardFailTriggers.push(`TOP_HOLDERS_CONCENTRATED_${audit.top10Percent}%`);
  if (audit.liquidity < 10000) hardFailTriggers.push('INSUFFICIENT_LIQUIDITY');
  if (audit.liqRatio < 0.05) hardFailTriggers.push('LOW_LIQUIDITY_RATIO');
  if (audit.washTradingRisk === 'HIGH') hardFailTriggers.push('WASH_TRADING_HIGH');
  return {
    passed: hardFailTriggers.length === 0,
    hardFailTriggers,
  };
}

export function calculateSafetyScore(audit) {
  let score = 100;
  if (audit.devPercent > 5) score -= 20;
  else if (audit.devPercent > 2) score -= 10;
  if (audit.bundlePercent > 10) score -= 20;
  if (audit.top10Percent > 25) score -= 20;
  if (audit.washTradingRisk === 'MEDIUM') score -= 15;
  if (audit.washTradingRisk === 'HIGH') score -= 40;
  return Math.max(0, Math.min(100, score));
}
