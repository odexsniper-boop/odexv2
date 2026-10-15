/**
 * test_live_engine_blindspots_deep_audit.js
 * Comprehensive Verification Suite for Deep Engine Blind Spots
 */

import { PublicKey, Keypair } from '@solana/web3.js';
import { BlockhashManager } from './engines/blockhashManager.js';
import { TransactionMonitor } from './engines/transactionMonitor.js';
import { TransactionBuilder } from './engines/transactionBuilder.js';
import { PositionManager } from './engines/positionManager.js';
import { DevWatcher } from './engines/devWatcher.js';
import { Orchestrator } from './engines/orchestrator.js';
import { RpcBlastDispatcher } from './engines/rpcBlastDispatcher.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { HardSafetyFilter } from './engines/safetyEngine.js';

let passed = 0;
let failed = 0;

function test(name, condition, errorMsg = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${errorMsg ? `(${errorMsg})` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING VERIFICATION SUITE: DEEP ENGINE BLIND SPOTS AUDIT');
  console.log('================================================================');

  // -------------------------------------------------------------
  // TEST 1: BlockhashManager Concurrent Fetch Coalescing
  // -------------------------------------------------------------
  console.log('\n--- TEST 1: BlockhashManager Concurrent Fetch Coalescing ---');
  {
    let fetchCallCount = 0;
    const mockConnection = {
      async getLatestBlockhash() {
        fetchCallCount++;
        await new Promise(r => setTimeout(r, 50));
        return {
          blockhash: 'MockBlockhash11111111111111111111111111111111',
          lastValidBlockHeight: 1000,
        };
      },
      async getBlockHeight() {
        return 900;
      },
    };

    const bm = new BlockhashManager(mockConnection);

    // Call getOrRefreshBlockhash concurrently 5 times while cache is empty
    const results = await Promise.all([
      bm.getOrRefreshBlockhash(),
      bm.getOrRefreshBlockhash(),
      bm.getOrRefreshBlockhash(),
      bm.getOrRefreshBlockhash(),
      bm.getOrRefreshBlockhash(),
    ]);

    test('1.1: All concurrent callers receive valid blockhash',
      results.every(r => r.blockhash === 'MockBlockhash11111111111111111111111111111111'),
      `Got blockhashes: ${results.map(r => r.blockhash).join(', ')}`);

    test('1.2: Fetch calls are coalesced into a single network request',
      fetchCallCount === 1,
      `Network calls made: ${fetchCallCount}`);
  }

  // -------------------------------------------------------------
  // TEST 2: TransactionMonitor Temporal Dead Zone (TDZ) Safety
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: TransactionMonitor TDZ Safety ---');
  {
    // Mock connection that synchronously confirms inside onSignature
    const mockSyncConnection = {
      onSignature(sig, callback) {
        // Synchronous callback execution!
        callback({ err: null, slot: 12345 });
        return 99;
      },
      removeSignatureListener() {},
    };

    const tm = new TransactionMonitor(mockSyncConnection);
    let didThrowTDZ = false;
    let trackResult = null;

    try {
      trackResult = await tm.track('sync_sig_123', { test: true });
    } catch (err) {
      didThrowTDZ = true;
      console.error('TDZ error thrown:', err);
    }

    test('2.1: Synchronous callback resolution does NOT trigger TDZ ReferenceError',
      !didThrowTDZ && trackResult?.status === 'SUCCESS',
      `didThrowTDZ=${didThrowTDZ}, status=${trackResult?.status}`);
  }

  // -------------------------------------------------------------
  // TEST 3: TransactionBuilder Blockhash Guard & Explicit Error
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: TransactionBuilder Blockhash Guard ---');
  {
    const emptyBlockhashManager = {
      async getOrRefreshBlockhash() {
        return { blockhash: null, lastValidBlockHeight: null };
      },
    };

    const mockExecutionCache = {
      connection: null,
      getTokenMeta() { return null; },
      getMintPDAs() {
        return {
          bc: Keypair.generate().publicKey,
          abc: Keypair.generate().publicKey,
          bcv2: Keypair.generate().publicKey,
        };
      },
      getUserPDAs() {
        return {
          userVolumeAccumulator: Keypair.generate().publicKey,
          userAta: Keypair.generate().publicKey,
        };
      },
      getCreatorVault() { return Keypair.generate().publicKey; },
      getFeeRecipients() {
        return {
          feeRecipient: Keypair.generate().publicKey,
          buybackRecipients: [],
        };
      },
      globalVolumeAccumulator: Keypair.generate().publicKey,
      feeConfig: Keypair.generate().publicKey,
    };

    const mockResolver = {
      async resolve() { return Keypair.generate().publicKey; },
    };

    const builder = new TransactionBuilder(mockExecutionCache, emptyBlockhashManager, mockResolver);
    const testWallet = Keypair.generate();
    const testMint = Keypair.generate().publicKey;

    let threwBlockhashError = false;
    let errorMessage = '';

    try {
      await builder.buildSignedBuyTransaction({
        wallet: testWallet,
        mint: testMint,
        tokenAmount: 1000000n,
        maxSolCostLamports: 100000000n,
        includeJitoTip: false,
      });
    } catch (err) {
      threwBlockhashError = true;
      errorMessage = err.message;
    }

    test('3.1: Explicit BLOCKHASH_UNAVAILABLE error thrown when blockhash is missing',
      threwBlockhashError && errorMessage.includes('BLOCKHASH_UNAVAILABLE'),
      `Threw: ${errorMessage}`);
  }

  // -------------------------------------------------------------
  // TEST 4: PositionManager Zero Division Guard
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: PositionManager Zero Division Guard ---');
  {
    const pm = new PositionManager(null);
    const zeroCostMint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint: zeroCostMint,
      spotPriceSol: 0.00001,
      solSpent: 0,
      actualBuyCost: 0,
      rawTokensReceived: '1000000000',
      tokensReceived: 1000,
      txHash: 'zero_cost_tx',
      timestamp: new Date().toISOString(),
    });

    const pos = pm.positions.get(zeroCostMint);
    test('4.1: Position opened with 0 initialSolSpent', pos.initialSolSpent === 0);

    // Close position
    pm.closePositionDirect(zeroCostMint, 'TEST_ZERO_COST_CLOSE');

    const closed = pm.tradeHistory.find(t => t.mint === zeroCostMint);
    test('4.2: finalPnlPercent does not evaluate to NaN or Infinity',
      closed && !isNaN(closed.finalPnlPercent) && isFinite(closed.finalPnlPercent) && closed.finalPnlPercent === 0,
      `finalPnlPercent was: ${closed?.finalPnlPercent}`);
  }

  // -------------------------------------------------------------
  // TEST 5: PositionManager 0-Token Clean Close Guard
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: PositionManager 0-Token Clean Close Guard ---');
  {
    let sellExecutionCalled = false;
    const mockExecution = {
      async executeSell() {
        sellExecutionCalled = true;
        return { txHash: 'mock_sell_tx', spotPriceSol: 0.00001, actualNetSellProceeds: 0.1 };
      },
    };

    const pm = new PositionManager(mockExecution);
    const emptyTokensMint = Keypair.generate().publicKey.toBase58();

    pm.openPosition({
      mint: emptyTokensMint,
      spotPriceSol: 0.00001,
      solSpent: 0.1,
      actualBuyCost: 0.1,
      rawTokensReceived: '1000000',
      tokensReceived: 1,
      txHash: 'tx_empty_test',
      timestamp: new Date().toISOString(),
    });

    // Manually set tokensHeldRaw to 0n (e.g. transferred out or previously fully sold)
    const pos = pm.positions.get(emptyTokensMint);
    pos.tokensHeldRaw = 0n;

    await pm.closePosition(emptyTokensMint, 30_000_000_000n, 1_000_000_000_000n, 'ZERO_TOKEN_CLEANUP');

    test('5.1: Position with 0 tokens held aborts on-chain sell dispatch',
      !sellExecutionCalled,
      `sellExecutionCalled was: ${sellExecutionCalled}`);

    test('5.2: Position with 0 tokens held is removed from active positions',
      !pm.positions.has(emptyTokensMint));
  }

  // -------------------------------------------------------------
  // TEST 6: DevWatcher PublicKey Rugger Normalization
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: DevWatcher PublicKey Rugger Normalization ---');
  {
    const dw = new DevWatcher(null, null);
    const ruggerKeypair = Keypair.generate();
    const ruggerPublicKey = ruggerKeypair.publicKey;
    const ruggerBase58 = ruggerPublicKey.toBase58();

    // Flag using PublicKey object
    dw.flagRugger(ruggerPublicKey);

    test('6.1: isKnownRugger matches string query when flagged with PublicKey object',
      dw.isKnownRugger(ruggerBase58) === true);

    test('6.2: isKnownRugger matches PublicKey query when flagged with PublicKey object',
      dw.isKnownRugger(ruggerPublicKey) === true);
  }

  // -------------------------------------------------------------
  // TEST 7: Orchestrator In-Flight Buys Capacity Guard
  // -------------------------------------------------------------
  console.log('\n--- TEST 7: Orchestrator In-Flight Buys Capacity Guard ---');
  {
    let inFlightBuyCountDuringExecution = 0;
    const mockExecution = {
      async executeBuy({ mint }) {
        // Record size of inFlightBuys while buy is executing
        inFlightBuyCountDuringExecution = orch.inFlightBuys.size;
        await new Promise(r => setTimeout(r, 20));
        return {
          mint,
          txHash: 'tx_inflight_test',
          spotPriceSol: 0.00001,
          solSpent: 0.1,
          actualBuyCost: 0.1,
          rawTokensReceived: '1000000000',
          tokensReceived: 1000,
          timestamp: new Date().toISOString(),
        };
      },
    };

    const pm = new PositionManager(mockExecution);
    pm.positions.clear();
    const orch = new Orchestrator({
      executionEngine: mockExecution,
      positionManager: pm,
      maxConcurrentPositions: 1, // Cap at 1
      autoBuyEnabled: true,
      tradeCooldownMs: 0,
    });

    test('7.1: inFlightBuys initialized as a Set', orch.inFlightBuys instanceof Set);

    const testMint1 = Keypair.generate().publicKey.toBase58();
    const testMint2 = Keypair.generate().publicKey.toBase58();

    const rec1 = new TokenRecord(testMint1);
    rec1.name = 'Token1';
    rec1.stage1_narrative = { passed: true, score: 80 };
    rec1.stage2_moneyFlow = { passed: true, score: 80, buySellRatio: 2.0, netVolumeDeltaSol: 2.0 };
    rec1.stage3_pattern = { patternTriggered: true, score: 90 };
    orch.tokens.set(testMint1, rec1);

    const rec2 = new TokenRecord(testMint2);
    rec2.name = 'Token2';
    rec2.stage1_narrative = { passed: true, score: 80 };
    rec2.stage2_moneyFlow = { passed: true, score: 80, buySellRatio: 2.0, netVolumeDeltaSol: 2.0 };
    rec2.stage3_pattern = { patternTriggered: true, score: 90 };
    orch.tokens.set(testMint2, rec2);

    // Launch first buy (starts in-flight)
    const buy1Promise = orch.triggerExecution(rec1);

    // Concurrently try to buy second token while first is in-flight
    await orch.triggerExecution(rec2);

    test('7.2: First buy is tracked in inFlightBuys during execution',
      inFlightBuyCountDuringExecution === 1,
      `inFlightBuys count was: ${inFlightBuyCountDuringExecution}`);

    test('7.3: Second buy is blocked / enqueued due to in-flight buy reaching maxConcurrentPositions',
      rec2.state === TokenState.WAITING_FOR_CAPACITY,
      `rec2 state was: ${rec2.state}`);

    await buy1Promise;

    test('7.4: inFlightBuys is cleanly cleared after buy completes',
      orch.inFlightBuys.size === 0);
    pm.positions.clear();
  }

  // -------------------------------------------------------------
  // TEST 8: Orchestrator Queue Concurrency Lock
  // -------------------------------------------------------------
  console.log('\n--- TEST 8: Orchestrator Queue Concurrency Lock ---');
  {
    const orch = new Orchestrator({
      executionEngine: null,
      positionManager: new PositionManager(null),
      autoBuyEnabled: true,
    });

    test('8.1: isProcessingQueue initialized to false', orch.isProcessingQueue === false);

    orch.isProcessingQueue = true;
    let didRun = false;
    orch.entryQueue.push({ mint: 'test_mint', queuedAt: Date.now() });

    // Calling _processEntryQueue while isProcessingQueue = true should immediately return without processing
    await orch._processEntryQueue();

    test('8.2: Concurrent call blocked while isProcessingQueue is active',
      orch.entryQueue.length === 1);

    orch.isProcessingQueue = false;
  }

  // -------------------------------------------------------------
  // TEST 9: RpcBlastDispatcher Jito vs Standard RPC Parameter Formatting
  // -------------------------------------------------------------
  console.log('\n--- TEST 9: RpcBlastDispatcher Jito vs Standard RPC Formatting ---');
  {
    const interceptedBodies = new Map();

    // Mock fetch globally for test 9
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      interceptedBodies.set(url, JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ result: 'sig_fastest_accept_123' }),
      };
    };

    try {
      const dispatcher = new RpcBlastDispatcher(null, {
        customEndpoints: [
          'https://mainnet.block-engine.jito.wtf/api/v1/transactions',
          'https://api.mainnet-beta.solana.com',
        ],
      });

      const wireBuf = Buffer.from('mock_wire_transaction_data_1234567890');
      await dispatcher.dispatch({
        wireTransaction: wireBuf,
        executionId: 'test_exec_999',
      });

      const jitoBody = interceptedBodies.get('https://mainnet.block-engine.jito.wtf/api/v1/transactions');
      const rpcBody = interceptedBodies.get('https://api.mainnet-beta.solana.com');

      test('9.1: Jito endpoint receives single base64 string param without options object',
        jitoBody && Array.isArray(jitoBody.params) && jitoBody.params.length === 1 && typeof jitoBody.params[0] === 'string',
        `Jito params length: ${jitoBody?.params?.length}`);

      test('9.2: Standard Solana RPC endpoint receives options object with skipPreflight',
        rpcBody && Array.isArray(rpcBody.params) && rpcBody.params.length === 2 && rpcBody.params[1]?.skipPreflight === true,
        `RPC params length: ${rpcBody?.params?.length}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log('\n================================================================');
  console.log(`🏁 DEEP AUDIT VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal Test Exception:', err);
  process.exit(1);
});
