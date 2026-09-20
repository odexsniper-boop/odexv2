import { CONFIG, log } from '../config.js';
import { eventBus } from '../eventBus.js';
import { calculateSpotPriceSol, calculateSolOut } from '../pumpfun.js';
import { TradeStorage } from '../storage/tradeStorage.js';

export class PositionManager {
  constructor(executionEngine, options = {}) {
    this.execution = executionEngine;
    this.positions = new Map();
    this.tradeHistory = [];
    this.curveWatcher = null;
    this.devWatcher = null;

    const saved = TradeStorage.loadState();
    if (saved.tradeHistory && saved.tradeHistory.length > 0) {
      this.tradeHistory = saved.tradeHistory;
    }
    if (saved.positions && saved.positions.length > 0) {
      saved.positions.forEach(p => {
        // Restore BigInt values
        if (p.tokensHeldRaw) p.tokensHeldRaw = BigInt(p.tokensHeldRaw);
        if (p.initialTokensRaw) p.initialTokensRaw = BigInt(p.initialTokensRaw);
        if (p.lastKnownVirtualSol) p.lastKnownVirtualSol = BigInt(p.lastKnownVirtualSol);
        if (p.lastKnownVirtualTok) p.lastKnownVirtualTok = BigInt(p.lastKnownVirtualTok);
        if (p.hitTiers) p.hitTiers = new Set(p.hitTiers);
        
        this.positions.set(p.mint, p);
      });
    }

    this.takeProfitTiers = options.takeProfitTiers || [
      { triggerMultiplier: 1.35, sellPercent: 50 },  // +35%: Sell 50%
      { triggerMultiplier: 2.00, sellPercent: 100 }, // +100%: Sell remaining
    ];
    this.stopLossPercent = options.stopLossPercent !== undefined ? options.stopLossPercent : -16; // Exact -16% stop loss
    this.trailingStopActivation = options.trailingStopActivation || 1.25;
    this.trailingStopDistance = options.trailingStopDistance || 15;
    this.minHoldDurationMs = options.minHoldDurationMs !== undefined ? options.minHoldDurationMs : 8000; // 8s grace window
    this.staleTimeoutMs = options.staleTimeoutMs || 5 * 60 * 1000;

    // Daily Loss Cap guardrail disabled for testing
    this.dailyLossCapSol = Infinity;
    this.dailyRealizedLossSol = 0;
    this.lastLossResetDay = new Date().getUTCDate();

    eventBus.on('TOKEN_METADATA_UPDATED', (data) => {
      if (data?.mint && data?.imageUrl) {
        const pos = this.positions.get(data.mint);
        if (pos && !pos.imageUrl) pos.imageUrl = data.imageUrl;
        const th = this.tradeHistory.find(t => t.mint === data.mint);
        if (th && !th.imageUrl) {
          th.imageUrl = data.imageUrl;
          TradeStorage.saveState(this.positions, this.tradeHistory);
        }
      }
    });
  }

  /**
   * Resets daily loss bucket on UTC day rollover
   */
  _syncDailyLoss() {
    const today = new Date().getUTCDate();
    if (today !== this.lastLossResetDay) {
      this.dailyRealizedLossSol = 0;
      this.lastLossResetDay = today;
    }
  }

  isDailyLossExceeded() {
    return false;
  }

  setCurveWatcher(watcher) {
    this.curveWatcher = watcher;
    // Resume watching any restored positions
    for (const [mint, pos] of this.positions.entries()) {
      if (pos.status !== 'SOLD') {
        this.curveWatcher.watch(mint);
      }
    }
  }

  setDevWatcher(watcher) {
    this.devWatcher = watcher;
  }

