import { PublicKey } from '@solana/web3.js';
import { calculateTokensOut, calculateSolOut, calculateSpotPriceSol } from '../pumpfun.js';
import { eventBus } from '../eventBus.js';
import { log } from '../config.js';

export class ExecutionController {
  /**
   * @param {object} config
   * @param {import('./blockhashManager.js').BlockhashManager} config.blockhashManager
   * @param {import('./executionCache.js').ExecutionCache} config.executionCache
   * @param {import('./tokenProgramResolver.js').TokenProgramResolver} config.tokenResolver
   * @param {import('./transactionBuilder.js').TransactionBuilder} config.transactionBuilder
   * @param {import('./jitoDispatcher.js').JitoDispatcher | import('./transactionDispatcher.js').TransactionDispatcher} config.dispatcher
   * @param {import('./transactionMonitor.js').TransactionMonitor} config.transactionMonitor
   * @param {object} [options]
   */
  constructor({
    blockhashManager,
    executionCache,
    tokenResolver,
    transactionBuilder,
    dispatcher,
    transactionDispatcher,
    transactionMonitor,
    wallet = null,
    connection = null,
    isPaperTrading = true,
    defaultPriorityFee = 100_000,
    defaultJitoTipLamports = 10_000_000,
    defaultSlippageBps = 1500,
  }) {
    this.blockhashManager = blockhashManager;
    this.cache = executionCache;
    this.tokenResolver = tokenResolver;
    this.builder = transactionBuilder;
    this.dispatcher = dispatcher || transactionDispatcher;
    this.monitor = transactionMonitor;

    this.wallet = wallet;
    this.connection = connection;
    this.isPaperTrading = isPaperTrading;
    this.defaultPriorityFee = defaultPriorityFee;
    this.defaultJitoTipLamports = defaultJitoTipLamports;
    this.defaultSlippageBps = defaultSlippageBps;

    // Idempotency: Map of in-flight execution keys to prevent duplicate clicks / signals
    this.inFlightExecutions = new Map();
  }

