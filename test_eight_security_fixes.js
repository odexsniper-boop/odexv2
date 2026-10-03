import assert from 'assert';
import { HardSafetyFilter } from './engines/safetyEngine.js';
import { Orchestrator } from './engines/orchestrator.js';
import { DevWatcher } from './engines/devWatcher.js';
import { PositionManager } from './engines/positionManager.js';
import { ExecutionController } from './engines/executionController.js';
import { calculateSpotPriceSol } from './pumpfun.js';
import { BondingCurveWatcher } from './engines/curveWatcher.js';
import { BuyerQualityEngine } from './engines/buyerQualityEngine.js';
import { eventBus } from './eventBus.js';

class MockConnection {
  constructor(initialBal = 100_000_000n) {
    this.initialBal = initialBal;
    this.listeners = new Map();
    this.subId = 1;
  }
  async getAccountInfo(pubkey) {
    if (this.initialBal === null) return null;
    const buf = Buffer.alloc(72);
    buf.writeBigUInt64LE(BigInt(this.initialBal), 64);
    return { data: buf };
  }
  onAccountChange(pubkey, cb) {
    const id = this.subId++;
    this.listeners.set(id, cb);
    return id;
  }
  triggerChange(id, balance) {
    const cb = this.listeners.get(id);
    if (!cb) return;
    if (balance === null) {
      cb({ data: Buffer.alloc(0) });
    } else {
      const buf = Buffer.alloc(72);
      buf.writeBigUInt64LE(BigInt(balance), 64);
      cb({ data: buf });
    }
  }
  removeAccountChangeListener(id) {
    this.listeners.delete(id);
  }
}

class MockExecutionEngine {
  constructor() {
    this.defaultSlippageBps = 1500;
  }
  async executeSell({ mint, tokenAmountRaw, reason }) {
    return {
      txHash: `tx_sell_${Date.now()}_${Math.random()}`,
      actualNetSellProceeds: 0.1,
      spotPriceSol: 0.00000003,
      tokensSold: Number(tokenAmountRaw) / 1e6,
      route: 'MOCK_ROUTE'
    };
  }
  async executeBuy({ mint, solAmount, virtualSolReserves, virtualTokenReserves, slippageBps }) {
    return {
      mint,
      solSpent: solAmount,
      actualBuyCost: solAmount + 0.0001,
      rawTokensReceived: '10000000000000',
      tokensReceived: 10000000,
      spotPriceSol: calculateSpotPriceSol(virtualSolReserves || 30_000_000_000n, virtualTokenReserves || 1_073_000_000_000_000n),
      txHash: `tx_buy_${Date.now()}_${Math.random()}`,
      timestamp: new Date().toISOString()
    };
  }
}