  openPosition(buyFill, tokenMeta = {}) {
    const position = {
      mint: buyFill.mint,
      name: tokenMeta.name || 'Unknown Token',
      symbol: tokenMeta.symbol || 'UNK',
      imageUrl: tokenMeta.imageUrl || '',
      creator: tokenMeta.creator || 'UNKNOWN',
      devPercent: tokenMeta.devPercent || 0,
      bundledBuysCount: tokenMeta.bundledBuysCount || 0,
      entryScore: tokenMeta.entryScore || 0,
      entryPriceSol: buyFill.spotPriceSol,
      currentPriceSol: buyFill.spotPriceSol,
      peakPriceSol: buyFill.spotPriceSol,
      initialSolSpent: buyFill.actualBuyCost || buyFill.solSpent,
      actualBuyCost: buyFill.actualBuyCost || buyFill.solSpent,
      buyTransactionFees: buyFill.actualTransactionFees || 0,
      buyPriorityFee: buyFill.priorityFee || 0,
      buyJitoTip: buyFill.jitoTip || 0,
      tokensHeldRaw: BigInt(buyFill.rawTokensReceived),
      initialTokensRaw: BigInt(buyFill.rawTokensReceived),
      tokensHeldDisplay: buyFill.tokensReceived,
      expectedTokensOut: buyFill.expectedTokensReceived,
      actualTokensReceived: buyFill.tokensReceived,
      txHash: buyFill.txHash,
      route: buyFill.route || 'JITO:SENDTRANSACTION',
      openedAt: buyFill.timestamp,
      lastUpdated: buyFill.timestamp,
      openedTimeMs: Date.now(),
      pricePnlPercent: 0,
      priceChangePercent: 0,
      grossPnlSol: 0,
      grossPnlPercent: 0,
      estimatedFeesSol: (buyFill.actualTransactionFees || 0) + (buyFill.priorityFee || 0) + (buyFill.jitoTip || 0),
      netPnlSol: 0,
      netPnlPercent: 0,
      unrealizedPnlPercent: 0,
      unrealizedPnlSol: 0,
      realizedSolGained: 0,
      trailingActive: false,
      hitTiers: new Set(),
      status: 'HOLDING',
      lastKnownVirtualSol: 30_000_000_000n,
      lastKnownVirtualTok: 1_073_000_000_000_000n,
    };

    this.positions.set(position.mint, position);

    if (this.curveWatcher) {
      this.curveWatcher.watch(position.mint);
    }
    if (this.devWatcher && tokenMeta.creator) {
      this.devWatcher.watchDev(position.mint, tokenMeta.creator);
    }

    TradeStorage.saveState(this.positions, this.tradeHistory);

    eventBus.emit('POSITION_OPENED', {
      mint: position.mint,
      name: position.name,
      symbol: position.symbol,
      creator: position.creator,
      entryPriceSol: position.entryPriceSol,
      currentPriceSol: position.currentPriceSol,
      peakPriceSol: position.peakPriceSol,
      initialSolSpent: position.initialSolSpent,
      tokensHeldDisplay: position.tokensHeldDisplay,
      status: position.status,
      timestamp: position.openedAt,
    });
    log(`[POSITION OPENED] Tracking ${position.name} (${position.symbol}) at ${position.entryPriceSol.toExponential(4)} SOL`);
    return position;
  }

