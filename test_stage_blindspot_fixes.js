import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PublicKey, Keypair } from '@solana/web3.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { narrativeEngine } from './engines/narrativeEngine.js';
import { SmartAgent } from './engines/smartAgent.js';
import { TokenDetector } from './engines/tokenDetector.js';
import { PUMP_PROGRAM_ID } from './pumpfun.js';

class MockExecutionEngine {
  constructor() {
    this.jitoTipLamports = 10_000_000;
  }
  async executeBuy(params) {
    return {
      mint: params.mint,
      spotPriceSol: 0.00000003,
      solSpent: params.solAmount,
      tokensReceived: 33_333_333,
      rawTokensReceived: 33_333_333_000_000n,
      txHash: 'sig_mock_buy_' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
    };
  }
  async executeSell(params) {
    return {
      mint: params.mint,
      spotPriceSol: 0.00000003,
      solReceived: 0.1,
      actualNetSellProceeds: 0.1,
      txHash: 'sig_mock_sell_' + Math.random().toString(36).slice(2, 8),
    };
  }
}

class MockPositionManager {
  constructor() {
    this.positions = new Map();
    this.dailyRealizedLossSol = 0;
  }
  isDailyLossExceeded() { return false; }
  openPosition(buyFill, meta) {
    const pos = { mint: buyFill.mint, ...meta };
    this.positions.set(buyFill.mint, pos);
    return pos;
  }
}