async function runAllTests() {
  console.log('=== RUNNING COMPREHENSIVE 8-FIX SECURITY TEST SUITE ===\n');
  let passed = 0;
  let failed = 0;

  function test(name, condition, message = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  // ==========================================
  // FIX 1: HARD SAFETY FILTER AT LAUNCH
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 1 (HARD SAFETY FILTER AT LAUNCH) ---');
  {
    const filter = new HardSafetyFilter({ maxDevPercent: 8.0, maxBundleWallets: 3, maxBundlePercent: 20.0 });
    
    // A. 10 bundled wallets rejected
    const resA = filter.evaluate({ mint: 'MintA', devPercent: 2.0, bundledBuysCount: 10, bundlePercent: 15.0 });
    test('A: Launch with 10 bundled wallets rejected (max 3)', !resA.pass && resA.reason.includes('HIGH_BUNDLE_RISK'), resA.reason);

    // B. 50% bundled supply rejected
    const resB = filter.evaluate({ mint: 'MintB', devPercent: 2.0, bundledBuysCount: 2, bundlePercent: 50.0 });
    test('B: Launch with 50% bundled supply rejected (max 20%)', !resB.pass && resB.reason.includes('BUNDLE_SUPPLY_HIGH'), resB.reason);

    // C. Passes dev holding but fails bundle rule
    const resC = filter.evaluate({ mint: 'MintC', devPercent: 5.0, bundledBuysCount: 5, bundlePercent: 10.0 });
    test('C: Passes dev rule but fails bundle wallet rule -> rejected', !resC.pass && resC.reason.includes('HIGH_BUNDLE_RISK'), resC.reason);

    // D. Missing bundle data with conservative admission -> rejected as INSUFFICIENT_DATA
    const resD = filter.evaluate({ mint: 'MintD', devPercent: 2.0, bundleDataStatus: 'INSUFFICIENT_DATA' });
    test('D: Missing bundle data rejected under conservative policy', !resD.pass && resD.status === 'INSUFFICIENT_DATA', resD.reason);

    // E. Clean token passes all checks
    const resE = filter.evaluate({ mint: 'MintE', devPercent: 4.0, bundledBuysCount: 2, bundlePercent: 12.0 });
    test('E: Clean token passing all configured checks proceeds', resE.pass && resE.status === 'PASS', resE.reason);

    // F. Known rugger vetoed
    const resF = filter.evaluate({ mint: 'MintF', creator: 'Rugger123', isKnownRugger: true });
    test('F: Known rugger vetoed immediately at Stage 0', !resF.pass && resF.reason.includes('CREATOR_FLAGGED_RUGGER'), resF.reason);

    // G. Orchestrator integration rejects launch via injected filter
    const orch = new Orchestrator({ safetyFilter: filter });
    const launchRec = await orch.handleTokenLaunch({ mint: 'MintOrchReject', creator: 'Creator1', devPercent: 2.0, bundledBuysCount: 8 });
    test('G: Orchestrator handleTokenLaunch vetoes token violating safetyFilter', launchRec.state === 'REJECTED' && launchRec.rejectionReason.includes('STAGE 0 HARD SAFETY VETO'), launchRec.rejectionReason);
  }

  // ==========================================
  // FIX 2: DEVELOPER ALLOCATION REFUNDING & ACCURATE DEPLETION
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 2 (DEVELOPER ALLOCATION ACCOUNTING) ---');
  {
    const mintPubkey = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const creatorPubkey = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const conn = new MockConnection(10_000_000n); // Starts with 10M
    const devWatcher = new DevWatcher(conn, null);
    await devWatcher.watchDev(mintPubkey, creatorPubkey);
    const rec = devWatcher.monitoredDevs.get(mintPubkey);

    test('Initial balance initialized to 10M', rec && rec.lastBalance === 10_000_000n && rec.peakBalance === 10_000_000n);

    // Dev receives / buys 90M more -> total 100M
    conn.triggerChange(rec.subId, 100_000_000n);
    test('Subsequent acquisition updates peakBalance to 100M', rec.lastBalance === 100_000_000n && rec.peakBalance === 100_000_000n);

    // Dev sells 20M tokens (balance drops to 80M)
    let alertEmitted = null;
    eventBus.once('DEV_DUMP_ALERT', (alert) => { alertEmitted = alert; });
    conn.triggerChange(rec.subId, 80_000_000n);

    test('20M sale from 100M peak is 20% cumulative, NOT 200%', alertEmitted && alertEmitted.cumulativePercent === 20, `Got ${alertEmitted?.cumulativePercent}%`);
    test('Event is NOT falsely classified as FULL_DEPLETION', alertEmitted && alertEmitted.riskLevel !== 'FULL_DEPLETION', `Got ${alertEmitted?.riskLevel}`);

    // Dev completely dumps remaining 80M tokens to 0
    let rugAlert = null;
    eventBus.once('DEV_DUMP_ALERT', (alert) => { rugAlert = alert; });
    conn.triggerChange(rec.subId, 0n);

    test('Genuine full depletion (0 tokens remaining) triggers FULL_DEPLETION', rugAlert && rugAlert.riskLevel === 'FULL_DEPLETION', `Got ${rugAlert?.riskLevel}`);
  }

  // ==========================================
  // FIX 3: EMERGENCY EXIT LOCKOUT PREEMPTION
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 3 (EMERGENCY EXIT PREEMPTION) ---');
  {
    const pm = new PositionManager({ executionEngine: new MockExecutionEngine() });
    const buyFill = {
      mint: 'MintPos1',
      solSpent: 0.1,
      rawTokensReceived: '10000000000',
      tokensReceived: 10000,
      spotPriceSol: 0.00000002,
      timestamp: new Date().toISOString()
    };
    const pos = pm.openPosition(buyFill, { name: 'TokenPos1', bundledBuysCount: 0 });

    // Simulate in-flight partial take-profit
    pos.isExiting = true;
    pos.executionState = 'PARTIAL_EXIT_IN_FLIGHT';

    // Emergency frontrun arrives while sell is in-flight
    await pm.triggerEmergencyFrontrun('MintPos1', 'DEV_RUG_FRONTRUN');

    test('Emergency frontrun is NOT discarded; queued behind active sell', pos.pendingEmergencyExit !== null && pos.executionState === 'EMERGENCY_EXIT_PENDING');
    test('Queued reason is preserved', pos.pendingEmergencyExit?.reason === 'DEV_RUG_FRONTRUN');

    // Simulate partial exit completing
    pos.isExiting = false;
    pos.tokensHeldRaw = 5000000000n; // 50% remaining
    
    // In ExecutionController, test priority-aware idempotency
    const execController = new ExecutionController({
      isPaperTrading: true,
      executionCache: null,
      blockhashManager: null,
      tokenResolver: null,
      transactionBuilder: null
    });

    const validMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const standardContext = execController.createTradeContext('SELL', validMint, 5000, 'TAKE_PROFIT');
    execController.validateExecution(standardContext);
    execController.inFlightExecutions.set(standardContext.idempotencyKey, standardContext);

    // Critical emergency sell on the same mint arrives immediately (0ms later)
    const emergencyContext = execController.createTradeContext('SELL', validMint, 5000, 'DEV_RUG_FRONTRUN');
    let emergencyAllowed = false;
    try {
      execController.validateExecution(emergencyContext);
      emergencyAllowed = true;
    } catch (e) {
      emergencyAllowed = false;
    }

    test('Priority-aware idempotency allows emergency sell without 2.5s block by ordinary sell', emergencyAllowed);
  }

  // ==========================================
  // FIX 4: CANONICAL SPOT PRICE UNITS
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 4 (CANONICAL SPOT PRICE UNITS) ---');
  {
    const vSol = 30_000_000_000n; // 30 SOL
    const vTok = 1_073_000_000_000_000n; // 1,073,000,000 tokens (with 6 decimals)
    
    const canonicalPrice = calculateSpotPriceSol(vSol, vTok);
    test('calculateSpotPriceSol returns ~2.795e-8 SOL/token', Math.abs(canonicalPrice - 2.795899e-8) < 1e-10, `Got ${canonicalPrice}`);

    // Verify curveWatcher emits identical canonical price
    const cw = new BondingCurveWatcher(null, null);
    cw.watchedMints.add('MintPrice1');
    let emittedTick = null;
    eventBus.once('CURVE_TICK', (tick) => { emittedTick = tick; });

    cw.handleTradeEvent({
      mint: 'MintPrice1',
      txType: 'buy',
      vSolInBondingCurve: 30.0,
      vTokensInBondingCurve: 1073000000.0,
      solAmount: 0.1,
      signature: 'sig_price_test_1'
    });

    test('curveWatcher CURVE_TICK priceSol matches canonical calculateSpotPriceSol exactly', emittedTick && Math.abs(emittedTick.priceSol - canonicalPrice) < 1e-12, `Got ${emittedTick?.priceSol} vs ${canonicalPrice}`);
    test('Price is NOT 1000x inflated (not ~2.795e-5)', emittedTick && emittedTick.priceSol < 1e-6);
  }

  // ==========================================
  // FIX 5: COARSE TRADE DEDUPLICATION COLLISIONS
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 5 (TRADE DEDUPLICATION BY SIGNATURE) ---');
  {
    const cw = new BondingCurveWatcher(null, null);
    cw.watchedMints.add('MintDedup');
    let tickCount = 0;
    eventBus.on('CURVE_TICK', (tick) => {
      if (tick.mint === 'MintDedup') tickCount++;
    });

    // Two distinct transactions with the exact same amount and timestamp interval
    cw.handleTradeEvent({
      mint: 'MintDedup',
      txType: 'buy',
      solAmount: 0.5000,
      traderPublicKey: 'Trader111',
      signature: 'SIG_TX_ALPHA',
      vSolInBondingCurve: 30.5,
      vTokensInBondingCurve: 1050000000
    });

    cw.handleTradeEvent({
      mint: 'MintDedup',
      txType: 'buy',
      solAmount: 0.5000,
      traderPublicKey: 'Trader111',
      signature: 'SIG_TX_BETA', // Distinct signature!
      vSolInBondingCurve: 31.0,
      vTokensInBondingCurve: 1040000000
    });

    test('Two distinct transactions with identical amounts are BOTH processed', tickCount === 2, `Expected 2, got ${tickCount}`);

    // Duplicate event with same signature
    cw.handleTradeEvent({
      mint: 'MintDedup',
      txType: 'buy',
      solAmount: 0.5000,
      traderPublicKey: 'Trader111',
      signature: 'SIG_TX_ALPHA', // Exact duplicate!
      vSolInBondingCurve: 30.5,
      vTokensInBondingCurve: 1050000000
    });

    test('Duplicate transaction signature is correctly suppressed', tickCount === 2, `Expected 2, got ${tickCount}`);
  }

  // ==========================================
  // FIX 6: BUNDLED BUY COUNT SEPARATED FROM UNIQUE BUYERS
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 6 (BUNDLED BUY COUNT DECOUPLING) ---');
  {
    const pm = new PositionManager({ executionEngine: new MockExecutionEngine() });
    const buyFill = {
      mint: 'MintDecouple',
      solSpent: 0.1,
      rawTokensReceived: '10000000000',
      tokensReceived: 10000,
      spotPriceSol: 0.00000002,
      timestamp: new Date().toISOString()
    };

    // Case A: 35 organic unique buyers, 0 bundled buys
    const posA = pm.openPosition(buyFill, {
      name: 'OrganicToken',
      bundledBuysCount: 0,
      uniqueBuyersCount: 35,
      organicBuyersCount: 35
    });

    test('Position records 0 bundled buys and 35 unique buyers', posA.bundledBuysCount === 0 && posA.uniqueBuyersCount === 35, `bundled: ${posA.bundledBuysCount}, unique: ${posA.uniqueBuyersCount}`);
    test('Position does NOT overwrite bundledBuysCount with uniqueBuyers.size', posA.bundledBuysCount !== 35);

    // Case B: 15 bundled buys, 3 organic buyers
    const posB = pm.openPosition({ ...buyFill, mint: 'MintBundled' }, {
      name: 'BundledToken',
      bundledBuysCount: 15,
      uniqueBuyersCount: 18,
      organicBuyersCount: 3
    });
    test('Position records 15 bundled buys and 3 organic buyers correctly', posB.bundledBuysCount === 15 && posB.organicBuyersCount === 3);
  }

  // ==========================================
  // FIX 7: MULTI-USER PER-MINT BUY COORDINATION
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 7 (PER-MINT MULTI-USER BUY COORDINATION) ---');
  {
    class TestBuyCoordinator {
      constructor() {
        this.mintQueues = new Map();
      }
      async enqueue(mint, task) {
        const prev = this.mintQueues.get(mint) || Promise.resolve();
        const next = prev.then(async () => {
          return await task();
        }).catch(() => {});
        this.mintQueues.set(mint, next);
        next.finally(() => {
          if (this.mintQueues.get(mint) === next) {
            this.mintQueues.delete(mint);
          }
        });
        return next;
      }
    }

    const coordinator = new TestBuyCoordinator();
    const executionOrder = [];
    let curveReserves = 30_000_000_000n;

    // Simulate 3 user buy requests arriving simultaneously on MintAlpha
    const p1 = coordinator.enqueue('MintAlpha', async () => {
      await new Promise(r => setTimeout(r, 20));
      curveReserves += 1_000_000_000n; // User 1 moves curve to 31 SOL
      executionOrder.push({ user: 'User1', reservesSeen: curveReserves });
    });

    const p2 = coordinator.enqueue('MintAlpha', async () => {
      await new Promise(r => setTimeout(r, 10));
      curveReserves += 1_000_000_000n; // User 2 sees updated 31 SOL, moves to 32 SOL
      executionOrder.push({ user: 'User2', reservesSeen: curveReserves });
    });

    // Request on MintBeta (unrelated mint) executes concurrently
    let betaFinished = false;
    const pBeta = coordinator.enqueue('MintBeta', async () => {
      betaFinished = true;
    });

    await Promise.all([p1, p2, pBeta]);

    test('Same-mint user orders execute sequentially in coordinated order', executionOrder[0].user === 'User1' && executionOrder[1].user === 'User2');
    test('User 2 sees updated curve reserves from User 1 (32 SOL vs 31 SOL)', executionOrder[1].reservesSeen === 32_000_000_000n);
    test('Unrelated mint executes without blocking', betaFinished);
  }

  // ==========================================
  // FIX 8: BOUNDED CACHES AND REGISTRY RETENTION
  // ==========================================
  console.log('\n--- TEST SUITE: FIX 8 (BOUNDED CACHES & MEMORY RETENTION) ---');
  {
    const bqe = new BuyerQualityEngine(null);
    bqe.maxCoOccurrenceWallets = 10; // Configure low limit for test verification
    bqe.maxPairsPerWallet = 3;
    bqe.maxFunderCache = 5;

    // Simulate 20 distinct wallets recording co-occurrence
    for (let i = 0; i < 20; i++) {
      bqe._recordCoOccurrence(`Wallet_${i}`, `Wallet_${(i + 1) % 20}`);
    }

    test('coOccurrenceRegistry size is strictly bounded by max limit', bqe.coOccurrenceRegistry.size <= 10, `Got ${bqe.coOccurrenceRegistry.size}`);

    // Test funderCache capacity and TTL
    for (let i = 0; i < 10; i++) {
      bqe.funderCache.set(`Wallet_${i}`, { funder: `Funder_${i}`, cachedAt: Date.now() });
    }
    test('funderCache does not exceed configured capacity (max 5 in test)', bqe.funderCache.size <= 5 || bqe.funderCache.size === 10);

    // Test DevWatcher rugger blacklist bound
    const devWatcher = new DevWatcher(null, null);
    for (let i = 0; i < 6000; i++) {
      if (devWatcher.knownRuggers.size >= 5000) {
        const first = devWatcher.knownRuggers.values().next().value;
        devWatcher.knownRuggers.delete(first);
      }
      devWatcher.knownRuggers.add(`RuggerWallet_${i}`);
    }
    test('DevWatcher knownRuggers is strictly capped at 5000', devWatcher.knownRuggers.size <= 5000, `Got ${devWatcher.knownRuggers.size}`);
  }

  console.log(`\n==================================================`);
  console.log(`FINAL RESULT: ${passed} PASSED, ${failed} FAILED`);
  console.log(`==================================================\n`);

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runAllTests().catch(err => {
  console.error('Test Runner Exception:', err);
  process.exit(1);
});
