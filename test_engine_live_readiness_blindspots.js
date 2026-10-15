import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PublicKey, Keypair } from '@solana/web3.js';
import { ExecutionController } from './engines/executionController.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { CandleBuilder, evaluateThreeCandlePattern } from './engines/priceEngine.js';
import { SmartAgent } from './engines/smartAgent.js';
import { PositionManager } from './engines/positionManager.js';
import { DevWatcher } from './engines/devWatcher.js';
import { BondingCurveWatcher } from './engines/curveWatcher.js';
import { eventBus } from './eventBus.js';

console.log('================================================================');
console.log('🧪 RUNNING VERIFICATION SUITE: ENGINE PRODUCTION LIVE READINESS');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
    failed++;
    process.exit(1);
  }
}

async function runTests() {
  // -------------------------------------------------------------
  // TEST 1: Live Buy Fill Fee Transparency & Route Retention
  // -------------------------------------------------------------
  console.log('--- TEST 1: ExecutionController Live Buy Fee Accounting ---');
  {
    const dummyWallet = Keypair.generate();
    let dispatchedRoute = null;

    const mockDispatcher = {
      dispatch: async () => {
        dispatchedRoute = 'JITO:SENDTRANSACTION';
        return {
          signature: 'sig_live_test_12345',
          route: 'JITO:SENDTRANSACTION',
          jitoAccepted: true,
          dispatchDurationMs: 12,
        };
      },
      cleanup: () => {},
    };

    const mockMonitor = {
      track: async () => ({
        status: 'SUCCESS',
        confirmationLatencyMs: 450,
      }),
    };

    const mockBuilder = {
      buildSignedBuyTransaction: async () => ({
        wireTransaction: Buffer.from([]),
        transaction: {},
        userAta: dummyWallet.publicKey,
        progId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        buildDurationMs: 2.1,
        signDurationMs: 0.8,
      }),
    };

    const controller = new ExecutionController({
      transactionBuilder: mockBuilder,
      dispatcher: mockDispatcher,
      transactionMonitor: mockMonitor,
      wallet: dummyWallet,
      isPaperTrading: false, // LIVE mode
      defaultPriorityFee: 8333,
      defaultJitoTipLamports: 10_000_000,
      defaultSlippageBps: 1500,
    });

    const fill = await controller.buy({
      mint: dummyWallet.publicKey.toBase58(),
      solAmount: 0.1,
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      priorityFee: 8333,
      jitoTipLamports: 10_000_000,
    });

    test('1.1: Live buy fill sets mode to LIVE', fill.mode === 'LIVE');
    test('1.2: Live buy fill accurately reports actualBuyCost including gas + tip',
      fill.actualBuyCost > 0.1 && fill.actualBuyCost === fill.totalSolSpent,
      `Expected > 0.1 SOL, got ${fill.actualBuyCost}`);
    test('1.3: Live buy fill reports priorityFee and jitoTip breakdown',
      fill.jitoTip === 0.01 && fill.priorityFee > 0 && fill.actualTransactionFees === 0.000005,
      `jitoTip: ${fill.jitoTip}, priorityFee: ${fill.priorityFee}`);
    test('1.4: Live buy fill retains route', fill.route === 'JITO:SENDTRANSACTION');
  }

  // -------------------------------------------------------------
  // TEST 2: Entry Queue Revalidation Enforces CRITICAL Coordination Risk
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: Entry Queue Revalidation Blocks CRITICAL Sybil Cartels ---');
  {
    const orch = new Orchestrator({
      autoBuyEnabled: true,
      tradeCooldownMs: 0,
      maxConcurrentPositions: 10,
    });
    orch.lastTradeTime = 0;

    const testMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(testMint);
    rec.name = 'CartelCoin';
    rec.stage1_narrative = { passed: true, score: 85 };
    rec.stage2_moneyFlow = { passed: true, score: 80 };
    rec.stage3_pattern = { patternTriggered: true, score: 90 };
    
    // Cluster risk escalated to CRITICAL while queued (with 55% share, so isHardVeto is false)
    rec.buyerQuality = {
      coordinationRisk: 'CRITICAL',
      isHardVeto: false,
      reasons: ['CRITICAL SYBIL CLUSTER: 5 wallets control 55% volume'],
    };

    orch.tokens.set(testMint, rec);
    orch.entryQueue = [
      { mint: testMint, queuedAt: Date.now(), breakoutPriceSol: 0.00000003 },
    ];

    await orch._processEntryQueue();

    test('2.1: Entry queue revalidation rejects CRITICAL coordination risk',
      rec.state === TokenState.REJECTED,
      `State was: ${rec.state}`);
    test('2.2: Rejection reason references BUYER_QUALITY_VETO',
      rec.rejectionReason.includes('BUYER_QUALITY_VETO'),
      `Reason: ${rec.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // TEST 3: DevWatcher Unsubscribed on Position Closure
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: DevWatcher Unsubscribed on Position Closure ---');
  {
    let unwatchDevCalled = false;
    let unwatchedMint = null;

    const mockDevWatcher = {
      unwatchDev: (mint) => {
        unwatchDevCalled = true;
        unwatchedMint = mint;
      },
    };

    const mockCurveWatcher = {
      unwatch: () => {},
    };

    const orch = new Orchestrator({ autoBuyEnabled: false });
    orch.devWatcher = mockDevWatcher;
    orch.curveWatcher = mockCurveWatcher;

    const testMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(testMint);
    rec.state = TokenState.POSITION_OPEN;
    orch.tokens.set(testMint, rec);

    orch.handlePositionClosed({
      mint: testMint,
      reason: 'TAKE_PROFIT_1.35X',
      txHash: 'sig_sell_close_123',
    });

    test('3.1: TokenRecord transitions to CLOSED', rec.state === TokenState.CLOSED);
    test('3.2: devWatcher.unwatchDev is invoked for the closed mint',
      unwatchDevCalled && unwatchedMint === testMint,
      `unwatchDevCalled: ${unwatchDevCalled}, mint: ${unwatchedMint}`);
  }

  // -------------------------------------------------------------
  // TEST 4: CandleBuilder Synthesizes Gap Candles When History Is Full (50 candles)
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: CandleBuilder Synthesis at Maximum Capacity ---');
  {
    const cb = new CandleBuilder(15); // 15-second candles
    const startMs = 1700000000000;

    // Fill 50 closed candles (51 ticks across 51 buckets to close 50 candles)
    for (let i = 0; i <= 50; i++) {
      cb.addTick(0.00000003 + (i * 0.000000001), 1.0, startMs + (i * 15000));
    }
    test('4.1: Candle history reaches 50 candles', cb.getClosedCandles().length === 50);

    // Simulate 45s idle gap (3 missed 15s buckets)
    const gapMs = startMs + (51 * 15000) + (45000);
    cb.addTick(0.000000035, 1.5, gapMs);

    const closed = cb.getClosedCandles();
    test('4.2: Closed candles count stays bounded at 50', closed.length === 50);

    // Verify time continuity across last 3 candles
    const patternResult = evaluateThreeCandlePattern(closed, { timeframeMs: 15000 });
    test('4.3: Gap was filled with synthetic flat bars without triggering DISCONTINUOUS_CANDLES error',
      patternResult.stage !== 'DISCONTINUOUS_CANDLES',
      `Result stage: ${patternResult.stage}, reason: ${patternResult.reason}`);
  }

  // -------------------------------------------------------------
  // TEST 5: SmartAgent Non-Blocking State Persistence
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: SmartAgent Non-Blocking State Persistence ---');
  {
    const agent = new SmartAgent({ learningEnabled: true });
    agent.learnFromTrade({
      mint: Keypair.generate().publicKey.toBase58(),
      name: 'WinCoin',
      finalPnlPercent: 35.0,
      reason: 'TAKE_PROFIT_1.35X',
      devPercent: 1.5,
      uniqueBuyersCount: 12,
      entryScore: 88,
    });

    test('5.1: SmartAgent records experience and increments metrics', agent.totalWins >= 1);
    test('5.2: Adaptive parameters remain valid numbers',
      Number.isFinite(agent.effectiveMinCompositeScore) &&
      Number.isFinite(agent.effectiveMaxDevHolding));
  }

  // -------------------------------------------------------------
  // TEST 6: Bundle Metrics Safety Veto Cleans Up Watchers
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: Bundle Metrics Safety Veto Cleans Up Watchers ---');
  {
    let unwatchCalled = false;
    let unwatchDevCalled = false;
    const testMint = Keypair.generate().publicKey.toBase58();

    const orch = new Orchestrator({ autoBuyEnabled: false });
    orch.curveWatcher = { unwatch: (m) => { if (m === testMint) unwatchCalled = true; } };
    orch.devWatcher = { 
      unwatchDev: (m) => { if (m === testMint) unwatchDevCalled = true; },
      isKnownRugger: () => false,
    };

    const rec = new TokenRecord(testMint);
    rec.name = 'BundleRug';
    rec.state = TokenState.MONEY_FLOW_WATCH;
    orch.tokens.set(testMint, rec);

    // Bundle update comes in with massive bundle percent (> 20%) that triggers hard veto
    orch.handleBundleMetricsUpdated({
      mint: testMint,
      bundlePercent: 45.0,
      bundledBuysCount: 8,
    });

    test('6.1: TokenRecord transitions to REJECTED on bundle veto', rec.state === TokenState.REJECTED);
    test('6.2: curveWatcher.unwatch is invoked on bundle veto', unwatchCalled);
    test('6.3: devWatcher.unwatchDev is invoked on bundle veto', unwatchDevCalled);
  }

  // -------------------------------------------------------------
  // TEST 7: PositionManager Preserves buyTxHash in Closed Trade Records
  // -------------------------------------------------------------
  console.log('\n--- TEST 7: PositionManager Preserves buyTxHash in Closed Trade Records ---');
  {
    const posMgr = new PositionManager(null, { autoBuyEnabled: false });
    const testMint = Keypair.generate().publicKey.toBase58();
    const buyTxHash = 'sig_test_buy_hash_xyz_999';

    const pos = posMgr.openPosition({
      mint: testMint,
      spotPriceSol: 0.00000003,
      actualBuyCost: 0.105,
      solSpent: 0.1,
      actualTransactionFees: 0.000005,
      priorityFee: 0.00001,
      jitoTip: 0.005,
      rawTokensReceived: '3000000000000',
      tokensReceived: 3000000,
      expectedTokensReceived: 3000000,
      txHash: buyTxHash,
      timestamp: new Date().toISOString(),
    }, { name: 'AuditCoin', symbol: 'AUD' });

    test('7.1: Open position stores buyTxHash', pos.buyTxHash === buyTxHash);

    // Close position directly
    await posMgr.closePositionDirect(testMint, 'TEST_CLOSE');

    const closedRecord = posMgr.tradeHistory.find(t => t.mint === testMint);
    test('7.2: Closed tradeRecord preserves buyTxHash', closedRecord && closedRecord.buyTxHash === buyTxHash,
      `Recorded buyTxHash: ${closedRecord?.buyTxHash}`);
    test('7.3: Closed tradeRecord preserves actualBuyCost', closedRecord && closedRecord.actualBuyCost === 0.105,
      `Recorded actualBuyCost: ${closedRecord?.actualBuyCost}`);
  }

  // -------------------------------------------------------------
  // TEST 8: canEnterTrade Hard-Blocks devSoldAny and >35% Supply Concentration
  // -------------------------------------------------------------
  console.log('\n--- TEST 8: canEnterTrade Hard-Blocks devSoldAny & High Supply Concentration ---');
  {
    const orch = new Orchestrator({ autoBuyEnabled: false });
    const mint1 = Keypair.generate().publicKey.toBase58();
    const rec1 = new TokenRecord(mint1);
    rec1.stage1_narrative = { passed: true, score: 80 };
    rec1.stage2_moneyFlow = { passed: true, score: 80 };
    rec1.stage3_pattern = { patternTriggered: true, score: 90 };
    rec1.devSoldAny = true; // Dev sold tokens into the market!

    const gate1 = orch.canEnterTrade(rec1);
    test('8.1: canEnterTrade blocks entry if devSoldAny is true',
      gate1.allow === false && gate1.reason === 'DEV_SOLD_INTO_MARKET',
      `Gate result: ${JSON.stringify(gate1)}`);

    const mint2 = Keypair.generate().publicKey.toBase58();
    const rec2 = new TokenRecord(mint2);
    rec2.stage1_narrative = { passed: true, score: 80 };
    rec2.stage2_moneyFlow = { passed: true, score: 80 };
    rec2.stage3_pattern = { patternTriggered: true, score: 90 };
    rec2.devSoldAny = false;
    rec2.topHoldersPercent = 42.5; // Top holders control 42.5% (> 35%)

    const gate2 = orch.canEnterTrade(rec2);
    test('8.2: canEnterTrade blocks entry if topHoldersPercent > 35%',
      gate2.allow === false && gate2.reason === 'HIGH_SUPPLY_CONCENTRATION',
      `Gate result: ${JSON.stringify(gate2)}`);
  }

  // -------------------------------------------------------------
  // TEST 9: Entry Queue Revalidation Blocks When Daily Loss Cap Exceeded
  // -------------------------------------------------------------
  console.log('\n--- TEST 9: Entry Queue Revalidation Blocks When Daily Loss Cap Exceeded ---');
  {
    const mockPosMgr = {
      isDailyLossExceeded: () => true, // Daily loss cap reached
      positions: new Map(),
    };

    const orch = new Orchestrator({
      autoBuyEnabled: true,
      tradeCooldownMs: 0,
      maxConcurrentPositions: 10,
    });
    orch.positionManager = mockPosMgr;
    orch.lastTradeTime = 0;

    const testMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(testMint);
    rec.name = 'LossCappedCoin';
    rec.stage1_narrative = { passed: true, score: 85 };
    rec.stage2_moneyFlow = { passed: true, score: 80 };
    rec.stage3_pattern = { patternTriggered: true, score: 90 };

    orch.tokens.set(testMint, rec);
    orch.entryQueue = [
      { mint: testMint, queuedAt: Date.now(), breakoutPriceSol: 0.00000003 },
    ];

    await orch._processEntryQueue();

    test('9.1: Queued entry rejected when Daily Loss Cap exceeded',
      rec.state === TokenState.REJECTED,
      `State was: ${rec.state}`);
    test('9.2: Rejection reason references DAILY_LOSS_CAP_EXCEEDED',
      rec.rejectionReason.includes('DAILY_LOSS_CAP_EXCEEDED'),
      `Reason: ${rec.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // TEST 10: devWatcher.isSafe Resolves Creator from Record When Argument Omitted
  // -------------------------------------------------------------
  console.log('\n--- TEST 10: devWatcher.isSafe Resolves Creator Fallback ---');
  {
    const devWatcher = new DevWatcher(null, null);
    const ruggerCreator = Keypair.generate().publicKey.toBase58();
    devWatcher.flagRugger(ruggerCreator);

    const testMint = Keypair.generate().publicKey.toBase58();
    devWatcher.monitoredDevs.set(testMint, {
      creatorPubkey: new PublicKey(ruggerCreator),
      state: 'KNOWN',
      lastBalance: 1000000n,
      peakBalance: 1000000n,
      cumulativeDumpedTokens: 0n,
    });

    // Call isSafe WITHOUT passing creatorAddress (only mintAddress)
    const safeResult = devWatcher.isSafe(testMint);
    test('10.1: isSafe resolves creator from monitoredDevs and flags known rugger',
      safeResult === false,
      `safeResult was: ${safeResult}`);
  }

  // -------------------------------------------------------------
  // TEST 11: curveWatcher.stop Cleans Up Resources
  // -------------------------------------------------------------
  console.log('\n--- TEST 11: curveWatcher.stop Cleans Up Resources ---');
  {
    const cw = new BondingCurveWatcher(null, null);
    test('11.1: curveWatcher has active intervals after creation',
      cw.healthCheckInterval !== null || cw.pollInterval !== null);

    cw.stop();
    test('11.2: curveWatcher.stop clears pollInterval', cw.pollInterval === null);
    test('11.3: curveWatcher.stop clears healthCheckInterval', cw.healthCheckInterval === null);
    test('11.4: curveWatcher.stop clears ws connection', cw.ws === null);
  }

  console.log('\n================================================================');
  console.log(`🏁 LIVE READINESS VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal Test Exception:', err);
  process.exit(1);
});
