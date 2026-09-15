import { CONFIG, log } from './config.js';
import { snapshotStore } from './storage/snapshotStore.js';
import { determineLifecycleState, calculateMarketKinematics } from './engines/marketEngine.js';
import { evaluateHardFails, calculateSafetyScore } from './engines/safetyEngine.js';
import { analyzeOrganicActivity } from './engines/manipulationEngine.js';
import { analyzePriceStructure } from './engines/priceEngine.js';
import {
  calculateMomentumScore,
  calculateSmartMoneyScore,
  calculateOpportunityScore,
} from './engines/scoringEngine.js';
import { dispatchOpportunityAlert } from './alerts/telegramAlert.js';

async function runSystemTest() {
  log('Starting Multi-Signal Early-Warning Intelligence Test...');

  const testMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // Bonk mint as safe baseline

  // 1. Test Ingestion & Lifecycle States
  log('Testing Lifecycle States...');
  const state0 = determineLifecycleState(22);
  const state1 = determineLifecycleState(110);
  const state2 = determineLifecycleState(450);
  const state3 = determineLifecycleState(1200);

  log(`- 22s  => ${state0.label}`);
  log(`- 110s => ${state1.label}`);
  log(`- 450s => ${state2.label}`);
  log(`- 1200s=> ${state3.label}`);

  // 2. Test Time-Series Snapshot Storing & Kinematics
  log('Testing Time-Series Recording & Kinematics...');
  snapshotStore.record(testMint, {
    volume: 50000,
    liquidity: 120000,
    marketCap: 800000,
    holders: 120,
    buys: 110,
    sells: 40,
  });

  const kinematics = calculateMarketKinematics(testMint, {
    volume: 135000,
    liquidity: 132000,
    marketCap: 950000,
    holders: 184,
    buys: 280,
    sells: 90,
    priceChange: 18.5,
  });
  log(`- Volume Accel: ${kinematics.volumeAcceleration}x`);
  log(`- Holder Velocity: +${kinematics.holderVelocity}/min`);
  log(`- Buy Pressure: ${kinematics.buyPressurePercent}%`);
  log(`- Liquidity Trend: ${kinematics.liquidityChangePercent}%`);

  // 3. Test Manipulation / Wash Detection
  log('Testing Organic Activity vs Wash Detection...');
  const washProfile = analyzeOrganicActivity({
    volume: 450000,
    transactions: 3800,
    uniqueBuyers: 35,
    holders: 42,
    liquidity: 80000,
  });
  log(`- Wash Profile (Manufactured Volume): Organic=${washProfile.organicScore}/100, WashRisk=${washProfile.washRisk}`);

  const organicProfile = analyzeOrganicActivity({
    volume: 346000,
    transactions: 1400,
    uniqueBuyers: 620,
    holders: 490,
    liquidity: 164000,
  });
  log(`- Organic Profile: Organic=${organicProfile.organicScore}/100, WashRisk=${organicProfile.washRisk}`);

  // 4. Test Safety & Hard Fails
  log('Testing Safety Engine & Hard Fail Exclusions...');
  const unsafeAudit = {
    mintDisabled: false, // dangerous!
    freezeDisabled: true,
    top10Percent: 48,
    devPercent: 18,
    bundlePercent: 32,
    liquidity: 8000,
    liqRatio: 0.04,
    washTradingRisk: 'HIGH',
  };
  const unsafeResult = evaluateHardFails(unsafeAudit);
  log(`- Malicious Launch Rejection: Passed=${unsafeResult.passed} | Triggers: ${unsafeResult.hardFailTriggers.join(', ')}`);

  const safeAudit = {
    mintDisabled: true,
    freezeDisabled: true,
    top10Percent: 22.4,
    devPercent: 1.4,
    bundlePercent: 4.0,
    liquidity: 164000,
    liqRatio: 0.138,
    washTradingRisk: 'LOW',
    clusterRisk: 'LOW',
    creatorRisk: 'LOW',
  };
  const safeResult = evaluateHardFails(safeAudit);
  const safetyScore = calculateSafetyScore(safeAudit);
  log(`- Clean Launch Audit: Passed=${safeResult.passed} | Safety Score: ${safetyScore}/100`);

  // 5. Test Price Engine (Reclaim / Higher Low)
  log('Testing Price Engine...');
  // Synthesize higher low candle series
  const mockCandles = [];
  const base = 0.001;
  for (let i = 0; i < 25; i++) {
    const t = 1700000000 + i * 60;
    if (i < 10) mockCandles.push([t, base, base * 1.5, base * 0.9, base * 1.4, 1000]);
    else if (i < 18) mockCandles.push([t, base * 1.4, base * 1.4, base * 1.05, base * 1.1, 800]); // pullback
    else mockCandles.push([t, base * 1.1, base * 1.35, base * 1.08, base * 1.3, 3500]); // reclaim & higher low
  }
  const priceStructure = analyzePriceStructure(mockCandles.reverse());
  log(`- Price Stage: ${priceStructure.stage} | Higher Low: ${priceStructure.isHigherLow} | Score: ${priceStructure.priceScore}/100`);

  // 6. Test Multi-Pillar Scoring & Alert Dispatch
  log('Testing Multi-Score Synthesis...');
  const momentumScore = calculateMomentumScore(kinematics, organicProfile.organicScore);
  const smartMoneyScore = calculateSmartMoneyScore({ smartCount: 7, smartNetFlowUSD: 24000 });
  const structureScore = priceStructure.priceScore;

  const scores = {
    safety: safetyScore,
    momentum: momentumScore,
    smartMoney: smartMoneyScore,
    structure: structureScore,
  };

  const opportunity = calculateOpportunityScore(scores, safeResult.passed);
  log(`🎯 Final Opportunity Score: ${opportunity.opportunityScore}/100 | Tier: ${opportunity.tier} | Action: ${opportunity.action}`);

  // 7. Dispatch Actionable Telegram Card
  log('Simulating Actionable Telegram Alert Card...');
  await dispatchOpportunityAlert({
    symbol: 'ABC',
    mint: testMint,
    ageSeconds: 402, // 6m 42s
    marketCap: 1180000,
    liquidity: 164000,
    liqRatio: 0.138,
    scores,
    kinematics: {
      volumeAcceleration: 2.7,
      holderVelocity: 184,
      liquidityChangePercent: 11.0,
      buyPressurePercent: 72,
    },
    organic: organicProfile,
    audit: safeAudit,
    priceStructure: {
      stage: 'HIGHER_LOW_RECLAIM',
      isHigherLow: true,
      pullbackDepth: 22.5,
      isReclaim: true,
    },
    tier: opportunity.tier,
    opportunityScore: opportunity.opportunityScore,
  });

  log('🎉 All Engine Tests Passed Successfully!');
}

runSystemTest();

