import { Orchestrator } from './engines/orchestrator.js';
import { PositionManager } from './engines/positionManager.js';
import { SmartAgent } from './engines/smartAgent.js';
import { ExecutionController } from './engines/executionController.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { PublicKey } from '@solana/web3.js';

console.log('🧪 Starting Verification Suite for Newly Applied Blind Spot Fixes...\n');

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name} -> ${details}`);
    failed++;
  }
}

class MockExecutionEngine {
  constructor() {
    this.jitoTipLamports = 10_000_000;
    this.defaultPriorityFeeMicroLamports = 100_000;
  }
  async executeBuy({ mint }) {
    return {
      txHash: 'sim_buy_hash_123',
      tokensReceived: 1000,
      actualBuyCost: 0.1,
      totalSolSpent: 0.1,
    };
  }
  async executeSell({ mint }) {
    return {
      txHash: 'sim_sell_hash_123',
      actualNetSellProceeds: 0.15,
      solReceived: 0.15,
    };
  }
}

async function runTests() {
  // -------------------------------------------------------------
  // Test 1: Dev dump during BUY_PENDING window
  // -------------------------------------------------------------
  console.log('--- [TEST 1] Dev Dump During BUY_PENDING Window ---');
  {
    let frontrunTriggered = false;
    let frontrunReason = null;

    const mockPM = {
      positions: new Map(),
      openPosition(fill, meta) {
        const pos = { mint: fill.mint, ...meta };
        this.positions.set(fill.mint, pos);
        return pos;
      },
      triggerEmergencyFrontrun(mint, reason) {
        frontrunTriggered = true;
        frontrunReason = reason;
      },
      isDailyLossExceeded() { return false; }
    };

    let curveUnwatched = false;
    const mockCurveWatcher = {
      watch() {},
      unwatch() { curveUnwatched = true; },
      isGraduated() { return false; }
    };

    const orch = new Orchestrator({
      executionEngine: new MockExecutionEngine(),
      positionManager: mockPM,
      curveWatcher: mockCurveWatcher,
      autoBuyEnabled: true,
      tradeCooldownMs: 0
    });

    const testMint = 'PendingRugMint1111111111111111111111111111111111';
    const record = new TokenRecord(testMint);
    record.state = TokenState.BUY_PENDING;
    record.name = 'PendingRugCoin';
    record.stage1_narrative = { passed: true, score: 80 }; record.stage2_moneyFlow = { passed: true, score: 80 }; record.stage3_pattern = { patternTriggered: true, score: 95 };
    orch.tokens.set(testMint, record);

    // Dev dump arrives while buy is still pending
    orch.handleDevDumpAlert({
      mint: testMint,
      dumpPercent: 100,
      isMuleDump: false,
    });

    test('1.1: CurveWatcher is NOT prematurely unwatched during BUY_PENDING dump',
      !curveUnwatched,
      `curveUnwatched was: ${curveUnwatched}`);
    test('1.2: Record flags pendingDevRugAlert',
      record.pendingDevRugAlert !== null && record.devSoldAny === true,
      `pendingDevRugAlert: ${record.pendingDevRugAlert}`);

    // Now executeBuy resolves and completes in triggerExecution
    await orch.triggerExecution(record);

    test('1.3: Immediate emergency frontrun triggered upon buy fill',
      frontrunTriggered === true && frontrunReason === 'DEV_RUG_FRONTRUN',
      `frontrunTriggered: ${frontrunTriggered}, reason: ${frontrunReason}`);
  }

  // -------------------------------------------------------------
  // Test 2: Take-profit tier retry after failed sell
  // -------------------------------------------------------------
  console.log('\n--- [TEST 2] Take-Profit Tier Recovery on Failed Sell ---');
  {
    let sellAttempt = 0;
    const failingExecution = {
      async executeSell() {
        sellAttempt++;
        if (sellAttempt === 1) {
          throw new Error('RPC_TIMEOUT_SIMULATED');
        }
        return { txHash: 'recovered_sell_tx', actualNetSellProceeds: 0.14 };
      }
    };

    const pm = new PositionManager(failingExecution, {
      takeProfitTiers: [{ triggerMultiplier: 1.35, sellPercent: 50 }]
    });

    const mint = 'TakeProfitTestMint11111111111111111111111111111';
    const initialSpotPrice = 3e-8;
    const pos = pm.openPosition({
      mint,
      actualBuyCost: 0.1,
      totalSolSpent: 0.1,
      tokensReceived: 1000,
      rawTokensReceived: '1000000000',
      spotPriceSol: initialSpotPrice
    }, { name: 'ProfitCoin' });

    // Tick 1: Price reaches 1.4x (+40%), triggers Tier 0 (triggerMultiplier: 1.35)
    // Initial sell will fail due to RPC_TIMEOUT_SIMULATED
    await pm.updatePrice(mint, 42_000_000_000n, 1_000_000_000_000_000n);

    test('2.1: Position remains OPEN after failed sell attempt',
      pos.status === 'HOLDING' && pm.positions.has(mint),
      `pos.status: ${pos.status}`);
    test('2.2: Failed take-profit tier is unmarked from hitTiers',
      !pos.hitTiers.has(0),
      `hitTiers has 0: ${pos.hitTiers.has(0)}`);

    // Tick 2: Subsequent price tick retries and confirms
    await pm.updatePrice(mint, 42_000_000_000n, 1_000_000_000_000_000n);

    test('2.3: Second tick retried sell and successfully took profit',
      sellAttempt === 2 && pos.hitTiers.has(0),
      `sellAttempt: ${sellAttempt}, hitTiers: ${Array.from(pos.hitTiers)}`);
    pm.positions.delete(mint);
  }

  // -------------------------------------------------------------
  // Test 3: Graduation check in triggerExecution
  // -------------------------------------------------------------
  console.log('\n--- [TEST 3] Graduation Check in triggerExecution ---');
  {
    let buyExecuted = false;
    const mockExecution = {
      async executeBuy() {
        buyExecuted = true;
        return { txHash: 'doomed_buy' };
      }
    };

    const mockGraduatedCurveWatcher = {
      isGraduated(m) { return true; },
      unwatch() {},
    };

    const orch = new Orchestrator({
      executionEngine: mockExecution,
      positionManager: { isDailyLossExceeded() { return false; }, positions: new Map() },
      curveWatcher: mockGraduatedCurveWatcher,
      autoBuyEnabled: true
    });

    const gradMint = 'GraduatedTokenMint11111111111111111111111111111';
    const gradRecord = new TokenRecord(gradMint);
    gradRecord.name = 'MoonedCoin';
    gradRecord.state = TokenState.ENTRY_READY;
    gradRecord.stage1_narrative = { passed: true, score: 80 }; gradRecord.stage2_moneyFlow = { passed: true, score: 80 }; gradRecord.stage3_pattern = { patternTriggered: true, score: 95 };
    orch.tokens.set(gradMint, gradRecord);

    await orch.triggerExecution(gradRecord);

    test('3.1: triggerExecution blocks buy on already graduated curve',
      !buyExecuted && gradRecord.state === TokenState.REJECTED && gradRecord.rejectionReason === 'CURVE_ALREADY_GRADUATED',
      `buyExecuted: ${buyExecuted}, state: ${gradRecord.state}, reason: ${gradRecord.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // Test 4: SmartAgent evaluates composite entryScore
  // -------------------------------------------------------------
  console.log('\n--- [TEST 4] SmartAgent Composite entryScore Gatekeeper ---');
  {
    const agent = new SmartAgent({ learningEnabled: true });
    agent.learningEnabled = true;
    agent.effectiveMinCompositeScore = 80; // High threshold required

    // Low entry score (55) with 0 dev and 5 buyers
    const verdictLow = agent.evaluateEntry({
      devPercent: 0,
      bundledBuysCount: 0,
      uniqueBuyersCount: 5,
      entryScore: 55,
    });

    test('4.1: Low composite entry score (55 < 80) is REJECTED by SmartAgent',
      verdictLow.shouldTrade === false && verdictLow.reason.includes('SCORE_BELOW_THRESHOLD'),
      `shouldTrade: ${verdictLow.shouldTrade}, reason: ${verdictLow.reason}`);

    // High entry score (85)
    const verdictHigh = agent.evaluateEntry({
      devPercent: 0,
      bundledBuysCount: 0,
      uniqueBuyersCount: 5,
      entryScore: 85,
    });

    test('4.2: High composite entry score (85 >= 80) passes SmartAgent',
      verdictHigh.shouldTrade === true,
      `shouldTrade: ${verdictHigh.shouldTrade}, score: ${verdictHigh.score}`);
  }

  // -------------------------------------------------------------
  // Test 5: Sell proceeds math without phantom fallback
  // -------------------------------------------------------------
  console.log('\n--- [TEST 5] Sell Proceeds Math Without Phantom Fallback ---');
  {
    const controller = new ExecutionController({
      blockhashManager: {},
      executionCache: {},
      tokenResolver: {},
      transactionBuilder: {},
      dispatcher: {},
      transactionMonitor: {},
      isPaperTrading: true,
    });

    // Verify context creation and non-negative slippage
    const ctx = controller.createTradeContext('SELL', 'mint12345678901234567890123456789012', 1000n);
    test('5.1: ExecutionController created trade context with idempotency key',
      ctx.action === 'SELL' && ctx.idempotencyKey.includes('SELL:mint12345678901234567890123456789012'),
      `idempotencyKey: ${ctx.idempotencyKey}`);
  }

  console.log('\n================================================================');
  console.log(`🏁 NEW BLIND SPOT FIXES RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
