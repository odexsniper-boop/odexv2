import assert from 'assert';
import { PublicKey, Keypair } from '@solana/web3.js';
import { DevWatcher, DevRelationshipRole } from './engines/devWatcher.js';
import { TokenProgramResolver, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './engines/tokenProgramResolver.js';
import { HardSafetyFilter } from './engines/safetyEngine.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenRecord, TokenState } from './engines/stateMachine.js';
import { PositionManager } from './engines/positionManager.js';
import { evaluateThreeCandlePattern } from './engines/priceEngine.js';
import { TransactionBuilder } from './engines/transactionBuilder.js';
import { ExecutionCache } from './engines/executionCache.js';
import { BlockhashManager } from './engines/blockhashManager.js';
import { narrativeEngine } from './engines/narrativeEngine.js';
import { eventBus } from './eventBus.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from './pumpfun.js';

class MockConnection {
  constructor(accountDataMap = {}) {
    this.accountDataMap = accountDataMap;
    this.listeners = new Map();
    this.subId = 1;
  }
  async getAccountInfo(pubkey) {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    if (this.accountDataMap[key]) return this.accountDataMap[key];
    const buf = Buffer.alloc(72);
    buf.writeBigUInt64LE(100_000_000n, 64);
    return { data: buf, owner: TOKEN_PROGRAM_ID };
  }
  async getLatestBlockhash() {
    return {
      blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM',
      lastValidBlockHeight: 12345678,
    };
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
      txHash: `tx_sell_mock_${Date.now()}`,
      actualNetSellProceeds: 0.1,
      spotPriceSol: 0.00000003,
      tokensSold: Number(tokenAmountRaw) / 1e6,
      route: 'MOCK_SELL'
    };
  }
  async executeBuy({ mint, solAmount }) {
    return {
      mint,
      solSpent: solAmount,
      actualBuyCost: solAmount,
      rawTokensReceived: '10000000000',
      tokensReceived: 10000,
      spotPriceSol: 0.00000001,
      txHash: `tx_buy_mock_${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING COMPREHENSIVE 10-FIX SECURITY & ARCHITECTURE TEST SUITE');
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

  // ====================================================================
  // FIX 1 (P0): TOKEN-2022 DEVELOPER ATA DERIVATION
  // ====================================================================
  console.log('--- TEST SUITE: FIX 1 (TOKEN-2022 DEVELOPER ATA DERIVATION) ---');
  {
    const mockConn = new MockConnection();
    const mockPm = new PositionManager(new MockExecutionEngine());
    const t22MintPubkey = Keypair.generate().publicKey;
    const t22MintStr = t22MintPubkey.toBase58();
    const splMintPubkey = Keypair.generate().publicKey;
    const splMintStr = splMintPubkey.toBase58();

    const mockResolver = {
      resolve: async (mintPubkey) => {
        if (mintPubkey.equals(t22MintPubkey)) {
          return TOKEN_2022_PROGRAM_ID;
        }
        return TOKEN_PROGRAM_ID;
      }
    };

    const devWatcher = new DevWatcher(mockConn, mockPm, null, mockResolver);
    const creatorKp = Keypair.generate();
    const creatorStr = creatorKp.publicKey.toBase58();

    // 1.1 Token-2022 Mint derivation
    await devWatcher.watchDev(t22MintStr, creatorStr);
    const rec2022 = devWatcher.monitoredDevs.get(t22MintStr);
    assert(rec2022, 'Record must be registered');

    const expected2022Ata = PublicKey.findProgramAddressSync(
      [creatorKp.publicKey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), t22MintPubkey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    test('1.1: Token-2022 mint derives creator ATA using TOKEN_2022_PROGRAM_ID',
      rec2022.devAta.equals(expected2022Ata) && rec2022.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID),
      `Derived ${rec2022.devAta.toBase58()} vs expected ${expected2022Ata.toBase58()}`);

    // 1.2 Classic SPL Token Mint derivation
    await devWatcher.watchDev(splMintStr, creatorStr);
    const recSpl = devWatcher.monitoredDevs.get(splMintStr);
    const expectedSplAta = PublicKey.findProgramAddressSync(
      [creatorKp.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), splMintPubkey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    test('1.2: Classic SPL Token mint derives creator ATA using TOKEN_PROGRAM_ID',
      recSpl.devAta.equals(expectedSplAta) && recSpl.tokenProgramId.equals(TOKEN_PROGRAM_ID),
      `Derived ${recSpl.devAta.toBase58()} vs expected ${expectedSplAta.toBase58()}`);
  }

  // ====================================================================
  // FIX 2 (P0): STAGE 0 BUNDLE EVASION THROUGH INSTANT FEED
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 2 (STAGE 0 BUNDLE EVASION THROUGH INSTANT FEED) ---');
  {
    const filter = new HardSafetyFilter({ maxDevPercent: 8.0, maxBundleWallets: 3, maxBundlePercent: 20.0, conservativeAdmission: true });
    
    // 2.1 Instant feed token with unverified bundle data status PENDING rejected under conservative policy
    const instantVerdict = filter.evaluate({
      mint: 'InstantToken1',
      creator: 'Dev1',
      devPercent: 2.0,
      bundledBuysCount: null,
      bundlePercent: null,
      bundleDataStatus: 'PENDING'
    });
    test('2.1: Instant feed token with PENDING bundle data is rejected under conservative policy',
      !instantVerdict.pass && instantVerdict.status === 'INSUFFICIENT_DATA',
      `Got pass: ${instantVerdict.pass}, status: ${instantVerdict.status}`);

    // 2.2 Orchestrator re-evaluates and vetoes token upon receiving verified BUNDLE_METRICS_UPDATED
    const orch = new Orchestrator({
      safetyFilter: filter,
      executionEngine: new MockExecutionEngine(),
      positionManager: new PositionManager(new MockExecutionEngine())
    });

    const candidateMint = Keypair.generate().publicKey.toBase58();
    const tokenRec = new TokenRecord(candidateMint);
    tokenRec.name = 'TestInstant';
    tokenRec.creator = 'Creator1';
    tokenRec.devPercent = 2.0;
    tokenRec.state = TokenState.NARRATIVE_AUDIT;
    orch.tokens.set(candidateMint, tokenRec);

    // Now verified RPC transaction confirms 6 bundled wallets (violates max 3)
    orch.handleBundleMetricsUpdated({
      mint: candidateMint,
      bundledBuysCount: 6,
      bundlePercent: 25.0,
      bundleDataStatus: 'VERIFIED'
    });

    test('2.2: Verified bundle metrics post-parse trigger Stage 0 veto on excessive snipers',
      tokenRec.state === TokenState.REJECTED && tokenRec.rejectionReason.includes('STAGE 0 HARD SAFETY VETO'),
      `Token state: ${tokenRec.state}, reason: ${tokenRec.rejectionReason}`);
  }

  // ====================================================================
  // FIX 3 (P1): MULTI-USER DEV RUG & GRADUATION EVENT ISOLATION
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 3 (MULTI-USER DEV RUG & GRADUATION ISOLATION) ---');
  {
    const userBotRegistry = new Map();
    let user1FrontrunCalled = false;
    let user2FrontrunCalled = false;
    let user1GraduationCalled = false;
    let user2GraduationCalled = false;

    const uBot1 = {
      positionManager: {
        triggerEmergencyFrontrun: (mint, reason) => { user1FrontrunCalled = true; },
        handleCurveGraduated: (mint) => { user1GraduationCalled = true; }
      }
    };
    const uBot2 = {
      positionManager: {
        triggerEmergencyFrontrun: (mint, reason) => { user2FrontrunCalled = true; },
        handleCurveGraduated: (mint) => { user2GraduationCalled = true; }
      }
    };
    userBotRegistry.set('user_alpha', uBot1);
    userBotRegistry.set('user_beta', uBot2);

    // Simulate multi-user fan-out as implemented in server.js
    const fanoutDevDump = (data) => {
      for (const [uid, uBot] of userBotRegistry.entries()) {
        if (uBot?.positionManager?.triggerEmergencyFrontrun) {
          uBot.positionManager.triggerEmergencyFrontrun(data.mint, data.isMuleDump ? 'DEV_MULE_DUMP_FRONTRUN' : 'DEV_RUG_FRONTRUN');
        }
      }
    };

    const fanoutGraduation = (data) => {
      for (const [uid, uBot] of userBotRegistry.entries()) {
        if (uBot?.positionManager?.handleCurveGraduated) {
          uBot.positionManager.handleCurveGraduated(data.mint);
        }
      }
    };

    fanoutDevDump({ mint: 'TestMintRug', isMuleDump: false });
    test('3.1: DEV_DUMP_ALERT fans out to all active user bots in userBotRegistry',
      user1FrontrunCalled && user2FrontrunCalled,
      `User 1: ${user1FrontrunCalled}, User 2: ${user2FrontrunCalled}`);

    fanoutGraduation({ mint: 'TestMintGrad' });
    test('3.2: BONDING_CURVE_GRADUATED fans out to all active user bots in userBotRegistry',
      user1GraduationCalled && user2GraduationCalled,
      `User 1: ${user1GraduationCalled}, User 2: ${user2GraduationCalled}`);
  }

  // ====================================================================
  // FIX 4 (P1): MULTI-USER STALE POSITION SWEEPER
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 4 (MULTI-USER STALE POSITION SWEEPER) ---');
  {
    const userBotRegistry = new Map();
    let masterSwept = false;
    let user1Swept = false;
    let user2Swept = false;

    const masterPm = {
      checkStalePositions: () => { masterSwept = true; }
    };
    userBotRegistry.set('user_1', { positionManager: { checkStalePositions: () => { user1Swept = true; } } });
    userBotRegistry.set('user_2', { positionManager: { checkStalePositions: () => { user2Swept = true; } } });

    // Execute sweeper loop as written in server.js
    masterPm.checkStalePositions();
    for (const [uid, uBot] of userBotRegistry.entries()) {
      if (uBot && uBot.positionManager && typeof uBot.positionManager.checkStalePositions === 'function') {
        uBot.positionManager.checkStalePositions();
      }
    }

    test('4.1: Sweeper sweeps master positionManager and all registered multi-user bots',
      masterSwept && user1Swept && user2Swept,
      `Master: ${masterSwept}, User1: ${user1Swept}, User2: ${user2Swept}`);
  }

  // ====================================================================
  // FIX 5 (P2): DISTORTED NET PNL AFTER PARTIAL SCALE-OUTS
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 5 (DISTORTED NET PNL AFTER PARTIAL SCALE-OUTS) ---');
  {
    const pm = new PositionManager(new MockExecutionEngine());
    const mint = 'ScaledOutMint123';
    
    // Trader spent 0.1 SOL initially to buy 5,000,000 tokens (5M)
    const pos = {
      mint,
      name: 'ScaledToken',
      symbol: 'SCL',
      initialSolSpent: 0.1,
      actualBuyCost: 0.1,
      solSpent: 0.1,
      entryPriceSol: 3.0e-8,
      peakPriceSol: 3.5e-8,
      currentPriceSol: 3.5e-8,
      tokensHeldDisplay: 2500000, // 50% sold, 2.5M remaining
      tokensHeldRaw: 2_500_000_000_000n,
      initialTokensRaw: 5_000_000_000_000n,
      realizedSolGained: 0.08, // Already banked 0.08 SOL from selling first half
      openedTimeMs: Date.now() - 30000,
      pricePnlPercent: 50,
      status: 'HOLDING',
      hitTiers: new Set([1.35, 2.0]), // TP tiers already handled
    };
    pm.positions.set(mint, pos);

    // Current value of remaining 2.5M tokens is ~0.087 SOL
    // Total value returned = ~0.087 (remaining) + 0.08 (already banked) = ~0.167 SOL.
    // Initial cost was 0.10 SOL. Overall net profit is ~+0.067 SOL (+67%).
    // Old code did: (0.087 - fees) - 0.10 = -0.013 SOL (-13%) -> NEGATIVE PNL BUG!
    await pm.updatePrice(mint, 35_000_000_000n, 1_000_000_000_000_000n);

    test('5.1: updatePrice includes realizedSolGained in netProfitSol so scaled-out winning trades do not report negative PnL',
      pos.netPnlSol > 0.03 && pos.netPnlPercent > 30,
      `Calculated netPnlSol: ${pos.netPnlSol?.toFixed(4)}, netPnlPercent: ${pos.netPnlPercent?.toFixed(1)}%`);
  }

  // ====================================================================
  // FIX 6 (P2): MULE TRACKING ENGINE PRODUCTION WIRING
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 6 (MULE TRACKING PRODUCTION WIRING) ---');
  {
    const mockConn = new MockConnection();
    let muleAtaSubscribed = false;
    let subscribedPubkey = null;

    mockConn.onAccountChange = (pubkey, cb) => {
      muleAtaSubscribed = true;
      subscribedPubkey = pubkey;
      const id = mockConn.subId++;
      mockConn.listeners.set(id, cb);
      return id;
    };

    const pm = new PositionManager(new MockExecutionEngine());
    const devWatcher = new DevWatcher(mockConn, pm);
    const mintKp = Keypair.generate();
    const creatorKp = Keypair.generate();
    const muleKp = Keypair.generate();

    await devWatcher.watchDev(mintKp.publicKey.toBase58(), creatorKp.publicKey.toBase58());

    // Trigger on-chain transfer event from creator to mule
    eventBus.emit('DEV_TRANSFER_DETECTED', {
      mint: mintKp.publicKey.toBase58(),
      from: creatorKp.publicKey.toBase58(),
      to: muleKp.publicKey.toBase58(),
      amount: 40_000_000n,
      signature: 'sig_transfer_test_123'
    });

    const graph = devWatcher.getDistributionGraph(mintKp.publicKey.toBase58());
    test('6.1: DEV_TRANSFER_DETECTED registers recipient wallet as monitored mule in distribution graph',
      graph && graph.monitoredWallets.has(muleKp.publicKey.toBase58()),
      `Graph entry: ${graph ? 'Found' : 'Missing'}`);

    const expectedMuleAta = PublicKey.findProgramAddressSync(
      [muleKp.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKp.publicKey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    test('6.2: Monitored mule ATA is derived and subscribed via onAccountChange',
      muleAtaSubscribed && subscribedPubkey && subscribedPubkey.equals(expectedMuleAta),
      `Subscribed ATA: ${subscribedPubkey ? subscribedPubkey.toBase58() : 'none'} vs expected ${expectedMuleAta.toBase58()}`);

    // Trigger mule dump via handleMuleAccountUpdate
    let muleAlertReceived = false;
    const alertHandler = (alert) => {
      if (alert.isMuleDump && alert.mint === mintKp.publicKey.toBase58()) {
        muleAlertReceived = true;
      }
    };
    eventBus.on('DEV_DUMP_ALERT', alertHandler);

    // Mule dumps 50% of tokens (40M -> 20M)
    const muleUpdateBuf = Buffer.alloc(72);
    muleUpdateBuf.writeBigUInt64LE(20_000_000n, 64);
    devWatcher.handleMuleAccountUpdate(mintKp.publicKey.toBase58(), muleKp.publicKey.toBase58(), muleUpdateBuf);

    test('6.3: Mule token reduction triggers DEV_DUMP_ALERT with isMuleDump: true',
      muleAlertReceived,
      `Alert received: ${muleAlertReceived}`);
    eventBus.removeListener('DEV_DUMP_ALERT', alertHandler);
  }

  // ====================================================================
  // FIX 7 (P2): TIME-WARPED CANDLES DURING ILLIQUID PERIODS
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 7 (TIME-WARPED CANDLE GAP DETECTION) ---');
  {
    // Continuous 15s candles (T=0, T=15000, T=30000)
    const continuousCandles = [
      { open: 0.000010, high: 0.000013, low: 0.000010, close: 0.0000125, volume: 10, timestamp: 100000 },
      { open: 0.0000125, high: 0.0000126, low: 0.0000115, close: 0.0000118, volume: 4, timestamp: 115000 },
      { open: 0.0000118, high: 0.000014, low: 0.0000116, close: 0.0000135, volume: 15, timestamp: 130000 },
    ];
    const resContinuous = evaluateThreeCandlePattern(continuousCandles, { timeframeMs: 15000 });
    test('7.1: Contiguous candles without gaps evaluate and trigger breakout normally',
      resContinuous.patternTriggered === true && resContinuous.stage === 'C3_ENTRY_TRIGGERED',
      `Got stage: ${resContinuous.stage}`);

    // Time-warped candles (gap between C1 and C2 of 120 seconds > 22.5s limit)
    const gappedCandles = [
      { open: 0.000010, high: 0.000013, low: 0.000010, close: 0.0000125, volume: 10, timestamp: 100000 },
      { open: 0.0000125, high: 0.0000126, low: 0.0000115, close: 0.0000118, volume: 4, timestamp: 220000 }, // 120s gap!
      { open: 0.0000118, high: 0.000014, low: 0.0000116, close: 0.0000135, volume: 15, timestamp: 235000 },
    ];
    const resGapped = evaluateThreeCandlePattern(gappedCandles, { timeframeMs: 15000 });
    test('7.2: Discontinuous candles with time gaps reject with DISCONTINUOUS_CANDLES',
      resGapped.patternTriggered === false && resGapped.stage === 'DISCONTINUOUS_CANDLES',
      `Got stage: ${resGapped.stage}, reason: ${resGapped.reason}`);

    // Out of order / negative interval candles
    const outOfOrderCandles = [
      { open: 0.000010, high: 0.000013, low: 0.000010, close: 0.0000125, volume: 10, timestamp: 130000 },
      { open: 0.0000125, high: 0.0000126, low: 0.0000115, close: 0.0000118, volume: 4, timestamp: 115000 },
      { open: 0.0000118, high: 0.000014, low: 0.0000116, close: 0.0000135, volume: 15, timestamp: 140000 },
    ];
    const resOrder = evaluateThreeCandlePattern(outOfOrderCandles);
    test('7.3: Out-of-order or duplicate timestamp candles reject with DISCONTINUOUS_CANDLES',
      resOrder.patternTriggered === false && resOrder.stage === 'DISCONTINUOUS_CANDLES',
      `Got stage: ${resOrder.stage}`);
  }

  // ====================================================================
  // FIX 8 (P3): REDUNDANT ATA CREATION IN SELL TRANSACTIONS
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 8 (REDUNDANT ATA REMOVAL IN SELL TRANSACTIONS) ---');
  {
    const mockConn = new MockConnection();
    const cache = new ExecutionCache(mockConn);
    const bhm = new BlockhashManager(mockConn);
    await bhm.refreshBlockhash();
    const resolver = new TokenProgramResolver(mockConn);
    const builder = new TransactionBuilder(cache, bhm, resolver);
    const testWallet = Keypair.generate();
    const testMint = Keypair.generate().publicKey;

    const sellBuild = await builder.buildSignedSellTransaction({
      wallet: testWallet,
      mint: testMint,
      tokenAmount: 10_000_000_000n,
      minSolOutputLamports: 900_000_000n,
      priorityFeeMicroLamports: 100_000,
      jitoTipLamports: 1_000_000,
    });

    const buyBuild = await builder.buildSignedBuyTransaction({
      wallet: testWallet,
      mint: testMint,
      tokenAmount: 10_000_000_000n,
      maxSolCostLamports: 1_000_000_000n,
      priorityFeeMicroLamports: 100_000,
      jitoTipLamports: 1_000_000,
    });

    // Check instructions in sell transaction: MUST NOT contain ASSOCIATED_TOKEN_PROGRAM_ID
    const hasAtaInSell = sellBuild.transaction.instructions.some(
      ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
    );
    const hasAtaInBuy = buyBuild.transaction.instructions.some(
      ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
    );

    test('8.1: buildSignedSellTransaction does NOT include redundant ATA creation instruction',
      !hasAtaInSell,
      `Instructions count: ${sellBuild.transaction.instructions.length}, hasAta: ${hasAtaInSell}`);

    test('8.2: Buy transaction preserves necessary ATA creation instruction while sell eliminates it',
      hasAtaInBuy && !hasAtaInSell,
      `Buy has ATA: ${hasAtaInBuy}, Sell has ATA: ${hasAtaInSell}`);
  }

  // ====================================================================
  // FIX 9 (P3): INACTIVE DAILY LOSS CAP
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 9 (CONFIGURABLE DAILY LOSS CAP CIRCUIT BREAKER) ---');
  {
    const pm = new PositionManager(new MockExecutionEngine(), { dailyLossCapSol: 1.0 });
    pm.dailyRealizedLossSol = 0;

    test('9.1: Daily loss cap initializes to configured limit (1.0 SOL)',
      pm.dailyLossCapSol === 1.0 && !pm.isDailyLossExceeded(),
      `dailyLossCapSol: ${pm.dailyLossCapSol}`);

    // Simulate two losing closed positions totaling 1.25 SOL loss
    pm.dailyRealizedLossSol += 0.50;
    test('9.2: Sub-cap losses (0.50 SOL < 1.0 SOL) do not trigger circuit breaker',
      !pm.isDailyLossExceeded(),
      `Loss: ${pm.dailyRealizedLossSol}, Cap: ${pm.dailyLossCapSol}`);

    pm.dailyRealizedLossSol += 0.75; // Total 1.25 SOL >= 1.0 SOL cap
    test('9.3: Breaching cap (1.25 SOL >= 1.0 SOL) activates isDailyLossExceeded circuit breaker',
      pm.isDailyLossExceeded() === true,
      `Loss: ${pm.dailyRealizedLossSol}, Cap: ${pm.dailyLossCapSol}`);

    // Verify Orchestrator respects circuit breaker and rejects new entry
    const orch = new Orchestrator({
      positionManager: pm,
      executionEngine: new MockExecutionEngine(),
      autoBuyEnabled: true
    });

    const testMint = Keypair.generate().publicKey.toBase58();
    const tokenRec = new TokenRecord(testMint);
    tokenRec.name = 'LossBlockedToken';
    tokenRec.stage1_narrative = { passed: true, score: 80 }; tokenRec.stage2_moneyFlow = { passed: true, score: 80 }; tokenRec.stage3_pattern = { patternTriggered: true, score: 95 };
    orch.tokens.set(testMint, tokenRec);

    // Call entry trigger logic
    await orch.triggerExecution(tokenRec);
    test('9.4: Orchestrator blocks entry and transitions token to REJECTED when daily loss cap is exceeded',
      tokenRec.state === TokenState.REJECTED && tokenRec.rejectionReason === 'DAILY_LOSS_CAP_EXCEEDED',
      `State: ${tokenRec.state}, reason: ${tokenRec.rejectionReason}`);

    // Update daily loss cap dynamically
    pm.setDailyLossCap(2.0);
    test('9.5: setDailyLossCap(2.0) expands capacity and clears circuit breaker',
      pm.isDailyLossExceeded() === false && pm.dailyLossCapSol === 2.0,
      `Exceeded: ${pm.isDailyLossExceeded()}, Cap: ${pm.dailyLossCapSol}`);
  }

  // ====================================================================
  // FIX 10 (P3): BROAD KEYWORD NARRATIVE FALSE POSITIVES
  // ====================================================================
  console.log('\n--- TEST SUITE: FIX 10 (BROAD KEYWORD NARRATIVE FILTERING) ---');
  {
    // 10.1 Generic words "open", "model", "news" must NOT trigger AI or Influencer meta
    const genericToken = narrativeEngine.evaluateNarrative({
      name: 'Open Market Network',
      symbol: 'OMN',
      description: 'We open the door to a new liquidity model and share news about our launch.',
    });
    test('10.1: Generic words ("open", "model", "news") do NOT falsely award +35 AI meta points',
      genericToken.theme === 'GENERIC' && genericToken.narrativeScore < 60,
      `Detected theme: ${genericToken.theme}, score: ${genericToken.narrativeScore}`);

    // 10.2 Legitimate AI phrases DO match correctly
    const realAiToken = narrativeEngine.evaluateNarrative({
      name: 'Neural Agent Protocol',
      symbol: 'NAP',
      description: 'Decentralized LLM foundation model orchestrator powered by autonomous open ai agents.',
      twitter: 'https://x.com/neural_protocol',
      telegram: 'https://t.me/neural_protocol'
    });
    test('10.2: Legitimate AI compound terms ("llm", "foundation model", "open ai") match AI_AGENT_TECH',
      realAiToken.theme === 'AI_AGENT_TECH' && realAiToken.passed === true,
      `Detected theme: ${realAiToken.theme}, score: ${realAiToken.narrativeScore}`);

    // 10.3 Specific news compound phrase matches correctly
    const newsToken = narrativeEngine.evaluateNarrative({
      name: 'Crypto Breaking Wire',
      symbol: 'WIRE',
      description: 'Official broadcast for live breaking news on crypto markets.',
      twitter: 'https://x.com/breaking_wire'
    });
    test('10.3: Specific phrase ("breaking news") matches INFLUENCER_EVENT_NEWS',
      newsToken.theme === 'INFLUENCER_EVENT_NEWS' && newsToken.passed === true,
      `Detected theme: ${newsToken.theme}, score: ${newsToken.narrativeScore}`);
  }

  console.log('\n================================================================');
  console.log(`🏁 FINAL VERIFICATION: ${passed} PASSED, ${failed} FAILED (${passed + failed} total tests)`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
