import { PublicKey } from '@solana/web3.js';
import { CONFIG, log } from '../config.js';
import { eventBus } from '../eventBus.js';

// Modular Ultra-Low-Latency Sub-Engines
import { BlockhashManager } from './blockhashManager.js';
import { ExecutionCache } from './executionCache.js';
import { TokenProgramResolver } from './tokenProgramResolver.js';
import { TransactionBuilder } from './transactionBuilder.js';
import { JitoDispatcher } from './jitoDispatcher.js';
import { RpcBlastDispatcher } from './rpcBlastDispatcher.js';
import { TransactionDispatcher } from './transactionDispatcher.js';
import { TransactionMonitor } from './transactionMonitor.js';
import { ExecutionController } from './executionController.js';

export class ExecutionEngine {
  constructor(options = {}) {
    this.isPaperTrading = options.paperTrading ?? CONFIG.DRY_RUN;
    this.wallet = options.wallet || null;
    this.connection = options.connection || null;
    this.defaultPriorityFeeMicroLamports = options.priorityFee || 100_000;
    this.jitoTipLamports = options.jitoTipLamports || 10_000_000; // 0.01 SOL default tip
    this.defaultSlippageBps = options.slippageBps || 1500; // 15% default slippage

    // Initialize ultra-low-latency pipeline modules
    this.blockhashManager = new BlockhashManager(this.connection);
    this.executionCache = new ExecutionCache(this.connection);
    this.tokenResolver = new TokenProgramResolver(this.connection);
    this.transactionBuilder = new TransactionBuilder(
      this.executionCache,
      this.blockhashManager,
      this.tokenResolver
    );
    if (CONFIG.TRADING?.USE_RPC_BLAST) {
      this.jitoDispatcher = new RpcBlastDispatcher(this.connection);
    } else {
      this.jitoDispatcher = new JitoDispatcher(this.connection);
    }
    this.transactionDispatcher = this.jitoDispatcher;
    this.transactionMonitor = new TransactionMonitor(this.connection);

    this.controller = new ExecutionController({
      blockhashManager: this.blockhashManager,
      executionCache: this.executionCache,
      tokenResolver: this.tokenResolver,
      transactionBuilder: this.transactionBuilder,
      dispatcher: this.jitoDispatcher,
      transactionMonitor: this.transactionMonitor,
      wallet: this.wallet,
      connection: this.connection,
      isPaperTrading: this.isPaperTrading,
      defaultPriorityFee: this.defaultPriorityFeeMicroLamports,
      defaultJitoTipLamports: this.jitoTipLamports,
      defaultSlippageBps: this.defaultSlippageBps,
    });

    // Start background caches if connection is available
    if (this.connection && !this.isPaperTrading) {
      this.blockhashManager.start();
      this.executionCache.start();
    }
  }

  /**
   * Sets or updates wallet & connection dynamically
   */
  setWallet(wallet) {
    this.wallet = wallet;
    if (this.controller) this.controller.wallet = wallet;
  }

  setConnection(connection) {
    this.connection = connection;
    if (this.blockhashManager) this.blockhashManager.connection = connection;
    if (this.executionCache) this.executionCache.connection = connection;
    if (this.tokenResolver) this.tokenResolver.connection = connection;
    if (this.transactionDispatcher) this.transactionDispatcher.connection = connection;
    if (this.transactionMonitor) this.transactionMonitor.connection = connection;
    if (this.controller) this.controller.connection = connection;

    if (connection && !this.isPaperTrading) {
      this.blockhashManager.start();
      this.executionCache.start();
    }
  }

  get curveCache() {
    return this.executionCache ? this.executionCache.reservesCache : null;
  }

  /**
   * Updates hot curve state in RAM cache (called by curveWatcher, orchestrator, or external feeds)
   */
  updateCurveState(mint, state = {}) {
    const key = typeof mint === 'string' ? mint : mint.toBase58();
    const virtualSolReserves = state.virtualSolReserves ?? state.vSol ?? state.virtualSol;
    const virtualTokenReserves = state.virtualTokenReserves ?? state.vTokens ?? state.virtualToken;
    if (virtualSolReserves == null || virtualTokenReserves == null) return false;

    if (this.executionCache) {
      if (state.creator || state.isMayhemMode !== undefined) {
        this.executionCache.registerToken(key, {
          creator: state.creator,
          isMayhemMode: state.isMayhemMode,
        });
      }
      this.executionCache.updateReserves(
        key,
        virtualSolReserves,
        virtualTokenReserves,
        state.source || 'curveWatcher'
      );
    }
    return true;
  }

  /**
   * Pre-warms token metadata, token program, and creator vault in RAM
   */
  prewarmToken(mint, meta = {}) {
    const key = typeof mint === 'string' ? mint : mint.toBase58();
    if (this.executionCache) {
      this.executionCache.prewarmToken(key, meta);
    }
    if (this.tokenResolver) {
      this.tokenResolver.resolve(key).catch(() => {});
    }
  }

  /**
   * Configures a custom on-chain curve state provider fallback
   */
  setCurveStateProvider(provider) {
    this.curveStateProvider = provider;
    if (this.controller) this.controller.curveStateProvider = provider;
  }

  /**
   * Executes a Buy order (dispatches to ExecutionController)
   */
  async executeBuy({
    mint,
    solAmount,
    virtualSolReserves = 30_000_000_000n,
    virtualTokenReserves = 1_073_000_000_000_000n,
    slippageBps = this.defaultSlippageBps,
    creator = null,
    priorityFee = this.defaultPriorityFeeMicroLamports,
    jitoTipLamports = this.jitoTipLamports,
  }) {
    return await this.controller.buy({
      mint,
      solAmount,
      virtualSolReserves,
      virtualTokenReserves,
      slippageBps,
      creator,
      priorityFee,
      jitoTipLamports,
    });
  }

  /**
   * Executes a Sell order (dispatches to ExecutionController)
   */
  async executeSell({
    mint,
    tokenAmountRaw,
    virtualSolReserves = 30_000_000_000n,
    virtualTokenReserves = 1_073_000_000_000_000n,
    slippageBps = this.defaultSlippageBps,
    reason = 'TAKE_PROFIT',
    creator = null,
    priorityFee = this.defaultPriorityFeeMicroLamports,
    jitoTipLamports = this.jitoTipLamports,
  }) {
    return await this.controller.sell({
      mint,
      tokenAmountRaw,
      virtualSolReserves,
      virtualTokenReserves,
      slippageBps,
      reason,
      creator,
      priorityFee,
      jitoTipLamports,
    });
  }

  /**
   * Clean shutdown
   */
  shutdown() {
    if (this.controller) this.controller.shutdown();
  }
}
