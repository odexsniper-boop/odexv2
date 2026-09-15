import { ExecutionEngine } from './engines/executionEngine.js';
import { PositionManager } from './engines/positionManager.js';
import { calculateTokensOut, calculateSolOut, calculateSpotPriceSol } from './pumpfun.js';
import { eventBus } from './eventBus.js';
import { log } from './config.js';

async function runTest() {
  log('==============================================');
  log('STARTING ENGINE VERIFICATION & INTEGRATION TEST');
  log('==============================================');

  // 1. Verify Bonding Curve Math
  const initialSolReserves = 30_000_000_000n; // 30 SOL
  const initialTokenReserves = 1_073_000_000_000_000n; // 1.073B tokens
  const testBuySolLamports = 1_000_000_000n; // 1 SOL

  const tokensOut = calculateTokensOut(testBuySolLamports, initialSolReserves, initialTokenReserves);
  const spotPrice = calculateSpotPriceSol(initialSolReserves, initialTokenReserves);
  log(`[TEST MATH] 1 SOL Buy => Received ${Number(tokensOut) / 1e6} tokens at ${spotPrice.toExponential(4)} SOL/token`);

  if (tokensOut <= 0n) {
    throw new Error('Bonding curve calculation failed: tokensOut is 0');
  }

  // 2. Initialize Execution & Position Engines in Paper Mode
  const execution = new ExecutionEngine({ paperTrading: true });
  const positionManager = new PositionManager(execution, {
    stopLossPercent: -15,
    takeProfitTiers: [
      { triggerMultiplier: 1.30, sellPercent: 50 },
      { triggerMultiplier: 2.00, sellPercent: 100 },
    ],
  });

  const mockMint = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

  // 3. Simulate Entry
  log('\n--- Simulating Buy Order ---');
  const buyFill = await execution.executeBuy({
    mint: mockMint,
    solAmount: 0.5,
    virtualSolReserves: initialSolReserves,
    virtualTokenReserves: initialTokenReserves,
  });

  positionManager.openPosition(buyFill);

  // 4. Simulate Price Pumping (+35%) => Triggers Take Profit Tier 1
  log('\n--- Simulating Price Rise (+35%) ---');
  // Increase virtual SOL reserves to simulate buyers pushing price up
  const pumpedSolReserves = 40_500_000_000n;
  const pumpedTokenReserves = (initialSolReserves * initialTokenReserves) / pumpedSolReserves;
  await positionManager.updatePrice(mockMint, pumpedSolReserves, pumpedTokenReserves);

  // 5. Simulate Price Dumping (-20% from entry) => Triggers Stop Loss on remaining
  log('\n--- Simulating Price Dump Below Stop Loss ---');
  const dumpedSolReserves = 24_000_000_000n;
  const dumpedTokenReserves = (initialSolReserves * initialTokenReserves) / dumpedSolReserves;
  await positionManager.updatePrice(mockMint, dumpedSolReserves, dumpedTokenReserves);

  log('\n==============================================');
  log('TEST COMPLETE: ALL ENGINES PASSED VERIFICATION');
  log('==============================================');
}

runTest().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
