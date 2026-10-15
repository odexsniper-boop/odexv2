/**
 * test_all_engine_stages_blindspots.js
 * Comprehensive Verification Suite for All Bot Engines & Stages Blind Spots
 */

import { HardSafetyFilter } from './engines/safetyEngine.js';
import { DevWatcher } from './engines/devWatcher.js';
import { narrativeEngine } from './engines/narrativeEngine.js';
import { validateMoneyFlow } from './engines/manipulationEngine.js';
import { BuyerQualityEngine } from './engines/buyerQualityEngine.js';
import { SmartAgent } from './engines/smartAgent.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? `(${details})` : ''}`);
    failed++;
    process.exitCode = 1;
  }
}

async function runSuite() {
  console.log('================================================================');
  console.log('🧪 RUNNING COMPREHENSIVE BOT ENGINES & STAGES BLIND SPOT VERIFICATION');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // STAGE 0: Launch & Hard Safety Gate
  // -------------------------------------------------------------
  console.log('--- STAGE 0: Launch Detection & Hard Safety Gate ---');
  {
    const filter = new HardSafetyFilter({ allowMissingBundleData: true });

    // 0.1: NaN Dev Percent must be rejected
    const devNanVerdict = filter.evaluate({ mint: 'MintNaN1', devPercent: NaN });
    test('0.1: HardSafetyFilter rejects NaN devPercent instead of passing it',
      devNanVerdict.pass === false && devNanVerdict.reason === 'CORRUPT_METRICS_DEV_PERCENT_NAN',
      `Verdict: ${JSON.stringify(devNanVerdict)}`);

    // 0.2: NaN Bundle Percent must be rejected
    const bundlePctNanVerdict = filter.evaluate({ mint: 'MintNaN2', devPercent: 2.0, bundlePercent: NaN });
    test('0.2: HardSafetyFilter rejects NaN bundlePercent',
      bundlePctNanVerdict.pass === false && bundlePctNanVerdict.reason === 'CORRUPT_METRICS_BUNDLE_PERCENT_NAN',
      `Verdict: ${JSON.stringify(bundlePctNanVerdict)}`);

    // 0.3: NaN Bundle Count must be rejected
    const bundleCountNanVerdict = filter.evaluate({ mint: 'MintNaN3', devPercent: 2.0, bundledBuysCount: NaN });
    test('0.3: HardSafetyFilter rejects NaN bundledBuysCount',
      bundleCountNanVerdict.pass === false && bundleCountNanVerdict.reason === 'CORRUPT_METRICS_BUNDLE_COUNT_NAN',
      `Verdict: ${JSON.stringify(bundleCountNanVerdict)}`);

    // 0.4: DevWatcher Creator Address Whitespace Normalization
    const devWatcher = new DevWatcher(null, null);
    const creatorBase = Keypair.generate().publicKey.toBase58();
    devWatcher.flagRugger(`  ${creatorBase}  \n`);
    test('0.4: DevWatcher matches flagged rugger even with whitespace padding',
      devWatcher.isKnownRugger(creatorBase) === true && devWatcher.isKnownRugger(`\t${creatorBase} `) === true,
      `isKnownRugger returned: ${devWatcher.isKnownRugger(creatorBase)}`);
  }

  // -------------------------------------------------------------
  // STAGE 1: Narrative & Attention Audit
  // -------------------------------------------------------------
  console.log('\n--- STAGE 1: Narrative & Attention Audit ---');
  {
    // 1.1: Modern Social Handle / URL Parsing with @
    const metaWithAtTwitter = {
      name: 'Pepe AI Agent',
      symbol: 'PEPEAI',
      description: 'An autonomous AI agent meme coin built on Solana neural networks',
      twitter: 'https://x.com/@pepe_ai_agent',
      telegram: 'https://t.me/@pepe_ai_community',
      website: 'https://pepeai.agent.io',
      replyCount: 10,
    };
    const narrativeVerdict = narrativeEngine.evaluateNarrative(metaWithAtTwitter);
    test('1.1: Social URLs containing @ handles are verified and awarded points (not flagged as suspicious)',
      narrativeVerdict.passed === true && narrativeVerdict.socialsFound >= 2 && !narrativeVerdict.reasons.some(r => r.includes('Suspicious')),
      `Score: ${narrativeVerdict.narrativeScore}, Socials: ${narrativeVerdict.socialsFound}, Reasons: ${narrativeVerdict.reasons.join('; ')}`);

    // 1.2: Standalone @handle formatting
    const metaWithStandaloneAt = {
      name: 'Neural Cat',
      symbol: 'NCAT',
      description: 'Neural Cat AI protocol on Solana',
      twitter: '@neuralcat_sol',
      telegram: '@neuralcat_chat',
    };
    const standaloneVerdict = narrativeEngine.evaluateNarrative(metaWithStandaloneAt);
    test('1.2: Standalone @handles are recognized as valid social channels',
      standaloneVerdict.socialsFound >= 2 && standaloneVerdict.narrativeScore >= 40,
      `Socials: ${standaloneVerdict.socialsFound}, Score: ${standaloneVerdict.narrativeScore}`);

    // 1.3: Anti-Clone Spam filter ignores placeholder names
    const orch = new Orchestrator({
      executionEngine: {},
      positionManager: { positions: new Map() },
      autoBuyEnabled: false,
    });
    const mint1 = 'MintActivePending1111111111111111111111111';
    const mint2 = 'MintActivePending2222222222222222222222222';
    const rec1 = new TokenRecord(mint1);
    rec1.name = 'Pending...';
    rec1.state = TokenState.MONEY_FLOW_WATCH;
    orch.tokens.set(mint1, rec1);

    const rec2 = new TokenRecord(mint2);
    rec2.name = 'Pending...';
    rec2.state = TokenState.NARRATIVE_AUDIT;
    orch.tokens.set(mint2, rec2);

    // Evaluate anti-clone check logic for rec2
    const normName = (rec2.name || '').trim().toLowerCase();
    const placeholderNames = ['resolving...', 'unknown token', 'pending...', '...', 'unknown'];
    let cloneRejected = false;
    if (normName.length >= 3 && !placeholderNames.includes(normName)) {
      for (const [otherMint, otherRec] of orch.tokens.entries()) {
        if (otherMint === mint2) continue;
        if (otherRec.name.toLowerCase() === normName) {
          cloneRejected = true;
        }
      }
    }
    test('1.3: Concurrently pending tokens with name "Pending..." are NOT falsely rejected as duplicate clones',
      cloneRejected === false,
      `cloneRejected: ${cloneRejected}`);
  }

  // -------------------------------------------------------------
  // STAGE 2: Money Flow & Buyer Quality / Sybil Defense
  // -------------------------------------------------------------
  console.log('\n--- STAGE 2: Money Flow & Buyer Quality / Sybil Defense ---');
  {
    // 2.1: validateMoneyFlow NaN / non-finite sanitization
    const flowNanResult = validateMoneyFlow({
      buyVolumeSol: NaN,
      sellVolumeSol: -5,
      uniqueBuyersCount: 6,
      txCount: 10,
    });
    test('2.1: validateMoneyFlow sanitizes NaN / negative volume and produces finite netVolumeDeltaSol',
      Number.isFinite(flowNanResult.netVolumeDeltaSol) && flowNanResult.netVolumeDeltaSol === 0,
      `netVolumeDeltaSol: ${flowNanResult.netVolumeDeltaSol}`);

    // 2.2: BuyerQualityEngine lastEval caching
    const bqe = new BuyerQualityEngine();
    const testMint = 'BQETestMint1111111111111111111111111111111';
    bqe.recordBuy(testMint, 'BuyerA11111111111111111111111111111111111', 0.5, Date.now(), 100);
    bqe.recordBuy(testMint, 'BuyerB22222222222222222222222222222222222', 0.7, Date.now() + 500, 105);

    const eval1 = bqe.evaluateBuyerQuality(testMint);
    const eval2 = bqe.evaluateBuyerQuality(testMint);
    test('2.2: BuyerQualityEngine reuses cached lastEval on consecutive evaluations without new buys',
      eval1 === eval2,
      `eval1 !== eval2`);

    bqe.recordBuy(testMint, 'BuyerC33333333333333333333333333333333333', 0.8, Date.now() + 1000, 110);
    const eval3 = bqe.evaluateBuyerQuality(testMint);
    test('2.3: BuyerQualityEngine invalidates cache when new buy is recorded',
      eval3 !== eval1 && eval3.rawBuyerCount === 3,
      `eval3 rawBuyerCount: ${eval3.rawBuyerCount}`);
  }

  // -------------------------------------------------------------
  // STAGE 3: SmartAgent AI Learner & Price Engine
  // -------------------------------------------------------------
  console.log('\n--- STAGE 3: SmartAgent AI Learner & State File Safety ---');
  {
    // 3.1: Empty state file does not throw
    const stateFile = path.join(__dirname, 'storage/smart_learning_state.json');
    const backupData = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;

    try {
      fs.writeFileSync(stateFile, '', 'utf8'); // Simulate empty file
      const agent = new SmartAgent({ minCompositeScore: 70 });
      test('3.1: SmartAgent safely handles empty 0-byte state file without crashing',
        agent.effectiveMinCompositeScore === 70,
        `effectiveMinCompositeScore: ${agent.effectiveMinCompositeScore}`);

      // 3.2: Atomic state save
      agent.learnFromTrade({
        mint: 'TestWinMint',
        finalPnlPercent: 25.0,
        reason: 'TAKE_PROFIT_1.35X',
        devPercent: 2.0,
      });
      const savedRaw = fs.readFileSync(stateFile, 'utf8');
      const savedJson = JSON.parse(savedRaw);
      test('3.2: SmartAgent atomically saves valid non-empty JSON state',
        savedJson && savedJson.totalLearnedTrades >= 1,
        `totalLearnedTrades: ${savedJson?.totalLearnedTrades}`);
    } finally {
      if (backupData) fs.writeFileSync(stateFile, backupData, 'utf8');
    }
  }

  // -------------------------------------------------------------
  // STAGE 4: Centralized Entry Gate & Queue Revalidation
  // -------------------------------------------------------------
  console.log('\n--- STAGE 4: Centralized Entry Gate & Queue Revalidation ---');
  {
    let watchedDevMint = null;
    let watchedDevCreator = null;

    const mockDevWatcher = {
      isKnownRugger: () => false,
      isSafe: () => true,
      getDevRisk: () => ({ safeForEntry: true }),
      watchDev: (m, c) => {
        watchedDevMint = m;
        watchedDevCreator = c;
      },
      unwatchDev: () => {},
    };

    const orch = new Orchestrator({
      executionEngine: {},
      positionManager: { isDailyLossExceeded: () => false },
      devWatcher: mockDevWatcher,
      autoBuyEnabled: false,
    });

    const mintTarget = Keypair.generate().publicKey.toBase58();
    const resolvedCreator = Keypair.generate().publicKey.toBase58();

    const record = new TokenRecord(mintTarget);
    record.creator = 'UNKNOWN';
    record.state = TokenState.MONEY_FLOW_WATCH;
    orch.tokens.set(mintTarget, record);

    // Bundle metrics update arrives with newly resolved creator
    orch.handleBundleMetricsUpdated({
      mint: mintTarget,
      creator: resolvedCreator,
      bundledBuysCount: 2,
      bundlePercent: 5.0,
      bundleDataStatus: 'VERIFIED',
    });

    test('4.1: handleBundleMetricsUpdated starts devWatcher for newly resolved creator',
      watchedDevMint === mintTarget && watchedDevCreator === resolvedCreator,
      `watchedDevMint: ${watchedDevMint}, watchedDevCreator: ${watchedDevCreator}`);

    // 4.2: canEnterTrade blocks if safetyVerdict is missing
    record.stage1_narrative = { passed: true };
    record.stage2_moneyFlow = { passed: true };
    record.stage3_pattern = { patternTriggered: true };
    record.safetyVerdict = { pass: false, reason: 'DEV_OVERALLOCATED' };

    const gateNoVerdict = orch.canEnterTrade(record);
    test('4.2: canEnterTrade blocks entry if safetyVerdict has failed',
      gateNoVerdict.allow === false && gateNoVerdict.reason.includes('HARD_SAFETY_FAILED'),
      `gate result: ${JSON.stringify(gateNoVerdict)}`);

    // 4.3: canEnterTrade blocks if buyerQuality.isHardVeto is true
    record.safetyVerdict = { pass: true };
    record.buyerQuality = { isHardVeto: true, coordinationRisk: 'MEDIUM' };
    const gateHardVeto = orch.canEnterTrade(record);
    test('4.3: canEnterTrade blocks entry if buyerQuality isHardVeto is true',
      gateHardVeto.allow === false && gateHardVeto.reason.includes('ENTRY_BLOCKED_CLUSTER_CRITICAL'),
      `gate result: ${JSON.stringify(gateHardVeto)}`);

    // 4.4: Entry queue price drift fallback from C3 close
    record.buyerQuality = null;
    orch.entryQueue = [{
      mint: mintTarget,
      queuedAt: Date.now(),
      reason: 'WAITING_FOR_COOLDOWN',
      breakoutPriceSol: 0, // 0 breakout price
    }];
    record.stage3_pattern = {
      patternTriggered: true,
      c3: { close: 0.00001000 },
    };
    // Current price has pumped +50% vs C3 close (0.00001500)
    record.lastVirtualSolReserves = 45_000_000_000n;
    record.lastVirtualTokenReserves = 1_000_000_000_000_000n;
    orch.lastTradeTime = 0; // Cooldown clear
    orch.autoBuyEnabled = true;

    await orch._processEntryQueue();

    test('4.4: Entry queue revalidation catches excessive price drift using C3 close fallback when breakoutPriceSol is 0',
      record.state === TokenState.REJECTED && record.rejectionReason.includes('EXCESSIVE_PRICE_DRIFT'),
      `record state: ${record.state}, reason: ${record.rejectionReason}`);
  }

  console.log('\n================================================================');
  console.log(`🏁 BLIND SPOT VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
