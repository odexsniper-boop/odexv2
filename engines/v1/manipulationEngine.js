import { CONFIG } from '../config.js';

/**
 * Analyzes transaction, buyer, and volume relationships to detect manufactured volume vs organic trading.
 * @param {object} params
 * @param {number} params.volume - Total USD volume
 * @param {number} params.transactions - Total transaction count
 * @param {number} params.uniqueBuyers - Number of distinct buyers
 * @param {number} params.holders - Total holder count
 * @param {number} params.liquidity - Current pool liquidity USD
 */
export function analyzeOrganicActivity({ volume, transactions, uniqueBuyers, holders, liquidity }) {
  const result = {
    organicScore: 100,             // 0 - 100
    isWashTrading: false,
    washRisk: 'LOW',               // LOW | MEDIUM | HIGH | CRITICAL
    participationRatio: 1.0,       // uniqueBuyers / transactions
    turnoverPerHolder: 0,
    reasons: [],
  };

  if (!transactions || transactions === 0) {
    return result;
  }

  // 1. Participation Ratio: Unique Buyers vs Total Transactions
  // Organic meme launches typically have participation ratio between 0.25 and 0.70.
  // Wash trading scripts generate thousands of transactions between a tiny handful of wallets (<0.08).
  const buyers = uniqueBuyers || Math.max(1, Math.round(holders * 0.7)); // fallback estimate if API omits buyers
  result.participationRatio = parseFloat((buyers / transactions).toFixed(3));

  if (result.participationRatio < 0.08 && transactions > 150) {
    result.organicScore -= 45;
    result.reasons.push(`Suspiciously low buyer-to-transaction ratio (${(result.participationRatio * 100).toFixed(1)}%)`);
  } else if (result.participationRatio < 0.15 && transactions > 80) {
    result.organicScore -= 25;
    result.reasons.push(`Low unique buyer participation (${(result.participationRatio * 100).toFixed(1)}%)`);
  }

  // 2. Volume vs Holder Disconnect
  // Example: $500k volume with only 30 holders
  if (holders > 0) {
    result.turnoverPerHolder = Math.round(volume / holders);
    if (holders < 40 && volume > 100000) {
      result.organicScore -= 40;
      result.reasons.push(`Volume ($${Math.round(volume).toLocaleString()}) disconnected from holder count (${holders})`);
    } else if (holders < 80 && volume > 250000) {
      result.organicScore -= 25;
      result.reasons.push(`High turnover concentration per holder ($${result.turnoverPerHolder}/holder)`);
    }
  }

  // 3. Volume to Liquidity Churn Multiplier
  // If volume in 5m is 25x higher than total liquidity in pool with minimal holders, high probability of wash recycling
  if (liquidity > 0) {
    const churn = volume / liquidity;
    if (churn > 30 && holders < 120) {
      result.organicScore -= 20;
      result.reasons.push(`Extreme liquidity churn multiplier (${churn.toFixed(1)}x)`);
    }
  }

  // Clamp score
  result.organicScore = Math.max(0, Math.min(100, result.organicScore));

  // Categorize risk
  if (result.organicScore < 35) {
    result.washRisk = 'CRITICAL';
    result.isWashTrading = true;
  } else if (result.organicScore < 60) {
    result.washRisk = 'HIGH';
    result.isWashTrading = true;
  } else if (result.organicScore < 75) {
    result.washRisk = 'MEDIUM';
  } else {
    result.washRisk = 'LOW';
  }

  return result;
}

/**
 * Evaluates cluster and sniper-bundle risks from on-chain audit and Birdeye/Bubblemaps heuristics
 */
export function analyzeClusterRisk(bundlePercent, sniperPercent, insiderPercent) {
  const totalSybilPercent = (bundlePercent || 0) + (sniperPercent || 0) + (insiderPercent || 0);

  let clusterRisk = 'LOW';
  let penalty = 0;

  if (totalSybilPercent > 35) {
    clusterRisk = 'CRITICAL';
    penalty = 60;
  } else if (totalSybilPercent > 20) {
    clusterRisk = 'HIGH';
    penalty = 35;
  } else if (totalSybilPercent > 10) {
    clusterRisk = 'MEDIUM';
    penalty = 15;
  }

  return {
    totalSybilPercent,
    clusterRisk,
    penalty,
  };
}

/**
 * Stage 2: Money Flow & Order Flow Validation
 * Validates real capital entry, buy/sell volume delta, unique buyers, liquidity ratios,
 * holder concentration, and dev selling behavior.
 */
