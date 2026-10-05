import assert from 'assert';
import { PublicKey } from '@solana/web3.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { validateMoneyFlow } from './engines/manipulationEngine.js';
import { ExecutionEngine } from './engines/executionEngine.js';
import { PositionManager } from './engines/positionManager.js';
import { getBondingCurvePDA, getAssociatedBondingCurvePDA } from './pumpfun.js';

console.log('🧪 Starting Critical Operational Blind Spots Test Suite...\n');

let passedTests = 0;
let totalTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
  }
}

// -------------------------------------------------------------
// Test 1: validateMoneyFlow returns HIGH_SUPPLY_CONCENTRATION when topHoldersPercent > 35%
// -------------------------------------------------------------
it('validateMoneyFlow vetoes when topHoldersPercent > 35%', () => {
  const verdict = validateMoneyFlow({
    buyVolumeSol: 15.0,
    sellVolumeSol: 5.0,
    uniqueBuyersCount: 20,
    organicBuyersCount: 18,
    bundledBuysCount: 0,
    rawBuyersCount: 20,
    clusterRisk: 'LOW',
    txCount: 30,
    liquiditySol: 35.0,
    requiresExceptionalMomentum: false,
    marketCapSol: 40.0,
    topHoldersPercent: 38.5,
    devHoldingPercent: 3.0,
    devSoldAny: false,
  });

  assert.strictEqual(verdict.passed, false, 'Should fail money flow validation');
  assert.strictEqual(verdict.reason, 'HIGH_SUPPLY_CONCENTRATION', 'Reason must be HIGH_SUPPLY_CONCENTRATION');
  assert.ok(verdict.reasons[0].includes('38.5%'), 'Must specify top holders percentage in reasons');
});

// -------------------------------------------------------------
// Test 2: validateMoneyFlow passes when topHoldersPercent <= 35% with healthy order flow
// -------------------------------------------------------------
it('validateMoneyFlow passes when topHoldersPercent <= 35%', () => {
  const verdict = validateMoneyFlow({
    buyVolumeSol: 15.0,
    sellVolumeSol: 5.0,
    uniqueBuyersCount: 20,
    organicBuyersCount: 18,
    bundledBuysCount: 0,
    rawBuyersCount: 20,
    clusterRisk: 'LOW',
    txCount: 30,
    liquiditySol: 35.0,
    requiresExceptionalMomentum: false,
    marketCapSol: 40.0,
    topHoldersPercent: 22.0,
    devHoldingPercent: 3.0,
    devSoldAny: false,
  });

  assert.strictEqual(verdict.passed, true, 'Should pass money flow validation');
  assert.ok(verdict.score >= 70, 'Score should be high');
});