  async updatePrice(mint, virtualSolReserves, virtualTokenReserves) {
    const pos = this.positions.get(mint);
    if (!pos || pos.status === 'SOLD') return;

    pos.lastKnownVirtualSol = virtualSolReserves;
    pos.lastKnownVirtualTok = virtualTokenReserves;

    const currentPriceSol = calculateSpotPriceSol(virtualSolReserves, virtualTokenReserves);
    pos.currentPriceSol = currentPriceSol;
    pos.lastUpdated = new Date().toISOString();

    if (currentPriceSol > pos.peakPriceSol) {
      pos.peakPriceSol = currentPriceSol;
    }

    const priceRatio = currentPriceSol / pos.entryPriceSol;
    pos.priceRatio = priceRatio;
    pos.priceChangePercent = (priceRatio - 1) * 100;
    pos.pricePnlPercent = (priceRatio - 1) * 100; // PURE PRICE-BASED PNL %

    // 1. Gross PnL: Gross token value from curve vs gross buy cost (excluding fixed tips/fees)
    let grossSol = 0;
    if (pos.tokensHeldRaw && virtualSolReserves && virtualTokenReserves) {
      const expectedSolLamports = calculateSolOut(pos.tokensHeldRaw, virtualSolReserves, virtualTokenReserves);
      grossSol = Number(expectedSolLamports) / 1e9;
    } else {
      grossSol = (Number(pos.tokensHeldDisplay) || 0) * currentPriceSol;
    }
    const grossBuyCost = Number(pos.solSpent || (pos.initialSolSpent - (pos.buyJitoTip || 0) - (pos.buyPriorityFee || 0)) || pos.initialSolSpent || 0.1);
    const grossPnlSol = grossSol - grossBuyCost;
    const grossPnlPercent = grossBuyCost > 0 ? (grossPnlSol / grossBuyCost) * 100 : pos.pricePnlPercent;
    pos.grossSol = grossSol;
    pos.grossPnlSol = grossPnlSol;
    pos.grossPnlPercent = grossPnlPercent;

    // 2. Estimated Fees: Buy fees + estimated sell fees (pump.fun 1% fee + priority fee + Jito tip + tx fee)
    const jitoTip = (this.execution?.jitoTipLamports ?? this.execution?.controller?.defaultJitoTipLamports ?? 10_000_000) / 1e9;
    const priorityFeeMicros = this.execution?.defaultPriorityFeeMicroLamports ?? this.execution?.controller?.defaultPriorityFee ?? 100_000;
    const priorityFeeSol = (priorityFeeMicros * 100_000) / 1e15;
    const sellPumpFee = grossSol * 0.01;
    const estimatedSellFees = 0.000005 + priorityFeeSol + jitoTip + sellPumpFee;
    const buyFees = Number(pos.buyTransactionFees || 0) + Number(pos.buyPriorityFee || 0) + Number(pos.buyJitoTip || 0);
    const totalEstimatedFeesSol = buyFees + estimatedSellFees;
    pos.estimatedFeesSol = totalEstimatedFeesSol;

    // 3. Net PnL: After all buy/sell fees, Jito tips, priority fees, and protocol fees
    const estimatedGrossSol = grossSol * 0.99;
    const estimatedNetProceeds = Math.max(0, estimatedGrossSol - (0.000005 + priorityFeeSol + jitoTip));
    const netProfitSol = estimatedNetProceeds - (pos.initialSolSpent || 0.1);
    const netPnlPercent = pos.initialSolSpent ? (netProfitSol / pos.initialSolSpent) * 100 : pos.pricePnlPercent;

    pos.netPnlSol = netProfitSol;
    pos.netPnlPercent = netPnlPercent;
    pos.unrealizedPnlSol = netProfitSol;
    pos.unrealizedPnlPercent = netPnlPercent;

    eventBus.emit('POSITION_TICK', {
      mint: pos.mint,
      pnlPercent: pos.unrealizedPnlPercent,
      pricePnlPercent: pos.pricePnlPercent,
      grossPnlPercent: pos.grossPnlPercent,
      grossPnlSol: pos.grossPnlSol,
      estimatedFeesSol: pos.estimatedFeesSol,
      unrealizedPnlSol: pos.unrealizedPnlSol,
      netPnlSol: pos.netPnlSol,
      stopLossPercent: this.stopLossPercent,
      currentPriceSol,
      peakPriceSol: pos.peakPriceSol,
    });

    try {
      // 1. HARD STOP LOSS: Evaluates strictly on pricePnlPercent (token spot price movement)
      // Do not include fixed buy/sell Jito tips or priority fees when determining stop trigger
      // Grace period: do not trigger ordinary STOP_LOSS if hold duration < minHoldDurationMs UNLESS catastrophic flash-dump (<= -25%)
      if (pos.pricePnlPercent <= this.stopLossPercent) {
        const openedTime = pos.openedTimeMs || (pos.openedAt ? new Date(pos.openedAt).getTime() : 0);
        const holdDurationMs = Date.now() - openedTime;
        const isSevereFlashDump = pos.pricePnlPercent <= -25;
        if (holdDurationMs < this.minHoldDurationMs && !isSevereFlashDump) {
          // Grace period active for minor fluctuations: do not trigger ordinary STOP_LOSS
        } else {
          log(`[EXIT TRIGGER] Stop Loss hit on ${pos.name} (Price PnL: ${pos.pricePnlPercent.toFixed(1)}% <= ${this.stopLossPercent}%, Hold: ${(holdDurationMs / 1000).toFixed(1)}s >= ${(this.minHoldDurationMs / 1000).toFixed(1)}s${isSevereFlashDump ? ' [FLASH DUMP OVERRIDE]' : ''}) - Executing immediate exit.`);
          await this.closePosition(mint, virtualSolReserves, virtualTokenReserves, 'STOP_LOSS', 100, 10000);
          return;
        }
      }

      // 2. TRAILING STOP LOSS
      if (priceRatio >= this.trailingStopActivation) {
        pos.trailingActive = true;
      }
      if (pos.trailingActive) {
        const dropFromPeak = ((currentPriceSol - pos.peakPriceSol) / pos.peakPriceSol) * 100;
        if (dropFromPeak <= -this.trailingStopDistance) {
          log(`[EXIT TRIGGER] Trailing Stop hit on ${pos.name} (-${this.trailingStopDistance}%)`);
          await this.closePosition(mint, virtualSolReserves, virtualTokenReserves, 'TRAILING_STOP', 100, 10000);
          return;
        }
      }

      // 3. TAKE PROFIT TIERS
      for (let i = 0; i < this.takeProfitTiers.length; i++) {
        const tier = this.takeProfitTiers[i];
        if (priceRatio >= tier.triggerMultiplier && !pos.hitTiers.has(i)) {
          pos.hitTiers.add(i);
          log(`[EXIT TRIGGER] Take Profit ${tier.triggerMultiplier}x on ${pos.name}`);
          await this.closePosition(mint, virtualSolReserves, virtualTokenReserves, `TAKE_PROFIT_${tier.triggerMultiplier}X`, tier.sellPercent);
          break;
        }
      }
    } catch (err) {
      log(`[POSITION EXIT ERROR] Failed to execute exit for ${pos.name}: ${err.message}`);
    }
  }

