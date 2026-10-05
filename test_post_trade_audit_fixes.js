import assert from 'assert';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { DevWatcher } from './engines/devWatcher.js';
import { evaluateThreeCandlePattern } from './engines/priceEngine.js';
import { HardSafetyFilter } from './engines/safetyEngine.js';

console.log('====================================================');
console.log('🧪 RUNNING POST-TRADE AUDIT CRITICAL FIXES TEST SUITE');
console.log('====================================================\n');

class MockExecutionEngine {
  constructor() {
    this.buyCalls = [];
  }
  async executeBuy(params) {
    this.buyCalls.push(params);
    return {
      mint: params.mint,
      txHash: 'sim_buy_' + Date.now(),
      solSpent: params.solAmount || 0.1,
      actualBuyCost: params.solAmount || 0.1,
      spotPriceSol: 0.00000005,
      tokensReceived: 2000000,
    };
  }
}

class MockPositionManager {
  constructor() {
    this.positions = new Map();
  }
  isDailyLossExceeded() { return false; }
  openPosition(fill, meta) {
    const pos = { mint: fill.mint, ...fill, ...meta };
    this.positions.set(fill.mint, pos);
    return pos;
  }
}

async function runTests() {
  let passed = 0;
  let total = 0;

  function test(name, condition, extraInfo = '') {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${extraInfo}`);
    }
  }

  // -------------------------------------------------------------
  // Test A: Bundle Verification Entry Gate (Pending -> Wait -> Verified -> Buy)
  // -------------------------------------------------------------
  console.log('\n--- [TEST A] Bundle Verification Entry Gate ---');
  {
    const exec = new MockExecutionEngine();
    const posMgr = new MockPositionManager();
    const orch = new Orchestrator({
      executionEngine: exec,
      positionManager: posMgr,
      autoBuyEnabled: true,
      bundleVerificationTimeoutMs: 5000,
    });

    const mintA = 'TestMintBundleWait11111111111111111111111111';
    const recA = new TokenRecord(mintA);
    recA.name = 'Test Pending Bundle';
    recA.bundleDataStatus = 'PENDING';
    recA.safetyVerdict = { pass: true, metrics: { bundleDataStatus: 'PENDING' } };
    orch.tokens.set(mintA, recA);

    // Trigger Stage 3 pattern confirmation while bundle is PENDING
    await orch._handleTriggerConfirmed({
      mint: mintA,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 95,
      reason: 'Setup A breakout complete'
    });

    test('A.1: Entry blocked and token transitions to ENTRY_BLOCKED_BUNDLE_PENDING when bundle is PENDING',
      recA.state === TokenState.ENTRY_BLOCKED_BUNDLE_PENDING && exec.buyCalls.length === 0,
      `State: ${recA.state}, Buy calls: ${exec.buyCalls.length}`);

    // Now simulate on-chain bundle verification resolving cleanly
    orch.handleBundleMetricsUpdated({
      mint: mintA,
      bundleDataStatus: 'VERIFIED',
      bundledBuysCount: 1,
      bundlePercent: 2.5,
      devPercent: 1.0,
    });

    // Wait microtask tick for async resume
    await new Promise(r => setTimeout(r, 50));

    test('A.2: Once bundle resolves to VERIFIED, token transitions to POSITION_OPEN and executes buy',
      recA.state === TokenState.POSITION_OPEN && exec.buyCalls.length === 1 && exec.buyCalls[0].mint === mintA,
      `State: ${recA.state}, Buy calls: ${exec.buyCalls.length}`);
  }

  // -------------------------------------------------------------
  // Test B: Bundle Never Resolves (Timeout -> Expired)
  // -------------------------------------------------------------
  console.log('\n--- [TEST B] Bundle Verification Timeout ---');
  {
    const exec = new MockExecutionEngine();
    const posMgr = new MockPositionManager();
    const orch = new Orchestrator({
      executionEngine: exec,
      positionManager: posMgr,
      autoBuyEnabled: true,
      bundleVerificationTimeoutMs: 150, // fast timeout for test
    });

    const mintB = 'TestMintBundleTimeout111111111111111111111111';
    const recB = new TokenRecord(mintB);
    recB.name = 'Test Bundle Timeout';
    recB.bundleDataStatus = 'PENDING';
    recB.safetyVerdict = { pass: true, metrics: { bundleDataStatus: 'PENDING' } };
    orch.tokens.set(mintB, recB);

    await orch._handleTriggerConfirmed({
      mint: mintB,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 95,
      reason: 'Setup A breakout complete'
    });

    test('B.1: Enters ENTRY_BLOCKED_BUNDLE_PENDING',
      recB.state === TokenState.ENTRY_BLOCKED_BUNDLE_PENDING);

    // Wait for timeout to elapse
    await new Promise(r => setTimeout(r, 220));

    test('B.2: Token expires with ENTRY_EXPIRED_BUNDLE_TIMEOUT after timeout expires',
      recB.state === TokenState.EXPIRED && recB.rejectionReason.includes('ENTRY_EXPIRED_BUNDLE_TIMEOUT') && exec.buyCalls.length === 0,
      `State: ${recB.state}, Reason: ${recB.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // Test C: Continuous Dev Behavior Risk (Low Initial Allocation -> Dump Risk)
  // -------------------------------------------------------------
  console.log('\n--- [TEST C] Dev Behavior Risk Tracking ---');
  {
    const devWatcher = new DevWatcher(null, null, null);
    const mintC = 'TestMintDevDumpRisk1111111111111111111111111';
    const creatorC = '4FNioEKkDevCreatorWallet11111111111111111111111';

    // Dev starts with 1.0% (10,000,000 tokens)
    const initialBuf = Buffer.alloc(72);
    initialBuf.writeBigUInt64LE(10_000_000_000_000n, 64);

    devWatcher.monitoredDevs.set(mintC, {
      creatorPubkey: creatorC,
      state: 'KNOWN',
      initialBalance: 10_000_000_000_000n,
      peakBalance: 10_000_000_000_000n,
      lastBalance: 10_000_000_000_000n,
      totalAcquired: 10_000_000_000_000n,
      cumulativeDumpedTokens: 0n,
      riskLevel: 'NONE',
      bufferQueue: []
    });

    const initialRisk = devWatcher.getDevRisk(mintC);
    test('C.1: Dev initially classified as DEV_NORMAL when no dump activity detected',
      initialRisk.status === 'DEV_NORMAL' && initialRisk.safeForEntry === true,
      `Status: ${initialRisk.status}`);

    // Simulate dev selling 20% on-chain during breakout
    const sellBuf = Buffer.alloc(72);
    sellBuf.writeBigUInt64LE(8_000_000_000_000n, 64);
    devWatcher._processAccountUpdate(mintC, creatorC, sellBuf);

    const postSellRisk = devWatcher.getDevRisk(mintC);
    test('C.2: Dev behavior flags DEV_DUMP_DETECTED / safeForEntry=false after dump',
      postSellRisk.safeForEntry === false && (postSellRisk.status === 'DEV_DUMP_DETECTED' || postSellRisk.status === 'DEV_DUMP_RISK'),
      `Status: ${postSellRisk.status}, Reason: ${postSellRisk.reason}`);

    // Verify Orchestrator blocks entry
    const exec = new MockExecutionEngine();
    const posMgr = new MockPositionManager();
    const orch = new Orchestrator({
      executionEngine: exec,
      positionManager: posMgr,
      devWatcher,
      autoBuyEnabled: true
    });

    const recC = new TokenRecord(mintC);
    recC.name = 'ControlAI Simulation';
    recC.creator = creatorC;
    recC.bundleDataStatus = 'VERIFIED';
    recC.safetyVerdict = { pass: true };
    orch.tokens.set(mintC, recC);

    await orch._handleTriggerConfirmed({
      mint: mintC,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 95
    });

    test('C.3: Centralized entry gate blocks token when dev behavior risk is active',
      recC.state === TokenState.REJECTED && recC.rejectionReason.includes('ENTRY_BLOCKED_DEV_RISK') && exec.buyCalls.length === 0,
      `State: ${recC.state}, Reason: ${recC.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // Test D: Parabolic Setup B (Exhaustion Gate -> Retest Reclaim)
  // -------------------------------------------------------------
  console.log('\n--- [TEST D] Parabolic Setup B Retest Protection ---');
  {
    const now = Date.now();
    // Simulate CLOUT: C1 +14.2%, C2 +28.0% (Cumulative +42.2%)
    const candlesParabolic = [
      { open: 1.0, high: 1.15, low: 0.99, close: 1.142, timestamp: now - 30000 },  // C1: +14.2%
      { open: 1.142, high: 1.48, low: 1.14, close: 1.462, timestamp: now - 15000 }, // C2: +28.0%
      { open: 1.462, high: 1.55, low: 1.45, close: 1.52, timestamp: now }          // C3: +3.9%
    ];

    const verdictParabolic = evaluateThreeCandlePattern(candlesParabolic, { timeframeMs: 15000, maxAllowedGapMs: 40000 });
    test('D.1: Parabolic 2-candle surge (+42%) blocked by PARABOLIC_EXTENSION gate',
      verdictParabolic.patternTriggered === false && verdictParabolic.parabolicExtension === true && verdictParabolic.stage === 'PARABOLIC_EXTENSION',
      `Stage: ${verdictParabolic.stage}, Reason: ${verdictParabolic.reason}`);

    // Now simulate 4-candle controlled pullback + reclaim (Setup B4)
    const candlesRetest = [
      { open: 1.0, high: 1.15, low: 0.99, close: 1.142, timestamp: now - 45000 },  // C1
      { open: 1.142, high: 1.48, low: 1.14, close: 1.462, timestamp: now - 30000 }, // C2: Parabolic surge
      { open: 1.462, high: 1.47, low: 1.30, close: 1.35, timestamp: now - 15000 },  // C3: Controlled pullback holding support
      { open: 1.35, high: 1.52, low: 1.34, close: 1.50, timestamp: now }            // C4: Bullish reclaim of C3 high
    ];

    const verdictRetest = evaluateThreeCandlePattern(candlesRetest, { timeframeMs: 15000, maxAllowedGapMs: 40000 });
    test('D.2: Setup B4 successfully triggers entry after structural pullback and reclaim',
      verdictRetest.patternTriggered === true && verdictRetest.stage === 'C3_ENTRY_TRIGGERED' && verdictRetest.reason.includes('Setup B4 (Momentum Retest)'),
      `Stage: ${verdictRetest.stage}, Reason: ${verdictRetest.reason}`);
  }

  // -------------------------------------------------------------
  // Test E & F: Cluster Risk Gating (HIGH restricted vs CRITICAL veto)
  // -------------------------------------------------------------
  console.log('\n--- [TEST E & F] Cluster Risk Material Gating ---');
  {
    const exec = new MockExecutionEngine();
    const posMgr = new MockPositionManager();
    const orch = new Orchestrator({
      executionEngine: exec,
      positionManager: posMgr,
      autoBuyEnabled: true
    });

    // Test E.1: High Cluster Risk with weak organic metrics (Signalgame Coin scenario: 6 buyers, +0.698 SOL)
    const mintE1 = 'TestMintClusterHighWeak1111111111111111111111';
    const recE1 = new TokenRecord(mintE1);
    recE1.name = 'Signalgame Coin Simulation';
    recE1.bundleDataStatus = 'VERIFIED';
    recE1.safetyVerdict = { pass: true };
    recE1.buyerQuality = { coordinationRisk: 'HIGH', organicBuyerCount: 6, reasons: ['High coordination'] };
    recE1.stage2_moneyFlow = { passed: true, netVolumeDeltaSol: 0.698, buySellRatio: 1.74, uniqueBuyersCount: 6 };
    orch.tokens.set(mintE1, recE1);

    await orch._handleTriggerConfirmed({
      mint: mintE1,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 80
    });

    test('E.1: Cluster Risk HIGH with insufficient organic confirmation is BLOCKED',
      recE1.state === TokenState.REJECTED && recE1.rejectionReason.includes('ENTRY_BLOCKED_CLUSTER_HIGH') && exec.buyCalls.length === 0,
      `State: ${recE1.state}, Reason: ${recE1.rejectionReason}`);

    // Test E.2: High Cluster Risk WITH strong organic confirmation (15 buyers, +3.2 SOL, 2.5x ratio, narrative 85)
    const mintE2 = 'TestMintClusterHighStrong111111111111111111111';
    const recE2 = new TokenRecord(mintE2);
    recE2.name = 'Viral High Cluster Token';
    recE2.bundleDataStatus = 'VERIFIED';
    recE2.safetyVerdict = { pass: true };
    recE2.narrativeScore = 85;
    recE2.buyerQuality = { coordinationRisk: 'HIGH', organicBuyerCount: 15 };
    recE2.stage2_moneyFlow = { passed: true, netVolumeDeltaSol: 3.2, buySellRatio: 2.5, uniqueBuyersCount: 15 };
    orch.tokens.set(mintE2, recE2);

    await orch._handleTriggerConfirmed({
      mint: mintE2,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 90
    });

    test('E.2: Cluster Risk HIGH WITH elevated organic confirmation (15 buyers, +3.2 SOL) allows entry',
      recE2.state === TokenState.POSITION_OPEN && exec.buyCalls.some(b => b.mint === mintE2),
      `State: ${recE2.state}, Buy calls: ${exec.buyCalls.length}`);

    // Test F: CRITICAL Cluster Risk (Hard Veto regardless of volume)
    const mintF = 'TestMintClusterCritical111111111111111111111111';
    const recF = new TokenRecord(mintF);
    recF.name = 'Cabal Sybil Token';
    recF.bundleDataStatus = 'VERIFIED';
    recF.safetyVerdict = { pass: true };
    recF.buyerQuality = { coordinationRisk: 'CRITICAL', organicBuyerCount: 20 };
    orch.tokens.set(mintF, recF);

    await orch._handleTriggerConfirmed({
      mint: mintF,
      patternTriggered: true,
      stage: 'C3_ENTRY_TRIGGERED',
      score: 95
    });

    test('F.1: Cluster Risk CRITICAL is HARD VETOED immediately',
      recF.state === TokenState.REJECTED && recF.rejectionReason.includes('ENTRY_BLOCKED_CLUSTER_CRITICAL') && !exec.buyCalls.some(b => b.mint === mintF),
      `State: ${recF.state}, Reason: ${recF.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // Test G: Race Condition / Asynchronous Stale State Protection
  // -------------------------------------------------------------
  console.log('\n--- [TEST G] Asynchronous Stale State Protection ---');
  {
    const exec = new MockExecutionEngine();
    const posMgr = new MockPositionManager();
    const orch = new Orchestrator({
      executionEngine: exec,
      positionManager: posMgr,
      autoBuyEnabled: true
    });

    const mintG = 'TestMintRaceCondition1111111111111111111111111';
    const recG = new TokenRecord(mintG);
    recG.name = 'Race Condition Token';
    recG.bundleDataStatus = 'VERIFIED';
    recG.safetyVerdict = { pass: true };
    recG.state = TokenState.ENTRY_READY; // Token marked ENTRY_READY earlier
    orch.tokens.set(mintG, recG);

    // Suddenly before triggerExecution executes, dev rugs or bundle status is flagged
    recG.bundleDataStatus = 'SUSPICIOUS';

    // Stale callback calls triggerExecution directly
    await orch.triggerExecution(recG);

    test('G.1: Synchronous centralized gate in triggerExecution aborts buy on stale or degraded token state',
      recG.state === TokenState.REJECTED && recG.rejectionReason.includes('ENTRY_BLOCKED_BUNDLE_RISK') && !exec.buyCalls.some(b => b.mint === mintG),
      `State: ${recG.state}, Reason: ${recG.rejectionReason}`);
  }

  console.log('\n====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} / ${total} TESTS PASSED`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
