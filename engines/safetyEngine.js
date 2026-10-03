import { CONFIG, log } from '../config.js';
import { eventBus } from '../eventBus.js';

export class HardSafetyFilter {
  constructor(options = {}) {
    this.maxDevPercent = options.maxDevPercent !== undefined ? options.maxDevPercent : 8.0; // Strict 8% default
    this.maxBundlePercent = options.maxBundlePercent !== undefined ? options.maxBundlePercent : 20.0; // Max 20% bundled buys
    this.maxBundleWallets = options.maxBundleWallets !== undefined ? options.maxBundleWallets : 3; // Max 3 coordinated wallets
    this.conservativeAdmission = options.conservativeAdmission !== undefined ? options.conservativeAdmission : true;
    this.allowMissingBundleData = options.allowMissingBundleData !== undefined ? options.allowMissingBundleData : false;
  }

  /**
   * Fast In-Memory Hard Gate: Evaluates whether a token is safe to enter (<5ms)
   * @param {Object} tokenInfo
   * @returns {{ pass: boolean, status: string, reason: string, metrics: Object, timestamp: number }}
   */
  evaluate(tokenInfo = {}) {
    const timestamp = Date.now();
    const metrics = {
      mint: tokenInfo.mint || 'UNKNOWN',
      devPercent: typeof tokenInfo.devPercent === 'number' ? tokenInfo.devPercent : 0,
      bundlePercent: typeof tokenInfo.bundlePercent === 'number' ? tokenInfo.bundlePercent : (tokenInfo.bundlePercent != null ? Number(tokenInfo.bundlePercent) : null),
      bundledBuysCount: typeof tokenInfo.bundledBuysCount === 'number' ? tokenInfo.bundledBuysCount : (tokenInfo.bundledBuysCount != null ? Number(tokenInfo.bundledBuysCount) : null),
      creator: tokenInfo.creator || 'UNKNOWN',
      isKnownRugger: !!tokenInfo.isKnownRugger,
      bundleDataStatus: tokenInfo.bundleDataStatus || (tokenInfo.bundlePercent != null || tokenInfo.bundledBuysCount != null ? 'VERIFIED' : 'INSUFFICIENT_DATA'),
      mintDisabled: tokenInfo.mintDisabled !== undefined ? tokenInfo.mintDisabled : true,
      freezeDisabled: tokenInfo.freezeDisabled !== undefined ? tokenInfo.freezeDisabled : true,
    };

    // 0. Rugger Blacklist Check (Past rug history)
    if (metrics.isKnownRugger) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: `CREATOR_FLAGGED_RUGGER (${metrics.creator.slice(0, 8)}... has history of rug dumps)`,
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 1. Dev Allocation Check
    if (metrics.devPercent > this.maxDevPercent) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: `DEV_OVERALLOCATED (${metrics.devPercent.toFixed(1)}% > ${this.maxDevPercent}%)`,
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 2. Mint/Freeze Authority Check (if explicit audit details provided)
    if (metrics.mintDisabled === false) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: 'MINT_AUTHORITY_ENABLED',
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }
    if (metrics.freezeDisabled === false) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: 'FREEZE_AUTHORITY_ENABLED',
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 3. Bundle Data Availability Check
    if (this.conservativeAdmission && !this.allowMissingBundleData) {
      if (metrics.bundleDataStatus === 'INSUFFICIENT_DATA' || metrics.bundleDataStatus === 'PENDING' || (metrics.bundledBuysCount === null && metrics.bundlePercent === null)) {
        const verdict = {
          pass: false,
          status: 'INSUFFICIENT_DATA',
          reason: `INSUFFICIENT_BUNDLE_DATA: Bundle metrics ${metrics.bundleDataStatus === 'PENDING' ? 'pending verification' : 'unavailable'} under conservative admission`,
          metrics,
          timestamp,
        };
        eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
        return verdict;
      }
    }

    // 4. Coordinated Bundle Check (same-slot sniper clusters)
    const effectiveBundledWallets = metrics.bundledBuysCount || 0;
    if (effectiveBundledWallets > this.maxBundleWallets) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: `HIGH_BUNDLE_RISK (${effectiveBundledWallets} wallets in launch slot > ${this.maxBundleWallets})`,
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // 5. Bundled supply concentration
    const effectiveBundlePercent = metrics.bundlePercent || 0;
    if (effectiveBundlePercent > this.maxBundlePercent) {
      const verdict = {
        pass: false,
        status: 'REJECT',
        reason: `BUNDLE_SUPPLY_HIGH (${effectiveBundlePercent.toFixed(1)}% > ${this.maxBundlePercent}%)`,
        metrics,
        timestamp,
      };
      eventBus.emit('SAFETY_VERDICT', { mint: tokenInfo.mint, ...verdict });
      return verdict;
    }

    // Passed all hard gates
    const verdict = {
      pass: true,
      status: 'PASS',
      reason: 'CLEAN_LAUNCH_PASSED',
      metrics,
      timestamp,
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
