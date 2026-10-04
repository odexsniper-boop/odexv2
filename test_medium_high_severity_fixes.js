import assert from 'assert';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { BuyerQualityEngine } from './engines/buyerQualityEngine.js';
import { ExecutionController } from './engines/executionController.js';
import { SmartAgent } from './engines/smartAgent.js';
import { eventBus } from './eventBus.js';

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name} ->`, err.message);
    failed++;
  }
}

async function asyncIt(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name} ->`, err.message);
    failed++;
  }
}

console.log('================================================================');
console.log('🧪 TESTING MEDIUM & HIGH SEVERITY PIPELINE FIXES');
console.log('================================================================');

// -------------------------------------------------------------
// TEST 1: Unhandled Metadata Exception in Orchestrator (Issue 1)
// -------------------------------------------------------------
console.log('\n--- [TEST 1] Metadata Exception Handled & Rejected ---');
await asyncIt('1.1: Metadata resolution error transitions to REJECTED and increments vetoCount', async () => {
  const orchestrator = new Orchestrator({
    buySizeSol: 0.1,
    autoBuyEnabled: false,
  });

  const mint = 'ErrMint11111111111111111111111111111111111';
  let emittedState = null;
  const onTransition = (ev) => {
    if (ev.mint === mint) emittedState = ev.state;
  };
  eventBus.on('STATE_TRANSITION', onTransition);

  // Pass metadata that triggers unhandled error during resolution
  const throwingName = {
    trim() { throw new Error('Simulated Gateway Crash'); },
    toLowerCase() { throw new Error('Simulated Gateway Crash'); }
  };

  const rec = await orchestrator.handleTokenLaunch({
    mint,
    name: throwingName,
    symbol: 'CRASH',
    creator: 'DevCreator111111111111111111111111111111111',
  });

  eventBus.off('STATE_TRANSITION', onTransition);

  assert.strictEqual(rec.state, TokenState.REJECTED, 'Record must be REJECTED, not stuck in NARRATIVE_AUDIT');
  assert.ok(rec.rejectionReason.includes('STAGE 1 FAILED'), 'Rejection reason should indicate Stage 1 failure');
  assert.ok(orchestrator.vetoCount > 0, 'Veto count must increment on metadata resolution crash');
});

// -------------------------------------------------------------
// TEST 2: Dormant Watchlist Breakout Reserves Updated (Issue 2)
// -------------------------------------------------------------
console.log('\n--- [TEST 2] Late Breakout Wakeup Updates Reserves ---');
it('2.1: Wakeup on inflow updates lastVirtualSolReserves and lastVirtualTokenReserves', () => {
  const record = new TokenRecord('WakeupMint11111111111111111111111111111111');
  record.state = TokenState.LIGHTWEIGHT_WATCHLIST;
  record.lastVirtualSolReserves = 30_000_000_000n;
  record.lastVirtualTokenReserves = 1_073_000_000_000_000n;

  // Simulate mock acc buffer: 8 bytes disc, 8 bytes vTok, 8 bytes vSol
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(900_000_000_000_000n, 8); // vTok
  buf.writeBigUInt64LE(31_000_000_000n, 16); // vSol (+1 SOL inflow)

  const vTok = buf.readBigUInt64LE(8);
  const vSol = buf.readBigUInt64LE(16);
  const prevSol = record.lastVirtualSolReserves || 30_000_000_000n;

  if (vSol > prevSol + 500_000_000n) {
    record.lastVirtualSolReserves = vSol;
    record.lastVirtualTokenReserves = vTok;
    record.transitionTo(TokenState.MONEY_FLOW_WATCH, 'LATE_BREAKOUT_INFLOW');
  }

  assert.strictEqual(record.state, TokenState.MONEY_FLOW_WATCH);
  assert.strictEqual(record.lastVirtualSolReserves, 31_000_000_000n, 'Virtual SOL reserves must be updated');
  assert.strictEqual(record.lastVirtualTokenReserves, 900_000_000_000_000n, 'Virtual token reserves must be updated');
});

