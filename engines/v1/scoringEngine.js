import { CONFIG } from '../config.js';

/**
 * Calculates Momentum Score (0-100)
 * Evaluates volume acceleration, holder arrival velocity, and buy pressure
 */
export function calculateMomentumScore(kinematics, organicScore) {
  let score = 50;

  // 1. Volume Acceleration contribution
  if (kinematics.volumeAcceleration >= 2.5) {
    score += 25;
  } else if (kinematics.volumeAcceleration >= 1.5) {
    score += 18;
  } else if (kinematics.volumeAcceleration >= 1.1) {
    score += 10;
  } else if (kinematics.volumeAcceleration < 0.5) {
    score -= 15;
  }

  // 2. Holder Velocity contribution
  if (kinematics.holderVelocity > 20) {
    score += 20;
  } else if (kinematics.holderVelocity > 8) {
    score += 12;
  } else if (kinematics.holderVelocity <= 0) {
    score -= 10;
  }

  // 3. Buy Pressure
  if (kinematics.buyPressurePercent >= 70) {
    score += 15;
  } else if (kinematics.buyPressurePercent >= 58) {
    score += 8;
  } else if (kinematics.buyPressurePercent < 45) {
    score -= 15;
  }

  // 4. Weight against Organic Score (manufactured momentum gets marked down)
  if (organicScore < 50) {
    score *= 0.5;
  } else if (organicScore < 75) {
    score *= 0.8;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Calculates Smart Money Score (0-100)
 * Evaluates smart trader presence, net smart flow, and absence of sybil dumping
 */
export function calculateSmartMoneyScore(smartTraderData) {
  let score = 50;

  const count = smartTraderData?.smartCount || 0;
  const netFlowUSD = smartTraderData?.smartNetFlowUSD || 0;

  if (count >= 5) {
    score += 30;
  } else if (count >= 2) {
    score += 18;
  } else if (count === 1) {
    score += 8;
  }

  if (netFlowUSD > 20000) {
    score += 20;
  } else if (netFlowUSD > 5000) {
    score += 10;
  } else if (netFlowUSD < -5000) {
    score -= 25; // Smart money distributing
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Computes composite Opportunity Score and assigns Alert Tier
 * @param {object} scores - { safety, momentum, smartMoney, structure }
 * @param {boolean} passedHardFails - Boolean outcome of hard safety filter
 */
export function calculateOpportunityScore(scores, passedHardFails) {
  if (!passedHardFails) {
    return {
      opportunityScore: 0,
      tier: 'REJECT',
      action: 'REJECT / HARD FAIL',
      color: '🔴',
    };
  }

  const { WEIGHTS, THRESHOLD_ENTRY, THRESHOLD_WATCH } = CONFIG.SCORING;

  const composite =
    scores.safety * WEIGHTS.SAFETY +
    scores.momentum * WEIGHTS.MOMENTUM +
    scores.smartMoney * WEIGHTS.SMART_MONEY +
    scores.structure * WEIGHTS.STRUCTURE;

  const opportunityScore = Math.round(composite);

  let tier = 'WATCH_ONLY';
  let action = 'IGNORE / MONITOR';
  let color = '⚪';

  if (opportunityScore >= THRESHOLD_ENTRY && scores.safety >= 80 && scores.structure >= 70) {
    tier = 'ENTRY_WINDOW';
    action = '🟢 ENTRY WINDOW (A+ CONFLUENCE)';
    color = '🟢';
  } else if (opportunityScore >= THRESHOLD_WATCH && scores.safety >= 70) {
    tier = 'WATCH';
    action = '🟡 WATCH (DEVELOPING STRUCTURE)';
    color = '🟡';
  }

  return {
    opportunityScore,
    tier,
    action,
    color,
  };
}
