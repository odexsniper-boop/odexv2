import { CONFIG, log } from '../config.js';
import { eventBus } from '../eventBus.js';
import { calculateSpotPriceSol } from '../pumpfun.js';
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

    // Daily Loss Cap guardrail (e.g. max -1.5 SOL daily loss cap)
    this.dailyLossCapSol = options.dailyLossCapSol !== undefined ? options.dailyLossCapSol : 1.5;
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
    this._syncDailyLoss();
    return this.dailyRealizedLossSol >= this.dailyLossCapSol;
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
      initialSolSpent: buyFill.solSpent,
      actualBuyCost: buyFill.solSpent,
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
      unrealizedPnlPercent: 0,
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
    pos.unrealizedPnlPercent = (priceRatio - 1) * 100;

    eventBus.emit('POSITION_TICK', {
      mint: pos.mint,
      pnlPercent: pos.unrealizedPnlPercent,
      currentPriceSol,
      peakPriceSol: pos.peakPriceSol,
    });

    try {
      // 1. HARD STOP LOSS: Executes strictly at -20%
      if (pos.unrealizedPnlPercent <= this.stopLossPercent) {
        log(`[EXIT TRIGGER] Stop Loss hit on ${pos.name} (${pos.unrealizedPnlPercent.toFixed(1)}% <= ${this.stopLossPercent}%) - Executing immediate exit.`);
        await this.closePosition(mint, virtualSolReserves, virtualTokenReserves, 'STOP_LOSS', 100, 10000);
        return;
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

  checkStalePositions() {
    const now = Date.now();
    for (const [mint, pos] of this.positions.entries()) {
      if (now - pos.openedTimeMs > this.staleTimeoutMs) {
        log(`[STALE TIMEOUT] ${pos.name} inactive for 5m. Closing.`);
        this.closePositionDirect(mint, 'STALE_TIMEOUT');
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

    this.cleanupWatchers(mint);

    pos.status = 'SOLD';
    const profitSol = (pos.initialSolSpent * pos.unrealizedPnlPercent) / 100;
    if (profitSol < 0) {
      this._syncDailyLoss();
      this.dailyRealizedLossSol += Math.abs(profitSol);
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
      finalPnlPercent: pos.unrealizedPnlPercent,
      profitSol,
      status: 'SOLD',
      reason,
      openedAt: pos.openedAt,
      closedAt: pos.closedAt,
    };

    this.positions.delete(mint);
    this.tradeHistory.unshift(tradeRecord);
    if (this.tradeHistory.length > 100) this.tradeHistory.pop();

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
        netProfitSol,
        finalPnlPercent: finalPnl,
        status: 'SOLD',
        reason,
        txHash: sellFill.txHash,
        route: sellFill.route,
        openedAt: pos.openedAt,
        closedAt: pos.closedAt,
      };

      this.positions.delete(mint);
      this.tradeHistory.unshift(tradeRecord);
      if (this.tradeHistory.length > 100) this.tradeHistory.pop();

      TradeStorage.saveState(this.positions, this.tradeHistory);
      eventBus.emit('POSITION_CLOSED', tradeRecord);
    } else {
      TradeStorage.saveState(this.positions, this.tradeHistory);
      eventBus.emit('POSITION_SCALED_OUT', { mint: pos.mint, partialFill: sellFill });
    }
  }
}