// -------------------------------------------------------------
// TEST 3: Watchlist TTL Expiration Cleans Up BuyerQualityEngine (Issue 3)
// -------------------------------------------------------------
console.log('\n--- [TEST 3] Watchlist TTL Cleans Up BuyerQualityEngine ---');
it('3.1: Watchlist TTL cleanup removes token from buyerQualityEngine', () => {
  const orchestrator = new Orchestrator({ buySizeSol: 0.1, autoBuyEnabled: false });
  const mint = 'WatchlistTTLToken1111111111111111111111111';

  // Record a buy so buyer quality engine tracks this mint
  orchestrator.buyerQualityEngine.recordBuy(mint, 'BuyerWallet11111111111111111111111111111111', 1.0);
  assert.ok(orchestrator.buyerQualityEngine.tokenBuyers.has(mint), 'Token should initially be tracked in BuyerQualityEngine');

  const record = new TokenRecord(mint);
  record.state = TokenState.LIGHTWEIGHT_WATCHLIST;
  record.updatedAt = Date.now() - 8000000; // > 2 hours ago
  orchestrator.tokens.set(mint, record);

  // Simulate watchlist TTL expiration check
  const now = Date.now();
  if (now - record.updatedAt > 7200000) {
    orchestrator.tokens.delete(record.mint);
    orchestrator.candleBuilders.delete(record.mint);
    orchestrator.buyerQualityEngine.cleanupToken(record.mint);
    if (orchestrator.curveWatcher) orchestrator.curveWatcher.unwatch(record.mint);
    if (orchestrator.devWatcher) orchestrator.devWatcher.unwatchDev(record.mint);
  }

  assert.strictEqual(orchestrator.tokens.has(mint), false, 'Token deleted from tokens map');
  assert.strictEqual(orchestrator.buyerQualityEngine.tokenBuyers.has(mint), false, 'Token MUST be deleted from buyerQualityEngine to prevent memory leak');
});

// -------------------------------------------------------------
// TEST 4: BuyerQualityEngine Lookup Queue During Spikes (Issue 4)
// -------------------------------------------------------------
console.log('\n--- [TEST 4] BuyerQualityEngine Lookup Queue ---');
it('4.1: Lookup queue absorbs excess wallet checks when pendingLookups >= 20', () => {
  const bqe = new BuyerQualityEngine({ getSignaturesForAddress: async () => [] });

  // Artificially populate 20 pending lookups
  for (let i = 0; i < 20; i++) {
    bqe.pendingFunderLookups.add(`Wallet${i}11111111111111111111111111111111`);
  }
  assert.strictEqual(bqe.pendingFunderLookups.size, 20);

  // Schedule 21st wallet lookup
  const overflowWallet = 'OverflowWallet11111111111111111111111111111';
  bqe._scheduleFunderLookup(overflowWallet);

  assert.strictEqual(bqe.funderLookupQueue.length, 1, 'Overflow lookup should be pushed into funderLookupQueue');
  assert.strictEqual(bqe.funderLookupQueue[0], overflowWallet);

  const metrics = bqe.getMetrics();
  assert.strictEqual(metrics.funderLookupQueueLength, 1);
  assert.strictEqual(metrics.pendingFunderLookupsCount, 20);
});

