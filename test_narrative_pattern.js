import { narrativeEngine } from './engines/narrativeEngine.js';
import { validateMoneyFlow } from './engines/manipulationEngine.js';
import { evaluateThreeCandlePattern, CandleBuilder } from './engines/priceEngine.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';

console.log('🧪 Starting 3-Stage Strategy Verification Suite...\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
  }
}

// -------------------------------------------------------------
// Test 1: Stage 1 Narrative Engine
// -------------------------------------------------------------
console.log('--- [STAGE 1] Testing Narrative & Mindshare Engine ---');

const aiToken = narrativeEngine.evaluateNarrative({
  name: 'DeepSeek Terminal Agent',
  symbol: 'SEEKAI',
  description: 'Autonomous AI terminal agent on Solana exploring blockchain data.',
  twitter: 'https://x.com/seek_ai',
  telegram: 'https://t.me/seek_ai_portal',
  replyCount: 12,
});
assert(aiToken.passed === true, `AI token passed narrative check (${aiToken.narrativeScore}/100)`);
assert(aiToken.theme === 'AI_AGENT_TECH', `Detected AI_AGENT_TECH theme correctly`);
assert(aiToken.socialsFound === 2, `Detected 2 verified socials`);

const spamToken = narrativeEngine.evaluateNarrative({
  name: 'test coin 1239847192847',
  symbol: 'TEST',
  description: '',
});
assert(spamToken.passed === false, `Spam/low-effort token dropped by filter (${spamToken.narrativeScore}/100)`);

const memeToken = narrativeEngine.evaluateNarrative({
  name: 'Giga Chad Doge',
  symbol: 'GDOGE',
  description: 'The most based dog on Solana.',
  twitter: 'https://x.com/gdoge_sol',
});
assert(memeToken.passed === true, `Viral meme token passed narrative check (${memeToken.narrativeScore}/100)`);
assert(memeToken.theme === 'VIRAL_MEME_CULTURE', `Detected VIRAL_MEME_CULTURE theme correctly`);

// -------------------------------------------------------------
// Test 2: Stage 2 Money Flow & Order Flow Validation
// -------------------------------------------------------------
console.log('\n--- [STAGE 2] Testing Money Flow Engine ---');

const devDumpFlow = validateMoneyFlow({
  buyVolumeSol: 10,
  sellVolumeSol: 8,
  uniqueBuyersCount: 6,
  devSoldAny: true,
});
assert(devDumpFlow.passed === false, 'Dev selling immediately triggers HARD VETO');
assert(devDumpFlow.reason === 'DEV_OR_INSIDER_SOLD', 'Dev dump machine code returned correctly');

const strongMoneyFlow = validateMoneyFlow({
  buyVolumeSol: 15.5,
  sellVolumeSol: 4.2,
  uniqueBuyersCount: 12,
  txCount: 25,
  liquiditySol: 30,
  marketCapSol: 35,
  devHoldingPercent: 2.0,
  devSoldAny: false,
});
assert(strongMoneyFlow.passed === true, `Strong net buy delta confirmed money flow (Score: ${strongMoneyFlow.score}/100)`);
assert(strongMoneyFlow.buySellRatio >= 3.0, `Accurately calculated ${strongMoneyFlow.buySellRatio}x buy/sell ratio`);

const weakSellHeavyFlow = validateMoneyFlow({
  buyVolumeSol: 2.0,
  sellVolumeSol: 9.5,
  uniqueBuyersCount: 2,
  txCount: 8,
});
assert(weakSellHeavyFlow.passed === false, 'Net sell pressure dominated token rejected');

const lowVolumeFlow = validateMoneyFlow({
  buyVolumeSol: 0.05,
  sellVolumeSol: 0,
  uniqueBuyersCount: 1,
  txCount: 1,
});
assert(lowVolumeFlow.passed === false, 'Blocked sub-1 SOL low volume noise');