  /**
   * Generates a deterministic trade context and checks idempotency
   */
  createTradeContext(action, mint, amount, reason = '') {
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    const isEmergency = action === 'SELL' && (
      reason.includes('EMERGENCY') ||
      reason.includes('DEV_RUG') ||
      reason.includes('FRONTRUN') ||
      reason.includes('FLASH_DUMP')
    );
    const executionId = `${action}:${mintStr}:${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const idempotencyKey = isEmergency ? `EMERGENCY_SELL:${mintStr}` : `${action}:${mintStr}`;

    return {
      executionId,
      idempotencyKey,
      action,
      mint: mintStr,
      amount,
      reason,
      isEmergency,
      createdAt: Date.now(),
    };
  }

  /**
   * Fast local non-blocking pre-trade validation (0ms)
   */
  validateExecution(context) {
    if (this.inFlightExecutions.has(context.idempotencyKey)) {
      const active = this.inFlightExecutions.get(context.idempotencyKey);
      // For emergency trades, use 1000ms debounce against duplicate notifications; standard trades use 2500ms
      const lockWindow = context.isEmergency ? 1000 : 2500;
      if (Date.now() - active.createdAt < lockWindow) {
        throw new Error(`DUPLICATE_EXECUTION_REJECTED: Active trade in flight for ${context.mint}`);
      }
    }

    if (!this.isPaperTrading && !this.wallet) {
      throw new Error('WALLET_NOT_CONFIGURED: Live trading requires wallet');
    }

    if (!context.mint || context.mint.length < 32) {
      throw new Error(`INVALID_MINT: Invalid token mint address ${context.mint}`);
    }

    return true;
  }

  /**
   * Coordinates Buy Execution
   */
  async buy({
    mint,
    solAmount,
    virtualSolReserves = 30_000_000_000n,
    virtualTokenReserves = 1_073_000_000_000_000n,
    slippageBps = this.defaultSlippageBps,
    creator = null,
    priorityFee = this.defaultPriorityFee,
    jitoTipLamports = this.defaultJitoTipLamports,
    isMayhemMode = null,
  }) {
    const startTime = performance.now();
    const context = this.createTradeContext('BUY', mint, solAmount);
    this.validateExecution(context);
    this.inFlightExecutions.set(context.idempotencyKey, context);

    try {
      // Fix 5: Explicit Slippage Input Validation
      const rawSlippage = Number(slippageBps);
      if (isNaN(rawSlippage) || !isFinite(rawSlippage) || rawSlippage < 0) {
        throw new Error(`INVALID_SLIPPAGE: Slippage bps must be a non-negative finite number (got ${slippageBps})`);
      }
      const validatedSlippageBps = Math.min(rawSlippage, 5000);

      const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
      const solLamports = BigInt(Math.floor(solAmount * 1e9));

      // Resolve true live curve reserves (Amendment 3)
      let liveSolReserves = virtualSolReserves;
      let liveTokenReserves = virtualTokenReserves;
      let isStale = false;

      if (this.cache) {
        const cachedReserves = this.cache.getReserves(mint, 5000); // 5s max age
        if (cachedReserves) {
          liveSolReserves = cachedReserves.virtualSolReserves;
          liveTokenReserves = cachedReserves.virtualTokenReserves;
          isStale = cachedReserves.isStale;
        }
      }

      if (this.connection && (!liveSolReserves || liveSolReserves === 30_000_000_000n || isStale)) {
        try {
          if (typeof this.curveStateProvider === 'function') {
            const liveState = await this.curveStateProvider(mintPubkey);
            if (liveState && liveState.virtualSolReserves && liveState.virtualTokenReserves) {
              liveSolReserves = BigInt(liveState.virtualSolReserves);
              liveTokenReserves = BigInt(liveState.virtualTokenReserves);
              this.cache.updateReserves(mint, liveSolReserves, liveTokenReserves, 'provider');
              isStale = false;
            }
          }
          if (!liveSolReserves || liveSolReserves === 30_000_000_000n || isStale) {
            // Fix 6: Await authoritative token program resolution before PDA derivation
            const progId = this.tokenResolver ? (await this.tokenResolver.resolve(mintPubkey)) : TOKEN_PROGRAM_ID;
            const { bc } = this.cache.getMintPDAs(mintPubkey, progId);
            const bcAccount = await this.connection.getAccountInfo(bc, 'confirmed');
            if (bcAccount && bcAccount.data && bcAccount.data.length >= 24) {
              liveTokenReserves = bcAccount.data.readBigUInt64LE(8);
              liveSolReserves = bcAccount.data.readBigUInt64LE(16);
              this.cache.updateReserves(mint, liveSolReserves, liveTokenReserves, 'onchain_direct');
              isStale = false;
            } else {
              throw new Error('RESERVE_RESOLUTION_FAILED: Missing or stale reserves on established token');
            }
          }
        } catch (err) {
          if (err.message.includes('RESERVE_RESOLUTION_FAILED')) throw err;
        }
      }

      // Pure local math (< 0.1ms) with accurate live reserves
      const expectedTokensOut = calculateTokensOut(solLamports, liveSolReserves, liveTokenReserves);
      const slippageFactor = BigInt(Math.max(0, 10000 - validatedSlippageBps));
      let minTokensOut = (expectedTokensOut * slippageFactor) / 10000n;
      if (minTokensOut < 0n) minTokensOut = 0n;
      const spotPriceSol = calculateSpotPriceSol(liveSolReserves, liveTokenReserves);

      // Amendment 1: Transparent slippage math (NO hidden +5% cushion)
      const maxSolCostLamports = (solLamports * BigInt(10000 + validatedSlippageBps)) / 10000n;

      // Attach debug fields to context for Custom:6002 diagnostics (Amendment 22)
      context.expectedTokensOut = expectedTokensOut.toString();
      context.minTokensOut = minTokensOut.toString();
      context.maxSolCostLamports = maxSolCostLamports.toString();
      context.slippageBps = slippageBps;
      context.virtualSolReserves = liveSolReserves.toString();
      context.virtualTokenReserves = liveTokenReserves.toString();

      // 1. Paper Trading Fast-Path
      if (this.isPaperTrading) {
        const simulatedLatency = 800;
        await new Promise(resolve => setTimeout(resolve, simulatedLatency));
        
        // Exact fee simulation: deduct 1% pump.fun protocol fee from spendable SOL
        const netSolLamports = (solLamports * 10000n) / 10100n;
        const simulatedTokensOut = calculateTokensOut(netSolLamports, liveSolReserves, liveTokenReserves);
        
        // Exact fee simulation: Solana Base Fee + Priority Fee + Jito Tip (added to total spent)
        const actualTransactionFees = 0.000005;
        const actualPriorityFee = (priorityFee * 120_000) / 1e15; // CU is 120,000 for BUY
        const actualJitoTip = jitoTipLamports > 0 ? (jitoTipLamports / 1e9) : 0;
        const totalSolSpent = solAmount + actualTransactionFees + actualPriorityFee + actualJitoTip;
        
        const fill = {
          mode: 'PAPER',
          action: 'BUY',
          executionId: context.executionId,
          mint: mintPubkey.toBase58(),
          solSpent: solAmount,
          actualBuyCost: totalSolSpent,
          totalSolSpent,
          actualTransactionFees,
          priorityFee: actualPriorityFee,
          jitoTip: actualJitoTip,
          tokensReceived: Number(simulatedTokensOut) / 1e6,
          rawTokensReceived: simulatedTokensOut.toString(),
          expectedTokensReceived: Number(expectedTokensOut) / 1e6,
          spotPriceSol,
          slippageBps,
          latencyMs: Math.round(performance.now() - startTime + simulatedLatency),
          timestamp: new Date().toISOString(),
          txHash: `sim_buy_${Date.now()}_${mintPubkey.toBase58().slice(0, 8)}`,
        };

        this.inFlightExecutions.delete(context.idempotencyKey);
        eventBus.emit('TRADE_EXECUTED', fill);
        log(`[PAPER BUY] ${fill.tokensReceived.toFixed(2)} tokens for ${totalSolSpent.toFixed(4)} SOL (Gross: ${solAmount} SOL) (${fill.latencyMs}ms)`);
        return fill;
      }

      // 2. Ultra-Low-Latency Live Path
      // Step A: Local Non-Blocking Compilation & Signing (< 3ms)
      const buildStart = performance.now();
      const { wireTransaction, transaction, userAta, progId, buildDurationMs, signDurationMs } =
        await this.builder.buildSignedBuyTransaction({
          wallet: this.wallet,
          mint: mintPubkey,
          tokenAmount: expectedTokensOut,
          maxSolCostLamports,
          creator,
          computeUnits: 120_000,
          priorityFeeMicroLamports: priorityFee,
          includeJitoTip: true,
          jitoTipLamports,
          isMayhemMode,
        });

      context.tokenProgramId = progId.toBase58();

      // Step B: Dispatch via JitoDispatcher (Base64) with controlled fallback (Amendment 4 & 6)
      const dispatchStart = performance.now();
      const dispatchRes = await this.dispatcher.dispatch({
        wireTransaction,
        transaction,
        executionId: context.executionId,
      });

      const signature = dispatchRes.signature;
      context.route = dispatchRes.route;

      eventBus.emit('ORDER_DISPATCHED', {
        action: 'BUY',
        mint: mintPubkey.toBase58(),
        signature,
        route: dispatchRes.route,
        jitoAccepted: dispatchRes.jitoAccepted,
        buildDurationMs,
        signDurationMs,
        dispatchDurationMs: dispatchRes.dispatchDurationMs,
      });

      // Step C: Decoupled Confirmation Tracking (SENT ≠ EXECUTED)
      const confirmationPromise = this.monitor.track(signature, context);

      // Wait for confirmed on-chain fill
      const monitorResult = await confirmationPromise;
      const totalLatencyMs = Math.round(performance.now() - startTime);

      // Fetch actual on-chain tokens received from user ATA (Amendment 10 & 26)
      let actualTokensReceived = minTokensOut;
      try {
        if (this.connection && userAta) {
          const userAtaAcc = await this.connection.getAccountInfo(userAta);
          if (userAtaAcc && userAtaAcc.data && userAtaAcc.data.length >= 72) {
            const onChainBal = userAtaAcc.data.readBigUInt64LE(64);
            if (onChainBal > 0n) {
              actualTokensReceived = onChainBal;
            }
          }
        }
      } catch (_) {}

      const fill = {
        mode: 'LIVE',
        action: 'BUY',
        executionId: context.executionId,
        mint: mintPubkey.toBase58(),
        solSpent: solAmount,
        tokensReceived: Number(actualTokensReceived) / 1e6,
        rawTokensReceived: actualTokensReceived.toString(),
        expectedTokensReceived: Number(expectedTokensOut) / 1e6,
        rawExpectedTokens: expectedTokensOut.toString(),
        spotPriceSol,
        slippageBps,
        buildDurationMs,
        signDurationMs,
        dispatchDurationMs: dispatchRes.dispatchDurationMs,
        confirmationLatencyMs: monitorResult.confirmationLatencyMs,
        latencyMs: totalLatencyMs,
        timestamp: new Date().toISOString(),
        txHash: signature,
      };

      this.inFlightExecutions.delete(context.idempotencyKey);
      if (this.dispatcher && this.dispatcher.cleanup) {
        this.dispatcher.cleanup(context.executionId);
      }

      eventBus.emit('TRADE_EXECUTED', fill);
      log(`[LIVE BUY CONFIRMED] TX: ${signature} in ${totalLatencyMs}ms (Build: ${buildDurationMs.toFixed(1)}ms, Sign: ${signDurationMs.toFixed(1)}ms, Route: ${dispatchRes.route})`);
      return fill;
    } catch (err) {
      this.inFlightExecutions.delete(context.idempotencyKey);
      if (this.dispatcher && this.dispatcher.cleanup) {
        this.dispatcher.cleanup(context.executionId);
      }
      log(`[BUY FAILED] ${err.message}`);
      throw err;
    }
  }

  /**
   * Coordinates Sell Execution
   */
  async sell({
    mint,
    tokenAmountRaw,
    virtualSolReserves = 30_000_000_000n,
    virtualTokenReserves = 1_073_000_000_000_000n,
    slippageBps = this.defaultSlippageBps,
    reason = 'TAKE_PROFIT',
    creator = null,
    priorityFee = this.defaultPriorityFee,
    jitoTipLamports = this.defaultJitoTipLamports,
    isMayhemMode = null,
  }) {
    const startTime = performance.now();
    const context = this.createTradeContext('SELL', mint, tokenAmountRaw, reason);
    this.validateExecution(context);
    this.inFlightExecutions.set(context.idempotencyKey, context);

    try {
      const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
      const tokensBigInt = BigInt(tokenAmountRaw);

      // Resolve true live curve reserves
      let liveSolReserves = virtualSolReserves;
      let liveTokenReserves = virtualTokenReserves;
      let isStale = false;

      if (this.cache) {
        const cachedReserves = this.cache.getReserves(mint, 5000); // 5s max age
        if (cachedReserves) {
          liveSolReserves = cachedReserves.virtualSolReserves;
          liveTokenReserves = cachedReserves.virtualTokenReserves;
          isStale = cachedReserves.isStale;
        }
      }

      if (this.connection && (!liveSolReserves || liveSolReserves === 30_000_000_000n || isStale)) {
        try {
          if (typeof this.curveStateProvider === 'function') {
            const liveState = await this.curveStateProvider(mintPubkey);
            if (liveState && liveState.virtualSolReserves && liveState.virtualTokenReserves) {
              liveSolReserves = BigInt(liveState.virtualSolReserves);
              liveTokenReserves = BigInt(liveState.virtualTokenReserves);
              this.cache.updateReserves(mint, liveSolReserves, liveTokenReserves, 'provider');
              isStale = false;
            }
          }
          if (!liveSolReserves || liveSolReserves === 30_000_000_000n || isStale) {
            // Fix 6: Await authoritative token program resolution before PDA derivation
            const progId = this.tokenResolver ? (await this.tokenResolver.resolve(mintPubkey)) : TOKEN_PROGRAM_ID;
            const { bc } = this.cache.getMintPDAs(mintPubkey, progId);
            const bcAccount = await this.connection.getAccountInfo(bc, 'confirmed');
            if (bcAccount && bcAccount.data && bcAccount.data.length >= 24) {
              liveTokenReserves = bcAccount.data.readBigUInt64LE(8);
              liveSolReserves = bcAccount.data.readBigUInt64LE(16);
              this.cache.updateReserves(mint, liveSolReserves, liveTokenReserves, 'onchain_direct');
              isStale = false;
            } else {
              throw new Error('RESERVE_RESOLUTION_FAILED: Missing or stale reserves on established token');
            }
          }
        } catch (err) {
          if (err.message.includes('RESERVE_RESOLUTION_FAILED')) throw err;
        }
      }

      // Fix 5: Explicit Slippage Input Validation & Non-Negative BigInt Floor
      const rawSlippage = Number(slippageBps);
      if (isNaN(rawSlippage) || !isFinite(rawSlippage) || rawSlippage < 0) {
        throw new Error(`INVALID_SLIPPAGE: Slippage bps must be a non-negative finite number (got ${slippageBps})`);
      }

      // Emergency policy permits up to 10000 bps (100% floor). Standard trades permit max 5000 bps (50%).
      const maxAllowedSlippage = context.isEmergency ? 10000 : 5000;
      const validatedSlippageBps = Math.min(rawSlippage, maxAllowedSlippage);

      const expectedSolOut = calculateSolOut(tokensBigInt, liveSolReserves, liveTokenReserves);
      const slippageFactor = BigInt(Math.max(0, 10000 - validatedSlippageBps));
      let minSolOut = (expectedSolOut * slippageFactor) / 10000n;
      if (minSolOut < 0n) minSolOut = 0n;

      const solReceived = Number(expectedSolOut) / 1e9;
      const spotPriceSol = calculateSpotPriceSol(liveSolReserves, liveTokenReserves);

      context.expectedSolOut = expectedSolOut.toString();
      context.minSolOut = minSolOut.toString();
      context.slippageBps = validatedSlippageBps;
      context.virtualSolReserves = liveSolReserves.toString();
      context.virtualTokenReserves = liveTokenReserves.toString();

      // 1. Paper Mode
      if (this.isPaperTrading) {
        const simulatedLatency = 800;
        await new Promise(resolve => setTimeout(resolve, simulatedLatency));
        // Exact fee simulation
        const actualGrossSellProceeds = solReceived * 0.99; // 1% pump.fun protocol fee
        const actualTransactionFees = 0.000005; // Standard 5000 lamports
        const actualPriorityFee = (priorityFee * 100_000) / 1e15; // CU is 100,000 for SELL
        const actualJitoTip = jitoTipLamports > 0 ? (jitoTipLamports / 1e9) : 0;
        const totalFees = actualTransactionFees + actualPriorityFee + actualJitoTip;
        
        const actualNetSellProceeds = Math.max(0, actualGrossSellProceeds - totalFees);

        const fill = {
          mode: 'PAPER',
          action: 'SELL',
          reason,
          executionId: context.executionId,
          mint: mintPubkey.toBase58(),
          tokensSold: Number(tokensBigInt) / 1e6,
          expectedSolReceived: solReceived,
          actualGrossSellProceeds,
          actualTransactionFees,
          priorityFee: actualPriorityFee,
          jitoTip: actualJitoTip,
          actualNetSellProceeds,
          solReceived: actualNetSellProceeds,
          actualSolReceived: actualNetSellProceeds,
          spotPriceSol,
          slippageBps,
          latencyMs: Math.round(performance.now() - startTime + simulatedLatency),
          timestamp: new Date().toISOString(),
          txHash: `sim_sell_${Date.now()}_${mintPubkey.toBase58().slice(0, 8)}`,
        };

        this.inFlightExecutions.delete(context.idempotencyKey);
        eventBus.emit('TRADE_EXECUTED', fill);
        log(`[PAPER SELL] ${reason}: Sold ${fill.tokensSold.toFixed(2)} tokens for ${actualNetSellProceeds.toFixed(4)} SOL (Gross: ${actualGrossSellProceeds.toFixed(4)})`);
        return fill;
      }

      // 2. Ultra-Low-Latency Live Path
      const { wireTransaction, transaction, progId, buildDurationMs, signDurationMs } =
        await this.builder.buildSignedSellTransaction({
          wallet: this.wallet,
          mint: mintPubkey,
          tokenAmount: tokensBigInt,
          minSolOutputLamports: minSolOut,
          creator,
          computeUnits: 100_000,
          priorityFeeMicroLamports: priorityFee,
          includeJitoTip: true,
          jitoTipLamports,
          isMayhemMode,
        });

      context.tokenProgramId = progId.toBase58();

      const dispatchRes = await this.dispatcher.dispatch({
        wireTransaction,
        transaction,
        executionId: context.executionId,
      });

      const signature = dispatchRes.signature;
      context.route = dispatchRes.route;

      eventBus.emit('ORDER_DISPATCHED', {
        action: 'SELL',
        mint: mintPubkey.toBase58(),
        signature,
        route: dispatchRes.route,
        jitoAccepted: dispatchRes.jitoAccepted,
        buildDurationMs,
        signDurationMs,
        dispatchDurationMs: dispatchRes.dispatchDurationMs,
      });

      const monitorResult = await this.monitor.track(signature, context);
      const totalLatencyMs = Math.round(performance.now() - startTime);

      // Derive actual execution proceeds separating gross, fees, and tips (Amendments 4, 6, 21, 22)
      let actualGrossSellProceeds = Number(expectedSolOut) / 1e9;
      let actualTransactionFees = 0.000005; // Default base fee
      let actualPriorityFee = (priorityFee * 100_000) / 1e15;
      let actualJitoTip = dispatchRes.route.includes('JITO') ? (jitoTipLamports / 1e9) : 0;

      try {
        if (this.connection && signature) {
          const parsedTx = await this.connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (parsedTx && parsedTx.meta) {
            actualTransactionFees = (parsedTx.meta.fee || 5000) / 1e9;
            const accountKeys = parsedTx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey?.toBase58()));
            const walletStr = this.wallet.publicKey.toBase58();
            const walletIndex = accountKeys.indexOf(walletStr);
            if (walletIndex !== -1 && parsedTx.meta.preBalances && parsedTx.meta.postBalances) {
              const walletPre = BigInt(parsedTx.meta.preBalances[walletIndex]);
              const walletPost = BigInt(parsedTx.meta.postBalances[walletIndex]);
              const solDelta = Number(walletPost - walletPre) / 1e9;
              const recoveredGross = solDelta + actualTransactionFees + actualJitoTip;
              actualGrossSellProceeds = recoveredGross > 0 ? recoveredGross : 0;
            }
          }
        }
      } catch (_) {}

      const totalFees = actualTransactionFees + actualJitoTip;
      const actualNetSellProceeds = Math.max(0, actualGrossSellProceeds - totalFees);

      const fill = {
        mode: 'LIVE',
        action: 'SELL',
        reason,
        executionId: context.executionId,
        mint: mintPubkey.toBase58(),
        tokensSold: Number(tokensBigInt) / 1e6,
        expectedSolReceived: Number(expectedSolOut) / 1e9,
        actualGrossSellProceeds,
        actualTransactionFees,
        priorityFee: actualPriorityFee,
        jitoTip: actualJitoTip,
        actualNetSellProceeds,
        solReceived: actualNetSellProceeds,
        actualSolReceived: actualNetSellProceeds,
        spotPriceSol,
        slippageBps,
        buildDurationMs,
        signDurationMs,
        dispatchDurationMs: dispatchRes.dispatchDurationMs,
        confirmationLatencyMs: monitorResult.confirmationLatencyMs,
        latencyMs: totalLatencyMs,
        timestamp: new Date().toISOString(),
        txHash: signature,
        route: dispatchRes.route,
      };

      this.inFlightExecutions.delete(context.idempotencyKey);
      if (this.dispatcher && this.dispatcher.cleanup) {
        this.dispatcher.cleanup(context.executionId);
      }

      eventBus.emit('TRADE_EXECUTED', fill);
      log(`[LIVE SELL CONFIRMED] TX: ${signature} in ${totalLatencyMs}ms`);
      return fill;
    } catch (err) {
      this.inFlightExecutions.delete(context.idempotencyKey);
      if (this.dispatcher && this.dispatcher.cleanup) {
        this.dispatcher.cleanup(context.executionId);
      }
      log(`[SELL FAILED] ${err.message}`);
      throw err;
    }
  }

  /**
   * Clean shutdown of background resources
   */
  shutdown() {
    if (this.blockhashManager) this.blockhashManager.stop();
    if (this.cache) this.cache.stop();
    if (this.monitor) this.monitor.stop();
  }
}