// -------------------------------------------------------------
// Test 3: Orchestrator.refreshTopHolders filters bonding curve and calculates topHoldersPercent
// -------------------------------------------------------------
await itAsync('Orchestrator.refreshTopHolders filters bonding curve pool ATA and computes percentage', async () => {
  const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const mintPubkey = new PublicKey(mint);
  const bcPDA = getBondingCurvePDA(mintPubkey);
  const bcATA = getAssociatedBondingCurvePDA(mintPubkey, bcPDA);

  // Mock connection returning bonding curve account (580M tokens) + 3 top holders (160M, 140M, 100M = 400M = 40%)
  const mockConnection = {
    getTokenLargestAccounts: async (pubkey) => {
      return {
        value: [
          { address: bcATA.toBase58(), uiAmount: 580_000_000, decimals: 6 }, // Curve pool: ignored!
          { address: 'Holder1111111111111111111111111111111111111', uiAmount: 160_000_000, decimals: 6 },
          { address: 'Holder2222222222222222222222222222222222222', uiAmount: 140_000_000, decimals: 6 },
          { address: 'Holder3333333333333333333333333333333333333', uiAmount: 100_000_000, decimals: 6 },
        ]
      };
    }
  };

  let unwatchedCurve = false;
  let unwatchedDev = false;
  const mockCurveWatcher = { connection: mockConnection, unwatch: () => { unwatchedCurve = true; } };
  const mockDevWatcher = { unwatchDev: () => { unwatchedDev = true; } };

  const orchestrator = new Orchestrator({
    curveWatcher: mockCurveWatcher,
    devWatcher: mockDevWatcher,
    executionEngine: { connection: mockConnection },
    positionManager: {},
  });

  const record = new TokenRecord(mint);
  record.state = TokenState.MONEY_FLOW_WATCH;
  orchestrator.tokens.set(mint, record);

  const pct = await orchestrator.refreshTopHolders(record);
  assert.strictEqual(pct, 40.0, 'Sum of non-curve top holders must be 40.0% (400M / 1B)');
  assert.strictEqual(record.topHoldersPercent, 40.0, 'Record topHoldersPercent must be 40.0%');
  assert.strictEqual(record.state, TokenState.REJECTED, 'Must trigger hard veto to REJECTED');
  assert.ok(record.rejectionReason.includes('STAGE 2 VETO: HIGH_SUPPLY_CONCENTRATION'), 'Rejection reason must match');
  assert.strictEqual(unwatchedCurve, true, 'Curve watcher must be unwatched');
  assert.strictEqual(unwatchedDev, true, 'Dev watcher must be unwatched');
});

// -------------------------------------------------------------
// Test 4: Orchestrator handleCurveTick vetoes on HIGH_SUPPLY_CONCENTRATION
// -------------------------------------------------------------
await itAsync('Orchestrator handleCurveTick triggers hard veto when topHoldersPercent > 35%', async () => {
  const mint = '8yKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV';
  let unwatchedCurve = false;
  const mockCurveWatcher = { unwatch: () => { unwatchedCurve = true; } };

  const orchestrator = new Orchestrator({
    curveWatcher: mockCurveWatcher,
    executionEngine: {},
    positionManager: {},
  });

  const record = new TokenRecord(mint);
  record.state = TokenState.MONEY_FLOW_WATCH;
  record.topHoldersPercent = 39.0; // 39% > 35%
  record.buyVolumeSol = 10.0;
  record.sellVolumeSol = 2.0;
  record.txCount = 15;
  orchestrator.tokens.set(mint, record);

  await orchestrator.handleCurveTick({
    mint,
    hasTraded: true,
    solDelta: 1.0,
    isBuy: true,
    buyerPubkey: 'Buyer1111111111111111111111111111111111111',
    traderIdentityStatus: 'VERIFIED',
    priceSol: 0.00000002,
    virtualSolReserves: 35_000_000_000n,
    virtualTokenReserves: 800_000_000_000_000n,
    timestamp: Date.now(),
  });

  assert.strictEqual(record.state, TokenState.REJECTED, 'Must transition to REJECTED');
  assert.ok(record.rejectionReason.includes('HIGH_SUPPLY_CONCENTRATION'), 'Must cite HIGH_SUPPLY_CONCENTRATION');
  assert.strictEqual(unwatchedCurve, true, 'Must unwatch curve on veto');
});

// -------------------------------------------------------------
// Test 5: ExecutionEngine exposes executeRaydiumSell delegating to ExecutionController
// -------------------------------------------------------------
await itAsync('ExecutionEngine delegates executeRaydiumSell to ExecutionController (Paper Mode)', async () => {
  const execution = new ExecutionEngine({
    paperTrading: true,
    slippageBps: 1500,
    priorityFee: 100_000,
    jitoTipLamports: 10_000_000,
  });

  const mint = 'So11111111111111111111111111111111111111112';
  // Sell 1,000,000 tokens (at ~0.000000032 SOL/token = 0.032 SOL gross, which easily covers gas/tips)
  const tokenAmountRaw = '1000000000000'; 

  const fill = await execution.executeRaydiumSell({
    mint,
    tokenAmountRaw,
    slippageBps: 1500,
    reason: 'TEST_RAYDIUM_SELL',
  });

  assert.ok(fill, 'Must return a fill object');
  assert.strictEqual(fill.mode, 'PAPER', 'Must be in PAPER mode');
  assert.strictEqual(fill.venue, 'RAYDIUM', 'Venue must be RAYDIUM');
  assert.strictEqual(fill.tokensSold, 1_000_000, 'Must have sold 1,000,000 tokens');
  assert.ok(fill.actualNetSellProceeds > 0, 'Net sell proceeds must be positive');
  assert.ok(fill.txHash.startsWith('sim_raydium_sell_'), 'Tx hash must have sim_raydium_sell prefix');
});