// -------------------------------------------------------------
// Test 3: Stage 3 The 3-Candle Pattern Entry Trigger
// -------------------------------------------------------------
console.log('\n--- [STAGE 3] Testing 3-Candle Pattern Recognition ---');

// Scenario A: Textbook 3-Candle Setup
// C1: Breakout from 0.0000100 to 0.0000125 (+25%)
// C2: Pullback to 0.0000115 (holds well above C1 open 0.0000100)
// C3: Buyers return and break C2 high (push to 0.0000130 > 0.0000125)
const validSetupCandles = [
  { open: 0.0000100, high: 0.0000125, low: 0.0000098, close: 0.0000122, volume: 10, timestamp: 1000 }, // C1 Breakout
  { open: 0.0000122, high: 0.0000123, low: 0.0000112, close: 0.0000115, volume: 4, timestamp: 2000 },  // C2 Retest Hold
  { open: 0.0000115, high: 0.0000130, low: 0.0000114, close: 0.0000128, volume: 15, timestamp: 3000 }, // C3 Breaks C2 High
];

const patternResult = evaluateThreeCandlePattern(validSetupCandles);
assert(patternResult.patternTriggered === true, `3-Candle pattern triggered successfully: ${patternResult.stage}`);
assert(patternResult.score >= 90, `High pattern score awarded (${patternResult.score}/100)`);

// Scenario B: C2 Dumps Through Support (Failed Retest / Rug Dump)
const failedRetestCandles = [
  { open: 0.0000100, high: 0.0000125, low: 0.0000098, close: 0.0000122, volume: 10, timestamp: 1000 },
  { open: 0.0000122, high: 0.0000123, low: 0.0000070, close: 0.0000075, volume: 25, timestamp: 2000 }, // Dumped below C1 base
  { open: 0.0000075, high: 0.0000085, low: 0.0000070, close: 0.0000080, volume: 5, timestamp: 3000 },
];
const failedRetestResult = evaluateThreeCandlePattern(failedRetestCandles);
assert(failedRetestResult.patternTriggered === false, 'Rejected failed support retest');
assert(failedRetestResult.stage === 'C2_SUPPORT_FAILED', 'Correctly identified C2_SUPPORT_FAILED');

// Scenario C: C1 Not a Breakout
const flatCandles = [
  { open: 0.0000100, high: 0.0000101, low: 0.0000099, close: 0.0000100, volume: 1, timestamp: 1000 },
  { open: 0.0000100, high: 0.0000101, low: 0.0000099, close: 0.0000100, volume: 1, timestamp: 2000 },
  { open: 0.0000100, high: 0.0000101, low: 0.0000099, close: 0.0000100, volume: 1, timestamp: 3000 },
];
const flatResult = evaluateThreeCandlePattern(flatCandles);
assert(flatResult.patternTriggered === false, 'Rejected flat candle history');
assert(flatResult.stage === 'WAITING_C1_BREAKOUT', 'Correctly reported WAITING_C1_BREAKOUT');

// -------------------------------------------------------------
// Test 4: Real-time Candle Builder
// -------------------------------------------------------------
console.log('\n--- Testing Real-time CandleBuilder ---');
const builder = new CandleBuilder(15);
const now = Math.floor(Date.now() / 30000) * 30000;
builder.addTick(0.0000100, 1.0, now);
builder.addTick(0.0000120, 2.0, now + 1000);
builder.addTick(0.0000110, 0.5, now + 2000);

// Advance to next 15s candle
builder.addTick(0.0000115, 1.0, now + 16000);
const candles = builder.getCandles();
assert(candles.length >= 2, `CandleBuilder aggregated ticks into ${candles.length} candles`);
assert(candles[0].high === 0.0000120, `Candle 0 high accurately recorded (0.0000120)`);
assert(candles[0].low === 0.0000100, `Candle 0 low accurately recorded (0.0000100)`);

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Results: ${passedTests} / ${totalTests} assertions passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`========================================\n`);

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