export function validateMoneyFlow({
  buyVolumeSol = 0,
  sellVolumeSol = 0,
  uniqueBuyersCount = 0,
  txCount = 0,
  txVelocity = 0,
  liquiditySol = 30,
  marketCapSol = 30,
  topHoldersPercent = 0,
  devHoldingPercent = 0,
  devSoldAny = false,
  requiresExceptionalMomentum = false,
}) {
  const reasons = [];
  let score = 50;

  // 1. HARD VETO: Dev / Insider Selling
  if (devSoldAny) {
    return {
      passed: false,
      score: 0,
      reason: 'DEV_OR_INSIDER_SOLD',
      reasons: ['Dev wallet or initial creator sold tokens into market'],
      buySellRatio: 0,
      netVolumeDeltaSol: buyVolumeSol - sellVolumeSol,
    };
  }

  // 2. HARD VETO: Top Holders Concentration (Cabal / bundled dump risk)
  if (topHoldersPercent > 35) {
    return {
      passed: false,
      score: 15,
      reason: 'HIGH_SUPPLY_CONCENTRATION',
      reasons: [`Top non-curve holders control ${topHoldersPercent.toFixed(1)}% of supply (> 35%)`],
      buySellRatio: buyVolumeSol / (sellVolumeSol || 0.001),
      netVolumeDeltaSol: buyVolumeSol - sellVolumeSol,
    };
  }

  // 3. Buy Volume vs Sell Volume (Net Delta)
  const netDelta = buyVolumeSol - sellVolumeSol;
  const ratio = sellVolumeSol > 0 ? buyVolumeSol / sellVolumeSol : (buyVolumeSol > 0 ? 5.0 : 1.0);

  if (ratio >= 1.5 && netDelta > 0) {
    score += 25;
    reasons.push(`Strong net buy delta (+${netDelta.toFixed(2)} SOL, ${(ratio).toFixed(1)}x buy/sell)`);
  } else if (ratio >= 1.1) {
    score += 10;
    reasons.push(`Net positive buy volume (${(ratio).toFixed(1)}x)`);
  } else if (ratio < 0.8) {
    score -= 25;
    reasons.push(`Net sell pressure dominating (${(ratio).toFixed(1)}x buy/sell)`);
  }

  // 4. Unique Buyers Count & Breadth
  if (uniqueBuyersCount >= 10) {
    score += 20;
    reasons.push(`Broad buyer base (${uniqueBuyersCount} unique buyers)`);
  } else if (uniqueBuyersCount >= 5) {
    score += 10;
    reasons.push(`Moderate buyer participation (${uniqueBuyersCount} buyers)`);
  } else if (uniqueBuyersCount < 3) {
    score -= 20;
    reasons.push(`Low unique buyer interest (${uniqueBuyersCount} buyers)`);
  }

  // 5. Transaction Velocity & Activity
  if (txVelocity >= 5 || txCount >= 15) {
    score += 15;
    reasons.push(`Active transaction velocity (${txCount} txs)`);
  } else if (txCount < 5) {
    score -= 10;
    reasons.push(`Dormant transaction volume`);
  }

  // 6. Market Cap vs Liquidity Relationship
  if (liquiditySol > 0) {
    const mcLiqRatio = marketCapSol / liquiditySol;
    if (mcLiqRatio > 25) {
      score -= 20;
      reasons.push(`Over-leveraged MC to Liquidity ratio (${mcLiqRatio.toFixed(1)}x)`);
    } else if (mcLiqRatio <= 10 && mcLiqRatio >= 0.8) {
      score += 10;
      reasons.push(`Healthy liquidity backing (${mcLiqRatio.toFixed(1)}x MC/Liq)`);
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, Math.round(score)));

  let requiredVolume = 0.5;
  let requiredTxs = 8;
  let requiredBuyers = 5;

  // Narrative VIP Bypass requirements:
  // "Requires exceptional buy volume relative to available liquidity, plus strong buyer and transaction acceleration."
  if (requiresExceptionalMomentum) {
    // Volume must be at least 10% of available liquidity (e.g. 3.0 SOL if liq is 30)
    requiredVolume = Math.max(2.0, liquiditySol * 0.10); 
    requiredTxs = 20; // Strong transaction acceleration
    requiredBuyers = 10; // Strong buyer acceleration
    reasons.push(`NARRATIVE BYPASS ACTIVE: Requiring ${requiredVolume.toFixed(1)} SOL, ${requiredBuyers} buyers`);
  }

  // Adaptive Buyer Check (Allow 3-4 buyers if volume is exceptionally high organically)
  if (!requiresExceptionalMomentum && uniqueBuyersCount >= 3 && uniqueBuyersCount < 5 && buyVolumeSol >= 2.0 && ratio >= 1.5) {
    requiredBuyers = uniqueBuyersCount; // Forgive the rule
    reasons.push(`ADAPTIVE BUYER EXCEPTION: Allowed ${uniqueBuyersCount} buyers due to massive ${buyVolumeSol.toFixed(1)} SOL organic volume`);
  }

  const hasMinVolume = buyVolumeSol >= requiredVolume;
  const hasMinActivity = txCount >= requiredTxs;
  const hasMinBuyers = uniqueBuyersCount >= requiredBuyers;
  
  const passed = score >= 65 && ratio >= 1.2 && hasMinBuyers && hasMinVolume && hasMinActivity;

  let failureReason = 'MONEY_FLOW_WEAK';
  if (ratio < 1.0) failureReason = 'NET_SELL_PRESSURE';
  else if (!hasMinBuyers) failureReason = `INSUFFICIENT_UNIQUE_BUYERS (${uniqueBuyersCount}/${requiredBuyers})`;
  else if (!hasMinVolume) failureReason = `INSUFFICIENT_BUY_VOLUME (${buyVolumeSol.toFixed(2)}/${requiredVolume.toFixed(2)} SOL)`;
  else if (!hasMinActivity) failureReason = `INSUFFICIENT_ACTIVITY (${txCount}/${requiredTxs} txs)`;

  return {
    passed,
    score,
    reason: passed ? 'MONEY_FLOW_CONFIRMED' : failureReason,
    reasons,
    buySellRatio: parseFloat(ratio.toFixed(2)),
    netVolumeDeltaSol: parseFloat(netDelta.toFixed(3)),
    uniqueBuyersCount,
  };
}