function test(name, condition, details = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING VERIFICATION FOR ALL ENGINE STAGE BLIND SPOT FIXES');
  console.log('================================================================');

  // --- TEST 1: Entry Queue Preservation on Break ---
  console.log('\n--- TEST 1: Entry Queue Item Retention ---');
  {
    const orch = new Orchestrator({
      executionEngine: new MockExecutionEngine(),
      positionManager: new MockPositionManager(),
      autoBuyEnabled: true,
      tradeCooldownMs: 0,
      maxConcurrentPositions: 10,
    });
    orch.lastTradeTime = 0; // cooldown clear

    const mint1 = Keypair.generate().publicKey.toBase58();
    const mint2 = Keypair.generate().publicKey.toBase58();
    const mint3 = Keypair.generate().publicKey.toBase58();

    const rec1 = new TokenRecord(mint1); rec1.name = 'Token1';
    const rec2 = new TokenRecord(mint2); rec2.name = 'Token2';
    const rec3 = new TokenRecord(mint3); rec3.name = 'Token3';

    orch.tokens.set(mint1, rec1);
    orch.tokens.set(mint2, rec2);
    orch.tokens.set(mint3, rec3);

    orch.entryQueue = [
      { mint: mint1, queuedAt: Date.now(), breakoutPriceSol: 0.00000003 },
      { mint: mint2, queuedAt: Date.now(), breakoutPriceSol: 0.00000003 },
      { mint: mint3, queuedAt: Date.now(), breakoutPriceSol: 0.00000003 },
    ];

    // Process entry queue
    await orch._processEntryQueue();

    test('1.1: Token 1 was popped and bought',
      rec1.state === TokenState.POSITION_OPEN,
      `State: ${rec1.state}`);

    test('1.2: Subsequent tokens (Token 2 and Token 3) are PRESERVED in entryQueue and not dropped',
      orch.entryQueue.length === 2 &&
      orch.entryQueue[0].mint === mint2 &&
      orch.entryQueue[1].mint === mint3,
      `Queue length: ${orch.entryQueue.length}, contents: ${orch.entryQueue.map(i => i.mint).join(', ')}`);
  }

  // --- TEST 2: NarrativeEngine 12+ Char Compound Words ---
  console.log('\n--- TEST 2: NarrativeEngine Compound Name Protection ---');
  {
    const compoundAi = narrativeEngine.evaluateNarrative({
      name: 'NeuralTerminal',
      symbol: 'NTRM',
      description: 'Autonomous neural terminal network for deep learning agents.',
      twitter: 'https://x.com/neuralterminal',
    });
    test('2.1: NeuralTerminal (14 chars, no spaces) is NOT flagged as SPAM_LOW_EFFORT',
      compoundAi.theme === 'AI_AGENT_TECH' && compoundAi.narrativeScore >= 60,
      `Theme: ${compoundAi.theme}, score: ${compoundAi.narrativeScore}`);

    const compoundInfluencer = narrativeEngine.evaluateNarrative({
      name: 'OfficialTrump',
      symbol: 'TRUMP',
      description: 'Official cultural community token celebrating Trump breaking news.',
      telegram: 'https://t.me/officialtrump',
    });
    test('2.2: OfficialTrump (13 chars, no spaces) is NOT flagged as SPAM_LOW_EFFORT',
      compoundInfluencer.theme === 'INFLUENCER_EVENT_NEWS' && compoundInfluencer.narrativeScore >= 60,
      `Theme: ${compoundInfluencer.theme}, score: ${compoundInfluencer.narrativeScore}`);

    const randomHash = narrativeEngine.evaluateNarrative({
      name: '0123456789abcdef0123',
      symbol: 'HASH',
      description: 'Just a random hash coin.',
    });
    test('2.3: True 16+ hex character hash name IS correctly flagged as SPAM_LOW_EFFORT',
      randomHash.theme === 'SPAM_LOW_EFFORT' && randomHash.narrativeScore <= 15,
      `Theme: ${randomHash.theme}, score: ${randomHash.narrativeScore}`);
  }

  // --- TEST 3: SmartAgent Organic Buyer Tracking ---
  console.log('\n--- TEST 3: SmartAgent Organic Buyer Breadth ---');
  {
    const agent = new SmartAgent({ learningEnabled: true });
    agent.saveLearningState = () => {}; // Stub to protect persistent storage
    agent.experiences = [];
    agent.totalWins = 0;
    agent.totalLosses = 0;

    // Simulate 3 losing trades, but each had high organic buyer counts (e.g., 10 buyers)
    for (let i = 0; i < 3; i++) {
      agent.learnFromTrade({
        mint: Keypair.generate().publicKey.toBase58(),
        name: `HighBuyerLoss_${i}`,
        finalPnlPercent: -15,
        reason: 'STOP_LOSS',
        devPercent: 2.0,
        bundleCount: 0, // slot bundle was 0!
        uniqueBuyersCount: 10,
        organicBuyersCount: 10,
      });
    }

    test('3.1: Losses with broad organic buyers (10 buyers) do NOT falsely trigger effectiveMinExternalBuyers escalation',
      agent.effectiveMinExternalBuyers === 2,
      `effectiveMinExternalBuyers: ${agent.effectiveMinExternalBuyers}`);
  }

  // --- TEST 4: Orchestrator Active Trade Keep-Alive & Stage 3 Veto ---
  console.log('\n--- TEST 4: Orchestrator Stage 2 Keep-Alive & Stage 3 Sell Pressure Veto ---');
  {
    const orch = new Orchestrator({
      executionEngine: new MockExecutionEngine(),
      positionManager: new MockPositionManager(),
      autoBuyEnabled: false,
    });

    const testMint = Keypair.generate().publicKey.toBase58();
    const rec = new TokenRecord(testMint);
    rec.name = 'ActiveTradingToken';
    rec.state = TokenState.MONEY_FLOW_WATCH;
    const oldTime = Date.now() - 50000;
    rec.updatedAt = oldTime;
    orch.tokens.set(testMint, rec);

    // Simulate incoming trade tick
    await orch.handleCurveTick({
      mint: testMint,
      priceSol: 0.00000003,
      solDelta: 0.5,
      isBuy: true,
      hasTraded: true,
      virtualSolReserves: 30_500_000_000n,
      virtualTokenReserves: 1_000_000_000_000_000n,
    });

    test('4.1: Active curve trade refreshes record.updatedAt to keep active token alive',
      rec.updatedAt > oldTime,
      `oldTime: ${oldTime}, updatedAt: ${rec.updatedAt}`);

    // Test Stage 3 sell pressure veto
    const dumpMint = Keypair.generate().publicKey.toBase58();
    const dumpRec = new TokenRecord(dumpMint);
    dumpRec.name = 'DumpingToken';
    dumpRec.state = TokenState.PATTERN_FORMING;
    dumpRec.buyVolumeSol = 1.0;
    dumpRec.sellVolumeSol = 4.0; // heavy sell volume
    orch.tokens.set(dumpMint, dumpRec);
    orch.candleBuilders.set(dumpMint, { getClosedCandles: () => [], timeframeMs: 15000, addTick: () => {} });

    await orch.handleCurveTick({
      mint: dumpMint,
      priceSol: 0.00000001,
      solDelta: 0.1,
      isBuy: false,
      hasTraded: true,
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_000_000_000_000_000n,
    });

    test('4.2: Severe sell volume dump in Stage 3 PATTERN_FORMING triggers immediate rejection',
      dumpRec.state === TokenState.REJECTED && dumpRec.rejectionReason.includes('SEVERE_SELL_PRESSURE'),
      `State: ${dumpRec.state}, reason: ${dumpRec.rejectionReason}`);
  }

  console.log('\n================================================================');
  console.log('🏁 ALL STAGE BLIND SPOT FIXES VERIFIED SUCCESSFULLY (100% PASS)');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
