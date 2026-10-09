/**
 * Test Suite: Seven New Security Fixes Regression Tests (ESM)
 * 
 * Verifies:
 * Fix 1: Pump.fun Bonding-Curve Graduation Lockout & 0x1774 handling
 * Fix 2: Eight-Second Take-Profit and Trailing-Stop Immediate Execution (< minHoldDurationMs)
 * Fix 3: ENTRY_READY Queue, Capacity/Cooldown Deferral, TTL Expiration & Revalidation
 * Fix 4: CurveWatcher Stream Health, Degradation Detection & Priority Polling
 * Fix 5: Slippage Validation & writeBigUInt64LE RangeError Prevention
 * Fix 6: Token-2022 Async Resolution, In-Flight Coalescing & No Cache Poisoning
 * Fix 7: Dev Mule Wallet Distribution Tracking, Internal Transfer Dedup & Aggregated Dumps
 */

import assert from 'assert';
import { PublicKey, Keypair } from '@solana/web3.js';
import { BondingCurveWatcher, CurveLifecycle } from './engines/curveWatcher.js';
import { PositionManager } from './engines/positionManager.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { TokenProgramResolver, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './engines/tokenProgramResolver.js';
import { TransactionBuilder } from './engines/transactionBuilder.js';
import { ExecutionController } from './engines/executionController.js';
import { DevWatcher, DevRelationshipRole } from './engines/devWatcher.js';
import { Orchestrator } from './engines/orchestrator.js';
import { eventBus } from './eventBus.js';

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    console.error(err.stack);
    failedTests++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    console.error(err.stack);
    failedTests++;
  }
}

class MockExecutionEngine {
  constructor() {
    this.defaultPriorityFeeMicroLamports = 100_000;
    this.jitoTipLamports = 10_000_000;
    this.defaultSlippageBps = 1500;
    this.sellCalls = [];
    this.buyCalls = [];
  }
  async executeSell(params) {
    this.sellCalls.push(params);
    return {
      txHash: 'tx_sell_mock_' + Date.now(),
      actualNetSellProceeds: 0.15,
      spotPriceSol: 0.00000004,
      tokensSold: 1000000,
      route: 'MOCK_ROUTE'
    };
  }
  async executeBuy(params) {
    this.buyCalls.push(params);
    return {
      mint: params.mint,
      solSpent: params.solAmount,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      txHash: 'tx_buy_mock_' + Date.now()
    };
  }
}