  async triggerEmergencyFrontrun(mint, reason = 'HONEYPOT_DEV_DUMP') {
    const pos = this.positions.get(mint);
    if (!pos || pos.status === 'SOLD') return;

    log(`[EMERGENCY FRONTRUN] Executing sell for ${pos.name}`);
    try {
      await this.closePosition(mint, pos.lastKnownVirtualSol, pos.lastKnownVirtualTok, reason, 100, 10000);
    } catch (err) {
      log(`[EMERGENCY FRONTRUN ERROR] Failed frontrun sell for ${pos.name}: ${err.message}`);
    }
  }

  async checkStalePositions() {
    const now = Date.now();
    for (const [mint, pos] of this.positions.entries()) {
      if (now - pos.openedTimeMs > this.staleTimeoutMs) {
        log(`[STALE TIMEOUT] ${pos.name} inactive for 5m. Closing.`);
        try {
          await this.closePosition(mint, pos.lastKnownVirtualSol, pos.lastKnownVirtualTok, 'STALE_TIMEOUT', 100);
        } catch (e) {
          await this.closePositionDirect(mint, 'STALE_TIMEOUT');
        }
      }
    }
  }

  // Uses actual on-chain reserves stored on position
  async forceManualExit(mint) {
    const pos = this.positions.get(mint);
    if (!pos) return;
    await this.closePosition(mint, pos.lastKnownVirtualSol, pos.lastKnownVirtualTok, 'MANUAL_SELL', 100);
  }

