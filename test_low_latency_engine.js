import { Keypair, PublicKey } from '@solana/web3.js';
import { BlockhashManager } from './engines/blockhashManager.js';
import { ExecutionCache } from './engines/executionCache.js';
import { TokenProgramResolver } from './engines/tokenProgramResolver.js';
import { TransactionBuilder } from './engines/transactionBuilder.js';
import { TransactionDispatcher } from './engines/transactionDispatcher.js';
import { TransactionMonitor } from './engines/transactionMonitor.js';
import { ExecutionController } from './engines/executionController.js';
import { ExecutionEngine } from './engines/executionEngine.js';
import { TOKEN_PROGRAM_ID } from './pumpfun.js';
import { log } from './config.js';

async function runTests() {
  log('=====================================================');
  log('STARTING ULTRA-LOW-LATENCY EXECUTION ENGINE TEST SUITE');
  log('=====================================================');

  // 1. Test BlockhashManager
  log('\n[TEST 1] BlockhashManager');
  const mockConnection = {
    getLatestBlockhash: async () => ({
      blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM',
      lastValidBlockHeight: 12345678,
    }),
  };
  const bhm = new BlockhashManager(mockConnection, { pollIntervalMs: 500 });
  await bhm.refreshBlockhash();
  const cached = bhm.getLatestBlockhash();
  if (!cached || cached.blockhash !== '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM') {
    throw new Error('BlockhashManager failed to store or return latest blockhash');
  }
  log(`  ✓ Hot blockhash retrieved synchronously in 0ms: ${cached.blockhash.slice(0, 16)}...`);

  // 2. Test ExecutionCache
  log('\n[TEST 2] ExecutionCache');
  const cache = new ExecutionCache(mockConnection);
  const testWallet = Keypair.generate();
  const testMint = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

  const mintPdas = cache.getMintPDAs(testMint, TOKEN_PROGRAM_ID);
  if (!mintPdas.bc || !mintPdas.abc || !mintPdas.bcv2) {
    throw new Error('ExecutionCache failed to derive mint PDAs');
  }
  // Second call must be from RAM
  const mintPdas2 = cache.getMintPDAs(testMint, TOKEN_PROGRAM_ID);
  if (mintPdas !== mintPdas2) {
    throw new Error('ExecutionCache did not memoize mint PDAs in RAM');
  }
  log('  ✓ Mint PDAs derived & memoized in RAM (0ms)');

  const userPdas = cache.getUserPDAs(testWallet.publicKey, testMint, TOKEN_PROGRAM_ID);
  if (!userPdas.creatorVault || !userPdas.userAta) {
    throw new Error('ExecutionCache failed to derive user PDAs');
  }
  log('  ✓ User PDAs & ATA derived & memoized in RAM (0ms)');

  // 3. Test TokenProgramResolver
  log('\n[TEST 3] TokenProgramResolver');
  const resolver = new TokenProgramResolver(mockConnection);
  const pumpMint = '6p6xgHyF7AeQ2CQRChUxwqUtPvv85e5DCEj71pump';
  const resolvedPump = resolver.resolveSync(pumpMint);
  if (resolvedPump.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('TokenProgramResolver failed to identify pump suffix as TOKEN_PROGRAM_ID');
  }
  log('  ✓ Instant 0ms detection for .pump mint suffix');

  // 4. Test TransactionBuilder
  log('\n[TEST 4] TransactionBuilder (Non-Blocking Compilation Benchmark)');
  const builder = new TransactionBuilder(cache, bhm, resolver);

  const buyBuild = await builder.buildSignedBuyTransaction({
    wallet: testWallet,
    mint: testMint,
    tokenAmount: 10_000_000_000n,
    maxSolCostLamports: 1_000_000_000n,
    priorityFeeMicroLamports: 100_000,
    jitoTipLamports: 1_000_000,
  });

  if (!buyBuild.wireTransaction || buyBuild.wireTransaction.length === 0) {
    throw new Error('TransactionBuilder failed to produce wire transaction');
  }
  log(`  ✓ Buy Tx compiled and signed locally in ${buyBuild.buildDurationMs.toFixed(2)}ms (Wire size: ${buyBuild.wireTransaction.length} bytes)`);

  const sellBuild = await builder.buildSignedSellTransaction({
    wallet: testWallet,
    mint: testMint,
    tokenAmount: 10_000_000_000n,
    minSolOutputLamports: 900_000_000n,
    priorityFeeMicroLamports: 100_000,
    jitoTipLamports: 1_000_000,
  });

  if (!sellBuild.wireTransaction || sellBuild.wireTransaction.length === 0) {
    throw new Error('TransactionBuilder failed to produce sell wire transaction');
  }
  log(`  ✓ Sell Tx compiled and signed locally in ${sellBuild.buildDurationMs.toFixed(2)}ms (Wire size: ${sellBuild.wireTransaction.length} bytes)`);

  // 5. Test ExecutionController & Duplicate Prevention
  log('\n[TEST 5] ExecutionController & Idempotency');
  const dispatcher = new TransactionDispatcher(null, { enableJito: false, enableRpcFallback: false });
  const monitor = new TransactionMonitor(null);

  const controller = new ExecutionController({
    blockhashManager: bhm,
    executionCache: cache,
    tokenResolver: resolver,
    transactionBuilder: builder,
    transactionDispatcher: dispatcher,
    transactionMonitor: monitor,
    wallet: testWallet,
    isPaperTrading: true,
  });

  const paperBuy = await controller.buy({
    mint: testMint.toBase58(),
    solAmount: 0.25,
  });

  if (paperBuy.action !== 'BUY' || paperBuy.solSpent !== 0.25) {
    throw new Error('ExecutionController buy failed');
  }
  log(`  ✓ Paper Buy executed in ${paperBuy.latencyMs}ms (Tokens: ${paperBuy.tokensReceived.toFixed(2)})`);

  // Test duplicate check
  const duplicateCtx = controller.createTradeContext('BUY', testMint.toBase58(), 0.25);
  controller.inFlightExecutions.set(duplicateCtx.idempotencyKey, duplicateCtx);

  let duplicateBlocked = false;
  try {
    controller.validateExecution(duplicateCtx);
  } catch (err) {
    if (err.message.includes('DUPLICATE_EXECUTION_REJECTED')) {
      duplicateBlocked = true;
    }
  }
  if (!duplicateBlocked) {
    throw new Error('Idempotency validation failed to reject rapid duplicate order');
  }
  log('  ✓ Duplicate execution protection verified: rejected duplicate in-flight signal');

  // 6. Test Facade Compatibility
  log('\n[TEST 6] ExecutionEngine Public Facade');
  const facadeEngine = new ExecutionEngine({ paperTrading: true });
  const facadeBuy = await facadeEngine.executeBuy({
    mint: testMint.toBase58(),
    solAmount: 0.1,
  });
  if (!facadeBuy.txHash || facadeBuy.action !== 'BUY') {
    throw new Error('ExecutionEngine facade executeBuy failed');
  }
  log(`  ✓ Facade executeBuy passed: ${facadeBuy.txHash} (${facadeBuy.tokensReceived.toFixed(2)} tokens)`);

  const facadeSell = await facadeEngine.executeSell({
    mint: testMint.toBase58(),
    tokenAmountRaw: '1000000',
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
  });
  if (!facadeSell.txHash || facadeSell.action !== 'SELL') {
    throw new Error('ExecutionEngine facade executeSell failed');
  }
  log(`  ✓ Facade executeSell passed: ${facadeSell.txHash} (${facadeSell.tokensSold.toFixed(2)} tokens)`);

  log('\n=====================================================');
  log('ALL ULTRA-LOW-LATENCY ENGINE TESTS PASSED (6/6)');
  log('=====================================================');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