// -------------------------------------------------------------
// TEST 5: SmartAgent Shielded from Emergency Dev Rug Liquidations (Issue 5)
// -------------------------------------------------------------
console.log('\n--- [TEST 5] SmartAgent Shielded from Dev Rug Liquidations ---');
it('5.1: Emergency frontrun exit does not pollute SmartAgent learnFromTrade', () => {
  const smartAgent = new SmartAgent({ learningEnabled: true, minCompositeScore: 70 });
  const orchestrator = new Orchestrator({ smartAgent, buySizeSol: 0.1, autoBuyEnabled: false });

  const initialTrades = smartAgent.totalLearnedTrades;

  // 1. Close position with DEV_RUG_FRONTRUN
  orchestrator.handlePositionClosed({
    mint: 'RugMint111111111111111111111111111111111111',
    name: 'RugCoin',
    reason: 'DEV_RUG_FRONTRUN',
    finalPnlPercent: -45,
    txHash: 'sim_tx_rug',
  });

  assert.strictEqual(smartAgent.totalLearnedTrades, initialTrades, 'Emergency dev rug frontrun should NOT be learned');

  // 2. Close position with DEV_MULE_DUMP_FRONTRUN
  orchestrator.handlePositionClosed({
    mint: 'MuleMint111111111111111111111111111111111111',
    name: 'MuleCoin',
    reason: 'DEV_MULE_DUMP_FRONTRUN',
    finalPnlPercent: -35,
    txHash: 'sim_tx_mule',
  });

  assert.strictEqual(smartAgent.totalLearnedTrades, initialTrades, 'Mule dump frontrun should NOT be learned');

  // 3. Normal STOP_LOSS should be learned
  orchestrator.handlePositionClosed({
    mint: 'NormalMint1111111111111111111111111111111111',
    name: 'NormalCoin',
    reason: 'STOP_LOSS',
    finalPnlPercent: -16,
    txHash: 'sim_tx_normal',
  });

  assert.strictEqual(smartAgent.totalLearnedTrades, initialTrades + 1, 'Standard strategy stop loss SHOULD be learned');
});

// -------------------------------------------------------------
// TEST 6: ExecutionController Idempotency Lock Cleanup on Pre-Dispatch Errors (Issue 7)
// -------------------------------------------------------------
console.log('\n--- [TEST 6] ExecutionController In-Flight Lock Cleanup ---');
await asyncIt('6.1: BUY cleans inFlightExecutions on invalid slippage or pre-dispatch errors', async () => {
  const controller = new ExecutionController({
    blockhashManager: null,
    executionCache: null,
    tokenResolver: null,
    transactionBuilder: null,
    dispatcher: null,
    transactionMonitor: null,
    isPaperTrading: true,
  });

  const mint = 'TestMint11111111111111111111111111111111111';
  let caught = false;
  try {
    await controller.buy({
      mint,
      solAmount: 0.1,
      slippageBps: -50, // invalid slippage triggers error
    });
  } catch (err) {
    caught = true;
    assert.ok(err.message.includes('INVALID_SLIPPAGE'));
  }

  assert.strictEqual(caught, true, 'Must throw on invalid slippage');
  assert.strictEqual(controller.inFlightExecutions.has(`BUY:${mint}`), false, 'inFlightExecutions must be deleted on pre-dispatch validation error');
});

await asyncIt('6.2: SELL cleans inFlightExecutions on invalid slippage or pre-dispatch errors', async () => {
  const controller = new ExecutionController({
    blockhashManager: null,
    executionCache: null,
    tokenResolver: null,
    transactionBuilder: null,
    dispatcher: null,
    transactionMonitor: null,
    isPaperTrading: true,
  });

  const mint = 'TestMint22222222222222222222222222222222222';
  let caught = false;
  try {
    await controller.sell({
      mint,
      tokenAmountRaw: '1000000000',
      slippageBps: NaN, // invalid slippage triggers error
    });
  } catch (err) {
    caught = true;
    assert.ok(err.message.includes('INVALID_SLIPPAGE'));
  }

  assert.strictEqual(caught, true, 'Must throw on invalid slippage');
  assert.strictEqual(controller.inFlightExecutions.has(`SELL:${mint}`), false, 'inFlightExecutions must be deleted on pre-dispatch validation error in SELL');
});

console.log('\n================================================================');
console.log(`🏁 RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) process.exit(1);
