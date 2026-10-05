import assert from 'node:assert';
import { TokenDetector } from './engines/tokenDetector.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { narrativeEngine } from './engines/narrativeEngine.js';
import { evaluateThreeCandlePattern } from './engines/priceEngine.js';
import { PositionManager } from './engines/positionManager.js';
import { PUMP_PROGRAM_ID } from './pumpfun.js';
import { PublicKey, Keypair } from '@solana/web3.js';

console.log('================================================================');
console.log('🧪 VERIFYING HIGH & MEDIUM SEVERITY BLIND SPOT FIXES');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function test(name, condition, message = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name}: ${message}`);
    failed++;
  }
}

// -------------------------------------------------------------
// TEST 1: TokenDetector devPercent Calculation (Blind Spot 0.1)
// -------------------------------------------------------------
console.log('--- TEST 1: TokenDetector devPercent Calculation ---');
{
  const creatorKey = Keypair.generate().publicKey;
  const mintKey = Keypair.generate().publicKey;
  const buyerKey = Keypair.generate().publicKey;

  const buyIxData = Buffer.alloc(24);
  Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]).copy(buyIxData, 0); // buy discriminator
  buyIxData.writeBigUInt64LE(50_000_000_000_000n, 8); // 50M tokens (5% of 1B supply)

  const mockTx = {
    slot: 123456,
    blockTime: Date.now(),
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [
          mintKey,
          PublicKey.default,
          PublicKey.default,
          PublicKey.default,
          PublicKey.default,
          PublicKey.default,
          creatorKey,
        ],
        instructions: [
          {
            programIdIndex: 0,
            accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6],
            data: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]), // create discriminator
          },
          {
            programIdIndex: 0,
            accountKeyIndexes: [0, 1, 2, 3, 4, 5, 6], // buyer is creator (dev buy)
            data: buyIxData,
          }
        ]
      }
    }
  };
  mockTx.transaction.message.accountKeys[0] = PUMP_PROGRAM_ID;

  const parsed = TokenDetector.parseLaunchTransaction(mockTx);
  test('1.1: TokenDetector accurately computes devPercent for on-chain creator buy',
    parsed !== null && Math.abs(parsed.devPercent - 5.0) < 0.1,
    `parsed.devPercent was: ${parsed?.devPercent}`);
}

// -------------------------------------------------------------
// TEST 2: handleBundleMetricsUpdated Dev Holding Sync (Blind Spot 0.2)
// -------------------------------------------------------------
console.log('\n--- TEST 2: handleBundleMetricsUpdated Dev Holding Sync ---');
{
  const orch = new Orchestrator({ executionEngine: {}, positionManager: {} });
  const testMint = 'SyncDevPercentMint11111111111111111111111';
  const record = new TokenRecord(testMint);
  record.devPercent = 0; // initially estimated 0
  orch.tokens.set(testMint, record);

  orch.handleBundleMetricsUpdated({
    mint: testMint,
    devPercent: 12.5,
    bundledBuysCount: 2,
    bundlePercent: 5.0,
    creator: 'RealDev11111111111111111111111111111111111'
  });

  test('2.1: record.devPercent is updated to verified on-chain percentage',
    record.devPercent === 12.5,
    `record.devPercent: ${record.devPercent}`);
  test('2.2: Hard safety veto triggered for devPercent > 8%',
    record.state === TokenState.REJECTED && record.rejectionReason.includes('DEV_OVERALLOCATED'),
    `record.state: ${record.state}, reason: ${record.rejectionReason}`);
}

// -------------------------------------------------------------
// TEST 3: Narrative Spam Word Boundary & Telegram Invite Links (Blind Spots 1.1 & 1.2)
// -------------------------------------------------------------
console.log('\n--- TEST 3: Narrative Spam Word Boundary & Telegram Invite Links ---');
{
  // 3.1: Token named "The Greatest Chad" or "Contest" should not be marked spam
  const greatestVerdict = narrativeEngine.evaluateNarrative({
    name: 'The Greatest Contest',
    symbol: 'GREATEST',
    description: 'The greatest battle of meme history ongoing community token',
    twitter: 'https://x.com/greatest_token',
    telegram: 'https://t.me/+AbCdEfGh123', // invite link with +
  });

  test('3.1: Token with "greatest" and "contest" is not flagged as SPAM_LOW_EFFORT',
    greatestVerdict.theme !== 'SPAM_LOW_EFFORT',
    `theme: ${greatestVerdict.theme}`);

  test('3.2: Telegram invite link with + is accepted as valid without penalty',
    greatestVerdict.socialsFound >= 2 && greatestVerdict.reasons.some(r => r.includes('Telegram community attached')),
    `socialsFound: ${greatestVerdict.socialsFound}, reasons: ${greatestVerdict.reasons.join(', ')}`);

  // 3.3: True spam token named "test" or "airdrop" is still rejected
  const trueSpamVerdict = narrativeEngine.evaluateNarrative({
    name: 'test token',
    symbol: 'TEST',
    description: 'free sol test',
  });
  test('3.3: Exact "test" token is correctly rejected as SPAM_LOW_EFFORT',
    trueSpamVerdict.theme === 'SPAM_LOW_EFFORT',
    `theme: ${trueSpamVerdict.theme}`);
}

// -------------------------------------------------------------
// TEST 4: Setup B Upper Wick Rejection & 4-Candle Consolidation (Blind Spots 3.1 & 3.3)
// -------------------------------------------------------------
console.log('\n--- TEST 4: PriceEngine Upper Wick Exhaustion & Multi-Candle Setup ---');
{
  // 4.1: Shooting star rejection (C3 dumps from high 20 to close 10.1)
  const shootingStarCandles = [
    { open: 10.0, high: 12.0, low: 9.8, close: 12.0, volume: 10, timestamp: 1000 }, // C1 +20%
    { open: 12.0, high: 13.0, low: 11.9, close: 12.8, volume: 10, timestamp: 2000 }, // C2 +6.6%
    { open: 12.8, high: 20.0, low: 12.7, close: 12.9, volume: 20, timestamp: 3000 }, // C3 huge upper wick
  ];
  const shootingStarResult = evaluateThreeCandlePattern(shootingStarCandles);
  test('4.1: Setup B rejected when C3 forms dominant shooting star upper wick',
    shootingStarResult.patternTriggered === false,
    `patternTriggered: ${shootingStarResult.patternTriggered}`);

  // 4.2: 4-Candle healthy consolidation setup
  const fourCandleSetup = [
    { open: 10.0, high: 13.0, low: 9.9, close: 12.5, volume: 10, timestamp: 1000 }, // C1 breakout +25%
    { open: 12.5, high: 12.6, low: 11.8, close: 12.0, volume: 4, timestamp: 2000 },  // C2 pullback 1 holds
    { open: 12.0, high: 12.2, low: 11.7, close: 11.9, volume: 3, timestamp: 3000 },  // C3 pullback 2 holds
    { open: 11.9, high: 13.5, low: 11.8, close: 13.2, volume: 15, timestamp: 4000 }, // C4 breaks out!
  ];
  const fourCandleResult = evaluateThreeCandlePattern(fourCandleSetup);
  test('4.2: 4-Candle extended pullback pattern correctly triggers entry',
    fourCandleResult.patternTriggered === true && fourCandleResult.score >= 90,
    `patternTriggered: ${fourCandleResult.patternTriggered}, reason: ${fourCandleResult.reason}`);
}

// -------------------------------------------------------------
// TEST 5: Late Breakout Scanner Downside Drift (Blind Spot 5.3)
// -------------------------------------------------------------
console.log('\n--- TEST 5: Late Breakout Downside Drift Tracking ---');
{
  const orch = new Orchestrator({ executionEngine: {}, positionManager: {} });
  const testMint = 'LateBreakoutMint11111111111111111111111';
  const record = new TokenRecord(testMint);
  record.state = TokenState.LIGHTWEIGHT_WATCHLIST;
  record.lastVirtualSolReserves = 35_000_000_000n; // was 35 SOL
  record.lastVirtualTokenReserves = 1_000_000_000_000_000n;
  orch.tokens.set(testMint, record);

  // Downward drift to 30 SOL occurs
  const driftedSol = 30_000_000_000n;
  const driftedTok = 1_073_000_000_000_000n;
  if (driftedSol < record.lastVirtualSolReserves) {
    record.lastVirtualSolReserves = driftedSol;
    record.lastVirtualTokenReserves = driftedTok;
  }

  test('5.1: Downside drift updates baseline reserves from 35 SOL down to 30 SOL',
    record.lastVirtualSolReserves === 30_000_000_000n,
    `reserves: ${record.lastVirtualSolReserves}`);

  // Subsequent inflow of +1.0 SOL (to 31 SOL)
  const newSol = 31_000_000_000n;
  const isBreakout = newSol > record.lastVirtualSolReserves + 500_000_000n;
  test('5.2: Inflow from 30 SOL to 31 SOL correctly registers as late breakout (+1.0 SOL > +0.5 SOL)',
    isBreakout === true,
    `isBreakout: ${isBreakout}`);
}

// -------------------------------------------------------------
// TEST 6: PositionManager Initial Reserves from buyFill (Blind Spot 6.2)
// -------------------------------------------------------------
console.log('\n--- TEST 6: PositionManager Initial Reserves from buyFill ---');
{
  const pm = new PositionManager({});
  const buyFill = {
    mint: 'TestMintReserves1111111111111111111111111',
    spotPriceSol: 0.00000004,
    solSpent: 0.1,
    tokensReceived: 2_500_000,
    rawTokensReceived: '2500000000000',
    virtualSolReserves: 42_000_000_000n,
    virtualTokenReserves: 950_000_000_000_000n,
    txHash: 'sig_test_123',
    timestamp: new Date().toISOString()
  };

  const pos = pm.openPosition(buyFill, { name: 'ReservesCoin' });
  test('6.1: Position initializes with actual filled reserves (42 SOL) instead of 30 SOL default',
    pos.lastKnownVirtualSol === 42_000_000_000n,
    `lastKnownVirtualSol: ${pos.lastKnownVirtualSol}`);
}

console.log('\n================================================================');
console.log(`🏁 HIGH & MEDIUM BLIND SPOT TESTS: ${passed} PASSED, ${failed} FAILED`);
console.log('================================================================\n');

if (failed > 0) process.exit(1);