// -------------------------------------------------------------
// Test 6: PositionManager closePosition routes to executeRaydiumSell when isGraduated
// -------------------------------------------------------------
await itAsync('PositionManager.closePosition executes executeRaydiumSell for graduated token', async () => {
  let raydiumSellCalled = false;
  let pumpSellCalled = false;

  const mockExecution = {
    defaultSlippageBps: 1500,
    defaultPriorityFeeMicroLamports: 100_000,
    jitoTipLamports: 10_000_000,
    executeRaydiumSell: async ({ mint, tokenAmountRaw, reason }) => {
      raydiumSellCalled = true;
      return {
        mode: 'PAPER',
        venue: 'RAYDIUM',
        action: 'SELL',
        txHash: 'raydium_tx_test_123',
        spotPriceSol: 0.00000004,
        actualNetSellProceeds: 0.4,
        actualGrossSellProceeds: 0.41,
        actualTransactionFees: 0.00001,
        tokensSold: 10_000_000,
      };
    },
    executeSell: async () => {
      pumpSellCalled = true;
      throw new Error('Should not call executeSell on graduated token!');
    }
  };

  const pm = new PositionManager(mockExecution);
  const mint = 'GraduatedMint1111111111111111111111111111111';
  const initialHistoryCount = pm.tradeHistory.length;

  pm.positions.set(mint, {
    mint,
    name: 'Graduated Coin',
    symbol: 'GRAD',
    curveLifecycle: 'GRADUATED', // Marked as graduated
    venue: 'RAYDIUM',
    status: 'HOLDING',
    executionState: 'OPEN',
    tokensHeldRaw: 10_000_000_000_000n,
    tokensHeldDisplay: 10_000_000,
    initialSolSpent: 0.2,
    realizedSolGained: 0,
    entryPriceSol: 0.00000002,
    currentPriceSol: 0.00000004,
  });

  await pm.closePosition(mint, 0n, 0n, 'TAKE_PROFIT_2.0X', 100);

  assert.strictEqual(raydiumSellCalled, true, 'Must call executeRaydiumSell');
  assert.strictEqual(pumpSellCalled, false, 'Must NOT call pump executeSell');
  assert.strictEqual(pm.positions.has(mint), false, 'Position must be removed from active positions');
  assert.strictEqual(pm.tradeHistory.length, initialHistoryCount + 1, 'Trade history must have 1 new closed trade');
  assert.strictEqual(pm.tradeHistory[0].venue, 'RAYDIUM', 'Trade venue must be RAYDIUM');
  assert.strictEqual(pm.tradeHistory[0].sellTxHash, 'raydium_tx_test_123', 'Sell tx hash must match');
  assert.strictEqual(pm.tradeHistory[0].pnlPercent, 100, 'PnL % must be +100% (0.4 gained on 0.2 spent)');
});