  async closePositionDirect(mint, reason) {
    const pos = this.positions.get(mint);
    if (!pos || pos.status === 'SOLD') return;

    if (this.execution && pos.lastKnownVirtualSol && pos.lastKnownVirtualTok) {
      try {
        await this.closePosition(mint, pos.lastKnownVirtualSol, pos.lastKnownVirtualTok, reason, 100);
        return;
      } catch (e) {}
    }

    this.cleanupWatchers(mint);

    pos.status = 'SOLD';
    pos.closedAt = new Date().toISOString();

    // Deduct 1% pump.fun protocol fee + Solana base fee, priority fee, and Jito tip for full fee simulation
    let grossSol = 0;
    if (pos.tokensHeldRaw && pos.lastKnownVirtualSol && pos.lastKnownVirtualTok) {
      const expectedSolLamports = calculateSolOut(pos.tokensHeldRaw, pos.lastKnownVirtualSol, pos.lastKnownVirtualTok);
      grossSol = Number(expectedSolLamports) / 1e9;
    } else {
      grossSol = (Number(pos.tokensHeldDisplay) || 0) * (pos.currentPriceSol || pos.entryPriceSol || 0);
    }
    const estimatedGrossSol = grossSol * 0.99;
    const jitoTip = (this.execution?.jitoTipLamports ?? this.execution?.controller?.defaultJitoTipLamports ?? 10_000_000) / 1e9;
    const priorityFeeMicros = this.execution?.defaultPriorityFeeMicroLamports ?? this.execution?.controller?.defaultPriorityFee ?? 100_000;
    const priorityFeeSol = (priorityFeeMicros * 100_000) / 1e15;
    const estimatedSellFees = 0.000005 + priorityFeeSol + jitoTip;
    const actualNetSellProceeds = Math.max(0, estimatedGrossSol - estimatedSellFees);
    const netProfitSol = actualNetSellProceeds - (pos.initialSolSpent || 0.1);
    const finalPnlPercent = pos.initialSolSpent ? (netProfitSol / pos.initialSolSpent) * 100 : 0;

    if (netProfitSol < 0) {
      this._syncDailyLoss();
      this.dailyRealizedLossSol += Math.abs(netProfitSol);
    }

    const tradeRecord = {
      mint: pos.mint,
      name: pos.name,
      symbol: pos.symbol,
      imageUrl: pos.imageUrl,
      devPercent: pos.devPercent,
      bundledBuysCount: pos.bundledBuysCount,
      entryScore: pos.entryScore,
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol: pos.currentPriceSol,
      initialSolSpent: pos.initialSolSpent,
      actualBuyCost: pos.actualBuyCost || pos.initialSolSpent,
      actualGrossSellProceeds: estimatedGrossSol,
      actualTransactionFees: estimatedSellFees,
      actualNetSellProceeds,
      solReceived: actualNetSellProceeds,
      grossPnlSol: pos.grossPnlSol || 0,
      grossPnlPercent: pos.grossPnlPercent || 0,
      estimatedFeesSol: pos.estimatedFeesSol || 0,
      pricePnlPercent: pos.pricePnlPercent !== undefined ? pos.pricePnlPercent : (((pos.currentPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100),
      finalPricePnlPercent: pos.pricePnlPercent !== undefined ? pos.pricePnlPercent : (((pos.currentPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100),
      netProfitSol,
      profitSol: netProfitSol,
      pnlSol: netProfitSol,
      netPnlSol: netProfitSol,
      netPnlPercent: finalPnlPercent,
      finalPnlPercent,
      pnlPercent: finalPnlPercent,
      status: 'SOLD',
      reason,
      openedAt: pos.openedAt,
      closedAt: pos.closedAt,
    };

    this.positions.delete(mint);
    this.tradeHistory.unshift(tradeRecord);

    TradeStorage.saveState(this.positions, this.tradeHistory);
    eventBus.emit('POSITION_CLOSED', tradeRecord);
  }

  cleanupWatchers(mint) {
    if (this.curveWatcher) this.curveWatcher.unwatch(mint);
    if (this.devWatcher) this.devWatcher.unwatch(mint);
  }

  async closePosition(mint, virtualSolReserves, virtualTokenReserves, reason, sellPercent = 100, slippageBps = 1500) {
    const pos = this.positions.get(mint);
    if (!pos || pos.status === 'SOLD' || pos.isExiting) return;
    pos.isExiting = true;

    let tokensToSellRaw = (pos.tokensHeldRaw * BigInt(sellPercent)) / 100n;
    let sellFill = null;
    try {
      sellFill = await this.execution.executeSell({
        mint,
        tokenAmountRaw: tokensToSellRaw.toString(),
        virtualSolReserves,
        virtualTokenReserves,
        slippageBps,
        reason,
        creator: pos.creator,
      });
    } catch (err) {
      log(`[POSITION EXIT FAILED] On-chain sell failed for ${pos.name}: ${err.message}. Position remains OPEN.`);
      pos.isExiting = false;
      return;
    }

    if (!sellFill || !sellFill.txHash) {
      log(`[POSITION EXIT ABORTED] Sell did not confirm for ${pos.name}. Position remains OPEN.`);
      pos.isExiting = false;
      return;
    }
    
    pos.isExiting = false;

    const solEarned = sellFill.actualNetSellProceeds !== undefined
      ? sellFill.actualNetSellProceeds
      : (sellFill.actualSolReceived !== undefined ? sellFill.actualSolReceived : sellFill.solReceived);
    pos.tokensHeldRaw -= tokensToSellRaw;
    pos.tokensHeldDisplay = Number(pos.tokensHeldRaw) / 1e6;
    pos.realizedSolGained += solEarned;

    if (pos.tokensHeldRaw === 0n || sellPercent === 100) {
      pos.status = 'SOLD';
      pos.closedAt = new Date().toISOString();
      this.cleanupWatchers(mint);

      const netProfitSol = pos.realizedSolGained - pos.initialSolSpent;
      const finalPnl = (netProfitSol / pos.initialSolSpent) * 100;

      if (netProfitSol < 0) {
        this._syncDailyLoss();
        this.dailyRealizedLossSol += Math.abs(netProfitSol);
      }

      const tradeRecord = {
        mint: pos.mint,
        name: pos.name,
        symbol: pos.symbol,
        imageUrl: pos.imageUrl,
        devPercent: pos.devPercent,
        bundledBuysCount: pos.bundledBuysCount,
        entryScore: pos.entryScore,
        entryPriceSol: pos.entryPriceSol,
        exitPriceSol: sellFill.spotPriceSol,
        initialSolSpent: pos.initialSolSpent,
        actualBuyCost: pos.initialSolSpent,
        actualGrossSellProceeds: sellFill.actualGrossSellProceeds || pos.realizedSolGained,
        actualTransactionFees: sellFill.actualTransactionFees || 0,
        actualNetSellProceeds: pos.realizedSolGained,
        solReceived: pos.realizedSolGained,
        grossPnlSol: pos.grossPnlSol || 0,
        grossPnlPercent: pos.grossPnlPercent || 0,
        estimatedFeesSol: pos.estimatedFeesSol || 0,
        pricePnlPercent: pos.pricePnlPercent !== undefined 
          ? pos.pricePnlPercent 
          : (((sellFill.spotPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100),
        finalPricePnlPercent: pos.pricePnlPercent !== undefined 
          ? pos.pricePnlPercent 
          : (((sellFill.spotPriceSol - pos.entryPriceSol) / pos.entryPriceSol) * 100),
        netProfitSol,
        profitSol: netProfitSol,
        pnlSol: netProfitSol,
        netPnlSol: netProfitSol,
        netPnlPercent: finalPnl,
        finalPnlPercent: finalPnl,
        pnlPercent: finalPnl,
        status: 'SOLD',
        reason,
        txHash: sellFill.txHash,
        route: sellFill.route,
        openedAt: pos.openedAt,
        closedAt: pos.closedAt,
      };

      this.positions.delete(mint);
      this.tradeHistory.unshift(tradeRecord);

      TradeStorage.saveState(this.positions, this.tradeHistory);
      eventBus.emit('POSITION_CLOSED', tradeRecord);
    } else {
      TradeStorage.saveState(this.positions, this.tradeHistory);
      eventBus.emit('POSITION_SCALED_OUT', { mint: pos.mint, partialFill: sellFill });
    }
  }

  setStopLoss(percent) {
    if (typeof percent === 'number' && !isNaN(percent)) {
      this.stopLossPercent = percent > 0 ? -percent : percent;
      log(`[POSITION MANAGER] Stop loss set to ${this.stopLossPercent}%`);
    }
  }
}