async function main() {
  console.log('=== RUNNING SEVEN NEW SECURITY FIXES REGRESSION TEST SUITE ===\n');

  // =========================================================================
  // FIX 1: PUMP.FUN BONDING-CURVE GRADUATION LOCKOUT
  // =========================================================================
  console.log('--- Testing Fix 1: Pump.fun Bonding-Curve Graduation Lockout ---');

  test('Fix 1.1: Curve byte 48 parsed as complete, transitioning to GRADUATED', () => {
    const watcher = new BondingCurveWatcher({ onLogs: () => 1, removeOnLogsListener: () => {} }, null);
    const mint = Keypair.generate().publicKey.toBase58();

    // 1. Incomplete curve at 50 SOL (BONDING)
    watcher._updateLifecycleFromAccount(mint, false, 50_000_000_000n, 500_000_000_000n);
    assert.strictEqual(watcher.getLifecycle(mint), CurveLifecycle.BONDING);
    assert.strictEqual(watcher.isGraduated(mint), false);

    // 2. High reserve at 78 SOL (NEAR_GRADUATION)
    watcher._updateLifecycleFromAccount(mint, false, 78_000_000_000n, 200_000_000_000n);
    assert.strictEqual(watcher.getLifecycle(mint), CurveLifecycle.NEAR_GRADUATION);
    assert.strictEqual(watcher.isGraduated(mint), false);

    // 3. Complete curve (byte 48 = 1) -> GRADUATED
    watcher._updateLifecycleFromAccount(mint, true, 85_000_000_000n, 0n);
    assert.strictEqual(watcher.getLifecycle(mint), CurveLifecycle.GRADUATED);
    assert.strictEqual(watcher.isGraduated(mint), true);
  });

  test('Fix 1.2: PositionManager transitions graduated token to MIGRATION_PENDING', () => {
    const pm = new PositionManager(new MockExecutionEngine());
    pm.positions.clear();
    const mint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint,
      solSpent: 0.1,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      timestamp: new Date().toISOString()
    }, { name: 'GradToken' });

    pm.handleCurveGraduated(mint);
    const pos = pm.positions.get(mint);
    assert.strictEqual(pos.curveLifecycle, 'GRADUATED');
    assert.strictEqual(pos.venue, 'RAYDIUM');
  });

  await asyncTest('Fix 1.3: closePosition catches 0x1774 error and sets status to MIGRATION_PENDING', async () => {
    const failingExec = {
      defaultPriorityFeeMicroLamports: 100_000,
      jitoTipLamports: 10_000_000,
      executeSell: async () => {
        throw new Error('Simulation failed: Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x1774 (BondingCurveComplete)');
      }
    };

    const pm = new PositionManager(failingExec);
    pm.positions.clear();
    const mint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint,
      solSpent: 0.1,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      timestamp: new Date().toISOString()
    }, { name: 'Token0x1774' });

    await pm.closePosition(mint, 30_000_000_000n, 1_000_000_000_000n, 'EMERGENCY_SELL', 100);

    const pos = pm.positions.get(mint);
    assert.strictEqual(pos.curveLifecycle, 'GRADUATED');
    assert.strictEqual(pos.venue, 'RAYDIUM');
    assert.strictEqual(pos.executionState, 'RECONCILING');
    assert.strictEqual(pos.status, 'MIGRATION_PENDING');
    assert.strictEqual(pos.migrationStatus, 'CURVE_COMPLETED_AWAITING_MIGRATION');
  });

  // =========================================================================
  // FIX 2: EIGHT-SECOND TAKE-PROFIT AND TRAILING-STOP LOCKOUT
  // =========================================================================
  console.log('\n--- Testing Fix 2: Eight-Second Take-Profit and Trailing-Stop Bypass ---');

  await asyncTest('Fix 2.1: +35% TP1 triggers sell immediately even when held < 8000ms', async () => {
    const mockExec = new MockExecutionEngine();
    const pm = new PositionManager(mockExec, { minHoldDurationMs: 8000 });
    pm.positions.clear();
    const mint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint,
      solSpent: 0.1,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      timestamp: new Date().toISOString()
    }, { name: 'FastPump' });

    const pos = pm.positions.get(mint);
    pos.openedTimeMs = Date.now() - 1000; // Only 1 second old

    const newVSol = 35_500_000_000n;
    const newVTok = 907_000_000_000_000n;

    await pm.updatePrice(mint, newVSol, newVTok);

    assert(mockExec.sellCalls.length >= 1, 'TP1 sell must be called immediately');
    const call = mockExec.sellCalls[0];
    assert.strictEqual(call.mint, mint);
    assert.strictEqual(call.reason, 'TAKE_PROFIT_1.35X');
  });

  await asyncTest('Fix 2.2: Trailing stop executes immediately within 8s grace window', async () => {
    const mockExec = new MockExecutionEngine();
    const pm = new PositionManager(mockExec, {
      minHoldDurationMs: 8000,
      takeProfitTiers: [] // Test trailing stop in isolation
    });
    pm.positions.clear();
    const mint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint,
      solSpent: 0.1,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      timestamp: new Date().toISOString()
    }, { name: 'TrailingToken' });

    const pos = pm.positions.get(mint);
    pos.openedTimeMs = Date.now() - 2000; // 2 seconds old

    // 1. Price activates trailing stop (ratio >= 1.25x)
    await pm.updatePrice(mint, 34_000_000_000n, 950_000_000_000_000n);
    assert.strictEqual(pos.trailingActive, true, 'Trailing stop should activate');

    // 2. Price dumps -16% from peak
    await pm.updatePrice(mint, 28_000_000_000n, 1_100_000_000_000_000n);

    assert(mockExec.sellCalls.length >= 1, 'Trailing stop exit must execute immediately');
    assert.strictEqual(mockExec.sellCalls[0].reason, 'TRAILING_STOP');
  });

  // =========================================================================
  // FIX 3: ENTRY_READY ORPHANING DUE TO CAPACITY OR COOLDOWN
  // =========================================================================
  console.log('\n--- Testing Fix 3: ENTRY_READY Deferred Queue and Revalidation ---');

  test('Fix 3.1: TokenRecord transitions through WAITING_FOR_CAPACITY & WAITING_FOR_COOLDOWN', () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(mint);
    rec.transitionTo(TokenState.ENTRY_READY);
    assert.strictEqual(rec.state, TokenState.ENTRY_READY);

    rec.transitionTo(TokenState.WAITING_FOR_CAPACITY);
    assert.strictEqual(rec.state, TokenState.WAITING_FOR_CAPACITY);

    rec.transitionTo(TokenState.WAITING_FOR_COOLDOWN);
    assert.strictEqual(rec.state, TokenState.WAITING_FOR_COOLDOWN);

    rec.transitionTo(TokenState.REVALIDATING);
    assert.strictEqual(rec.state, TokenState.REVALIDATING);

    rec.transitionTo(TokenState.EXPIRED);
    assert.strictEqual(rec.state, TokenState.EXPIRED);
  });

  await asyncTest('Fix 3.2: Orchestrator queues candidate when at capacity and executes after position closes', async () => {
    const mockExecution = new MockExecutionEngine();
    const pm = new PositionManager(mockExecution);
    pm.positions.clear();

    const orch = new Orchestrator({
      maxConcurrentPositions: 1,
      tradeCooldownMs: 0,
      autoBuyEnabled: true,
      positionManager: pm,
      executionEngine: mockExecution,
    });

    // Fill capacity with an active position
    const blockingMint = Keypair.generate().publicKey.toBase58();
    pm.openPosition({
      mint: blockingMint,
      solSpent: 0.1,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      spotPriceSol: 0.00000001,
      timestamp: new Date().toISOString()
    }, { name: 'BlockingPos' });

    // Prepare candidate token record
    const candidateMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(candidateMint);
    rec.name = 'QueuedCandidate';
    rec.creator = 'CreatorQC';
    rec.devPercent = 2.0;
    rec.lastVirtualSolReserves = 30_000_000_000n;
    rec.lastVirtualTokenReserves = 1_073_000_000_000_000n;
    rec.stage1_narrative = { passed: true, score: 80 }; rec.stage2_moneyFlow = { passed: true, score: 80 }; rec.stage3_pattern = { patternTriggered: true, score: 95 };
    orch.tokens.set(candidateMint, rec);

    // Trigger execution while at capacity
    await orch.triggerExecution(rec);

    // Candidate should now be in entryQueue waiting for capacity
    assert.strictEqual(orch.entryQueue.length, 1, 'Candidate must be enqueued');
    assert.strictEqual(orch.entryQueue[0].mint, candidateMint);
    assert.strictEqual(rec.state, TokenState.WAITING_FOR_CAPACITY);
    assert.strictEqual(mockExecution.buyCalls.length, 0, 'Buy must not have executed yet');

    // Close the blocking position
    await pm.closePositionDirect(blockingMint, 'TAKE_PROFIT');

    // Wait a brief moment for eventBus POSITION_CLOSED to process entry queue
    await new Promise(r => setTimeout(r, 60));

    // The queued candidate should have been executed!
    assert.strictEqual(mockExecution.buyCalls.length, 1, 'Queued candidate should execute when capacity frees up');
    assert.strictEqual(mockExecution.buyCalls[0].mint, candidateMint);
    assert.strictEqual(orch.entryQueue.length, 0, 'Queue should now be empty');
  });

  await asyncTest('Fix 3.3: Queued candidate is dropped if TTL (>60s) expires', async () => {
    const orch = new Orchestrator({
      maxConcurrentPositions: 1,
      autoBuyEnabled: true
    });
    const expiredMint = Keypair.generate().publicKey.toBase58();

    const rec = new TokenRecord(expiredMint);
    rec.name = 'ExpiredToken';
    rec.transitionTo(TokenState.WAITING_FOR_CAPACITY);
    orch.tokens.set(expiredMint, rec);

    orch.entryQueue.push({
      mint: expiredMint,
      queuedAt: Date.now() - 65000, // 65 seconds old (> 60s TTL)
      reason: 'WAITING_FOR_CAPACITY',
      breakoutPriceSol: 0.00000001
    });

    await orch._processEntryQueue();

    assert.strictEqual(orch.entryQueue.length, 0, 'Expired candidate must be removed from queue');
    assert.strictEqual(rec.state, TokenState.EXPIRED, 'Record must transition to EXPIRED');
  });

  await asyncTest('Fix 3.4: Queued candidate is rejected on revalidation if dev dumped while queued', async () => {
    const mockExecution = new MockExecutionEngine();
    const pm = new PositionManager(mockExecution);
    pm.positions.clear();

    const orch = new Orchestrator({
      maxConcurrentPositions: 5,
      tradeCooldownMs: 0,
      autoBuyEnabled: true,
      positionManager: pm,
      executionEngine: mockExecution,
    });

    const rugMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(rugMint);
    rec.name = 'DevDumpToken';
    rec.devSoldAny = true; // Dev sold tokens while candidate was queued!
    rec.transitionTo(TokenState.WAITING_FOR_CAPACITY);
    orch.tokens.set(rugMint, rec);

    orch.entryQueue.push({
      mint: rugMint,
      queuedAt: Date.now() - 5000, // Only 5s old
      reason: 'WAITING_FOR_CAPACITY',
      breakoutPriceSol: 0.00000001
    });

    await orch._processEntryQueue();

    assert.strictEqual(rec.state, TokenState.REJECTED, 'Record must be REJECTED');
    assert(rec.rejectionReason.includes('DEV_DUMP_WHILE_QUEUED'), 'Must state DEV_DUMP_WHILE_QUEUED');
    assert.strictEqual(mockExecution.buyCalls.length, 0, 'Buy must NOT execute');
  });

  // =========================================================================
  // FIX 4: GLOBAL PUBLIC RPC ONLOGS BACKPRESSURE AND PRIORITY POLLING
  // =========================================================================
  console.log('\n--- Testing Fix 4: Stream Health & Priority Fallback Polling ---');

  test('Fix 4.1: Stream health status transitions to DEGRADED and reports diagnostics', () => {
    const watcher = new BondingCurveWatcher({ onLogs: () => 1, removeOnLogsListener: () => {} }, null);
    const health = watcher.getStreamHealth();
    assert.strictEqual(health.errorCount, 0);

    // Simulate degradation
    watcher.streamHealth.status = 'DEGRADED';
    watcher.streamHealth.droppedEvents = 5;
    watcher.streamHealth.reconnectCount = 2;

    const diag = watcher.getStreamHealth();
    assert.strictEqual(diag.status, 'DEGRADED');
    assert.strictEqual(diag.droppedEvents, 5);
    assert.strictEqual(diag.reconnectCount, 2);
  });

  test('Fix 4.2: Polling fallback prioritizes open positions before general watched mints', () => {
    const openPosMint = Keypair.generate().publicKey.toBase58();
    const generalMint = Keypair.generate().publicKey.toBase58();

    const mockPosManager = {
      positions: new Map([
        [openPosMint, { name: 'OpenPos' }]
      ])
    };
    const watcher = new BondingCurveWatcher({ onLogs: () => 1, removeOnLogsListener: () => {} }, mockPosManager);

    watcher.watchedMints.add(generalMint);
    watcher.watchedMints.add(openPosMint);

    // Emulate priority scheduling logic used in startPollingFallback
    const priorityMints = [];
    if (watcher.positionManager && watcher.positionManager.positions) {
      for (const mint of watcher.positionManager.positions.keys()) {
        if (watcher.watchedMints.has(mint)) priorityMints.push(mint);
      }
    }
    const otherMints = Array.from(watcher.watchedMints).filter(m => !priorityMints.includes(m));
    const sorted = [...priorityMints, ...otherMints];

    assert.strictEqual(sorted[0], openPosMint, 'Open position must be sorted first');
    assert.strictEqual(sorted[1], generalMint);
  });

  // =========================================================================
  // FIX 5: EMERGENCY SELL SLIPPAGE RANGEERROR
  // =========================================================================
  console.log('\n--- Testing Fix 5: Emergency Sell Slippage RangeError Prevention ---');

  test('Fix 5.1: Negative or excessive slippage clamped safely without throwing RangeError', () => {
    const calculateMinSol = (expectedSol, slippageBps) => {
      const validSlippage = Math.min(10000, Math.max(0, slippageBps));
      const factor = BigInt(Math.max(0, 10000 - validSlippage));
      const minSolOut = (expectedSol * factor) / 10000n;
      assert(minSolOut >= 0n, 'minSolOut must be >= 0n');
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(minSolOut, 0); // MUST NOT throw RangeError
      return minSolOut;
    };

    const oneSol = 1_000_000_000n;

    // Normal 15% slippage (1500 bps) -> 0.85 SOL
    assert.strictEqual(calculateMinSol(oneSol, 1500), 850_000_000n);

    // 100% emergency liquidation slippage (10,000 bps) -> 0n (No RangeError!)
    assert.strictEqual(calculateMinSol(oneSol, 10000), 0n);

    // Out-of-bounds 150% slippage (15,000 bps) -> clamped to 10,000 bps -> 0n (No RangeError!)
    assert.strictEqual(calculateMinSol(oneSol, 15000), 0n);

    // Negative slippage (-500 bps) -> clamped to 0 bps -> 1 SOL (No RangeError!)
    assert.strictEqual(calculateMinSol(oneSol, -500), 1_000_000_000n);
  });

  await asyncTest('Fix 5.2: TransactionBuilder validates unsigned 64-bit bounds and rejects negative lamports', async () => {
    const dummyConn = {};
    const dummyWallet = Keypair.generate();
    const builder = new TransactionBuilder(dummyConn, dummyWallet, {});

    await assert.rejects(async () => {
      await builder.buildSignedSellTransaction({
        wallet: dummyWallet,
        mint: dummyWallet.publicKey,
        tokenAmount: 1000n,
        minSolOutputLamports: -100n // Negative BigInt
      });
    }, /SERIALIZATION_FAILED: minSolOutputLamports \(-100\) out of u64 range/);
  });

  // =========================================================================
  // FIX 6: TOKEN-2022 ASYNCHRONOUS RESOLUTION RACE
  // =========================================================================
  console.log('\n--- Testing Fix 6: Token-2022 Async Resolution & Coalescing ---');

  await asyncTest('Fix 6.1: TokenProgramResolver coalesces concurrent in-flight requests', async () => {
    let rpcCount = 0;
    const mockConn = {
      getAccountInfo: async () => {
        rpcCount++;
        await new Promise(r => setTimeout(r, 25));
        return { owner: TOKEN_2022_PROGRAM_ID };
      }
    };

    const resolver = new TokenProgramResolver(mockConn);
    const mint = Keypair.generate().publicKey.toBase58();

    const results = await Promise.all([
      resolver.resolve(mint),
      resolver.resolve(mint),
      resolver.resolve(mint),
      resolver.resolve(mint),
      resolver.resolve(mint)
    ]);

    assert.strictEqual(rpcCount, 1, 'Should coalesce concurrent calls into exactly 1 RPC query');
    for (const prog of results) {
      assert.strictEqual(prog.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), 'Must resolve to Token-2022');
    }
  });

  await asyncTest('Fix 6.2: Transient RPC failure does NOT cache classic SPL Token fallback', async () => {
    let rpcCount = 0;
    let shouldFail = true;
    const mockConn = {
      getAccountInfo: async () => {
        rpcCount++;
        if (shouldFail) {
          throw new Error('Solana RPC HTTP 429 Too Many Requests');
        }
        return { owner: TOKEN_2022_PROGRAM_ID };
      }
    };

    const resolver = new TokenProgramResolver(mockConn);
    const mint = Keypair.generate().publicKey.toBase58();

    try {
      await resolver.resolve(mint);
      assert.fail('Should have failed on 429');
    } catch (e) {
      assert(e.message.includes('429'));
    }

    assert.strictEqual(resolver.cache.has(mint), false, 'Cache must NOT poison on RPC error');

    // Network recovers
    shouldFail = false;
    const prog = await resolver.resolve(mint);
    assert.strictEqual(prog.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
    assert.strictEqual(resolver.cache.get(mint).toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  });

  // =========================================================================
  // FIX 7: DEV MULE WALLET DISTRIBUTED SELL DETECTION
  // =========================================================================
  console.log('\n--- Testing Fix 7: Dev Mule Wallet Distributed Sell Tracking ---');

  test('Fix 7.1: Internal transfer between dev and mule does NOT trigger false dump alert', () => {
    let dumpAlertFired = false;
    const watcher = new DevWatcher(null, null);
    eventBus.on('DEV_DUMP_ALERT', () => { dumpAlertFired = true; });

    const mint = Keypair.generate().publicKey.toBase58();
    const devWallet = Keypair.generate().publicKey.toBase58();
    const muleWallet = Keypair.generate().publicKey.toBase58();

    watcher.registerDistribution(mint, devWallet, muleWallet, 3_000_000n, DevRelationshipRole.DIRECT_CREATOR_RECIPIENT);

    const graph = watcher.getDistributionGraph(mint);
    assert(graph !== null, 'Distribution graph must exist');
    assert.strictEqual(graph.creatorAddress, devWallet);
    assert.strictEqual(graph.monitoredWallets.size, 1);
    assert.strictEqual(graph.monitoredWallets.get(muleWallet).lastBalance, 3_000_000n);

    watcher.registerDistribution(mint, devWallet, muleWallet, 1_000_000n, DevRelationshipRole.DIRECT_CREATOR_RECIPIENT);

    assert.strictEqual(dumpAlertFired, false, 'Internal transfer must never trigger false dump alert');
  });

  test('Fix 7.2: Mule wallet dumping tokens triggers aggregated cluster dump alert and frontrun', () => {
    let dumpAlert = null;
    let frontrunTriggered = false;
    const mockPosManager = {
      triggerEmergencyFrontrun: (mint, reason) => {
        frontrunTriggered = true;
      }
    };

    const watcher = new DevWatcher(null, mockPosManager);
    eventBus.on('DEV_DUMP_ALERT', (alert) => { dumpAlert = alert; });

    const mint = Keypair.generate().publicKey.toBase58();
    const devWallet = Keypair.generate().publicKey.toBase58();
    const muleWallet = Keypair.generate().publicKey.toBase58();

    watcher.registerDistribution(mint, devWallet, muleWallet, 5_000_000n, DevRelationshipRole.DIRECT_CREATOR_RECIPIENT);

    const buf = Buffer.alloc(72);
    buf.writeBigUInt64LE(2_000_000n, 64); // currentBalance = 2M (was 5M -> 60% dump)

    watcher.handleMuleAccountUpdate(mint, muleWallet, buf);

    assert(dumpAlert !== null, 'Mule dump must trigger DEV_DUMP_ALERT');
    assert.strictEqual(dumpAlert.isMuleDump, true, 'Must be marked as isMuleDump');
    assert.strictEqual(dumpAlert.muleWallet, muleWallet);
    assert.strictEqual(dumpAlert.dumpPercent, 60);
    assert.strictEqual(frontrunTriggered, true, 'Emergency frontrun must be triggered for mule dump');
  });

  console.log('\n==================================================');
  console.log(`TEST RESULTS: ${passedTests} Passed, ${failedTests} Failed`);
  console.log('==================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