// -------------------------------------------------------------
// Test 7: PositionManager recovers and switches to Raydium when Pump.fun sell throws BondingCurveComplete
// -------------------------------------------------------------
await itAsync('PositionManager catches BondingCurveComplete during executeSell and routes to Raydium', async () => {
  let attempts = 0;
  let raydiumSellExecuted = false;

  const mockExecution = {
    defaultSlippageBps: 1500,
    defaultPriorityFeeMicroLamports: 100_000,
    jitoTipLamports: 10_000_000,
    executeSell: async () => {
      attempts++;
      throw new Error('Simulation failed: 0x1774 BondingCurveComplete');
    },
    executeRaydiumSell: async () => {
      raydiumSellExecuted = true;
      return {
        mode: 'PAPER',
        venue: 'RAYDIUM',
        action: 'SELL',
        txHash: 'raydium_recovery_tx_456',
        spotPriceSol: 0.000000035,
        actualNetSellProceeds: 0.35,
        actualGrossSellProceeds: 0.36,
        actualTransactionFees: 0.00001,
        tokensSold: 10_000_000,
      };
    }
  };

  const pm = new PositionManager(mockExecution);
  const mint = 'GraduatingMint22222222222222222222222222222';

  pm.positions.set(mint, {
    mint,
    name: 'Graduating Coin',
    symbol: 'MIGRATE',
    curveLifecycle: 'BONDING', // Still in bonding initially
    venue: 'PUMP_FUN',
    status: 'HOLDING',
    executionState: 'OPEN',
    tokensHeldRaw: 10_000_000_000_000n,
    tokensHeldDisplay: 10_000_000,
    initialSolSpent: 0.2,
    realizedSolGained: 0,
    entryPriceSol: 0.00000002,
    currentPriceSol: 0.000000035,
  });

  await pm.closePosition(mint, 30_000_000_000n, 1_000_000_000_000_000n, 'EMERGENCY_EXIT', 100);

  assert.strictEqual(attempts, 1, 'Initial executeSell attempt was made');
  assert.strictEqual(raydiumSellExecuted, true, 'Reconciled to executeRaydiumSell');
  assert.strictEqual(pm.positions.has(mint), false, 'Position closed after Raydium recovery');
  assert.strictEqual(pm.tradeHistory[0].venue, 'RAYDIUM', 'Trade venue updated to RAYDIUM');
});

// -------------------------------------------------------------
// Test 8: checkStalePositions closes MIGRATION_PENDING positions via Raydium
// -------------------------------------------------------------
await itAsync('checkStalePositions executes Raydium sell for MIGRATION_PENDING positions past timeout', async () => {
  let raydiumSellCalled = false;

  const mockExecution = {
    defaultSlippageBps: 1500,
    defaultPriorityFeeMicroLamports: 100_000,
    jitoTipLamports: 10_000_000,
    executeRaydiumSell: async () => {
      raydiumSellCalled = true;
      return {
        mode: 'PAPER',
        venue: 'RAYDIUM',
        action: 'SELL',
        txHash: 'raydium_stale_exit_789',
        spotPriceSol: 0.000000032,
        actualNetSellProceeds: 0.32,
        actualGrossSellProceeds: 0.33,
        actualTransactionFees: 0.00001,
        tokensSold: 10_000_000,
      };
    }
  };

  const pm = new PositionManager(mockExecution, { staleTimeoutMs: 1000 });
  const mint = 'StaleMigrateMint3333333333333333333333333333';

  pm.positions.set(mint, {
    mint,
    name: 'Stale Migrating Coin',
    symbol: 'STALE',
    curveLifecycle: 'GRADUATED',
    venue: 'RAYDIUM',
    status: 'MIGRATION_PENDING',
    migrationStatus: 'AWAITING_RAYDIUM_POOL',
    openedTimeMs: Date.now() - 5000, // 5s ago (> 1s timeout)
    tokensHeldRaw: 10_000_000_000_000n,
    tokensHeldDisplay: 10_000_000,
    initialSolSpent: 0.2,
    realizedSolGained: 0,
    entryPriceSol: 0.00000002,
    currentPriceSol: 0.000000032,
  });

  await pm.checkStalePositions();

  assert.strictEqual(raydiumSellCalled, true, 'Raydium sell router must be called for stale migration position');
  assert.strictEqual(pm.positions.has(mint), false, 'Position must be closed');
});

console.log(`\n========================================`);
console.log(`Summary: ${passedTests}/${totalTests} tests passed.`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
}
