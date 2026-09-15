import { log } from '../config.js';

export class MomentumEngine {
  constructor() {
    this.candidates = new Map(); // mint -> CandidateRecord
  }

  registerCandidate(tokenInfo) {
    if (this.candidates.has(tokenInfo.mint)) return;

    this.candidates.set(tokenInfo.mint, {
      mint: tokenInfo.mint,
      name: tokenInfo.name || 'Unknown Token',
      symbol: tokenInfo.symbol || 'UNK',
      creator: tokenInfo.creator,
      detectedAt: Date.now(),
      bundledBuysCount: tokenInfo.bundledBuysCount || 0,
      devPercent: tokenInfo.devPercent || 0,
    });
  }

  /**
   * Only approves trade if the token is proven ALIVE:
   * 1. Dev does not own majority (<=10%)
   * 2. Has initial coordinated or external buyers (bundledBuysCount >= 2 or active buy detected)
   */
  shouldSnipe(tokenInfo) {
    // Check if launch had immediate buyers
    const hasInitialVolume = (tokenInfo.bundledBuysCount && tokenInfo.bundledBuysCount >= 2);
    const isSafe = (tokenInfo.devPercent <= 10.0);

    if (isSafe && hasInitialVolume) {
      log(`?? [QUALITY FILTER PASSED] ${tokenInfo.name || tokenInfo.mint.slice(0, 8)} has confirmed initial buyers (${tokenInfo.bundledBuysCount}) & safe dev (${tokenInfo.devPercent.toFixed(1)}%)`);
      return true;
    }
    return false;
  }
}

export function calculateSuccessRate(metrics = {}) {
  let score = 45;
  const dev = metrics.devPercent || 0;
  if (dev === 0) score += 20;
  else if (dev <= 2.5) score += 25;
  else if (dev <= 6.0) score += 10;
  else if (dev > 10.0) score -= 35;

  const bundleCount = metrics.bundledBuysCount || 1;
  if (bundleCount >= 2) score += 25;
  else score -= 15; // Penalize dead 0-buyer launches

  return Math.min(Math.max(score, 10), 95);
}
