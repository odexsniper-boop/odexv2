import { log } from '../config.js';
import { eventBus } from '../eventBus.js';
import { TokenState, TokenRecord } from './stateMachine.js';
import { fetchTokenMetadata } from './metadataFetcher.js';
import { narrativeEngine } from './narrativeEngine.js';
import { validateMoneyFlow } from './manipulationEngine.js';
import { evaluateThreeCandlePattern, CandleBuilder } from './priceEngine.js';
import { BuyerQualityEngine } from './buyerQualityEngine.js';

/**
 * 3-Stage Deterministic Orchestrator & State Machine:
 * 
 * 1. Find the Narrative First (Stage 1: NARRATIVE_AUDIT)
 *    - Cultural themes (AI, meme, news, CTO), social footprint (X, TG, Web), engagement.
 *    - Rejects >90% of bot noise before any capital or intensive tracking.
 * 
 * 2. Check Whether Money is Actually Entering (Stage 2: MONEY_FLOW_WATCH)
 *    - Buy volume vs Sell volume (Net buy delta)
 *    - Number of unique buyers
 *    - Increasing transaction activity & velocity
 *    - Liquidity & MC/Liq health
 *    - Top holder concentration & dev selling check (hard veto on dev exit)
 * 
 * 3. 3-Candle Pattern Entry Trigger (Stage 3: PATTERN_FORMING)
 *    - Candle 1: Breakout / strong buying
 *    - Candle 2: Pullback that holds strictly above breakout baseline
 *    - Candle 3: Buyers return + breaks Candle 2 high
 *    - -> ENTRY_READY -> BUY_PENDING -> POSITION_OPEN
 */
export class Orchestrator {
  constructor({
    safetyFilter = null,
    smartAgent = null,
    executionEngine,
    positionManager,
    devWatcher = null,
    curveWatcher = null,
    maxConcurrentPositions = 5,
    buySizeSol = 0.1,
    autoBuyEnabled = false,
    tradeCooldownMs = 3000,
  }) {
    this.safetyFilter = safetyFilter;
    this.smartAgent = smartAgent;
    this.execution = executionEngine;
    this.positionManager = positionManager;
    this.devWatcher = devWatcher;
    this.curveWatcher = curveWatcher;
    this.maxConcurrentPositions = maxConcurrentPositions;
    this.buySizeSol = buySizeSol;
    this.autoBuyEnabled = autoBuyEnabled;
    this.tradeCooldownMs = tradeCooldownMs;
    this.lastTradeTime = 0;

    // Buyer Quality & Sybil Defense Engine
    this.buyerQualityEngine = new BuyerQualityEngine(curveWatcher?.connection || executionEngine?.connection || null);

    // Active tokens map (mint -> TokenRecord)
    this.tokens = new Map();
    // Real-time candle builders (mint -> CandleBuilder)
    this.candleBuilders = new Map();
    this.vetoCount = 0;

    // Garbage Collection & Late Breakout Watchlist
    setInterval(async () => {
      const now = Date.now();
      const protectedStates = [TokenState.POSITION_OPEN, TokenState.BUY_PENDING, TokenState.EXIT_PENDING, TokenState.LIGHTWEIGHT_WATCHLIST];
      
      for (const [mint, record] of this.tokens.entries()) {
        // 1. Stale Active Trackers (Move to Watchlist after 60s)
        if ((record.state === TokenState.MONEY_FLOW_WATCH || record.state === TokenState.PATTERN_FORMING) && (now - record.updatedAt > 60000)) {
          record.transitionTo(TokenState.LIGHTWEIGHT_WATCHLIST, 'Moved to Late Breakout Scanner');
          log(`[WATCHLIST] ${record.name || mint.slice(0,8)} sleeping, moved to Late Breakout Scanner`);
          if (this.curveWatcher) this.curveWatcher.unwatch(mint); // Disconnect WS to save RAM/RPC
          if (this.devWatcher) this.devWatcher.unwatchDev(mint); // Unsubscribe Dev ATA to prevent memory/RPC leak
        } 
        // 2. Hard TTL Deletion (10 mins for rejects/closed)
        else if (!protectedStates.includes(record.state) && (now - record.updatedAt > 600000)) {
          this.tokens.delete(mint);
          this.candleBuilders.delete(mint);
          this.buyerQualityEngine.cleanupToken(mint);
          if (this.curveWatcher) this.curveWatcher.unwatch(mint);
          if (this.devWatcher) this.devWatcher.unwatchDev(mint);
        }
      }
    }, 30000); // Check every 30 seconds

    // Late Breakout Engine (Scanner)
    setInterval(async () => {
      const watchlist = Array.from(this.tokens.values()).filter(t => t.state === TokenState.LIGHTWEIGHT_WATCHLIST);
      if (watchlist.length === 0) return;
      
      const now = Date.now();
      for (const record of watchlist) {
        if (now - record.updatedAt > 7200000) { // 2 hour hard TTL for Watchlist
          this.tokens.delete(record.mint);
          this.candleBuilders.delete(record.mint);
          if (this.devWatcher) this.devWatcher.unwatchDev(record.mint);
          continue;
        }
        
        // TODO: In production, batch REST API call here to check for volume spikes.
        // If a massive volume spike is detected:
        // record.transitionTo(TokenState.PATTERN_FORMING, 'LATE BREAKOUT DETECTED');
        // if (this.curveWatcher) this.curveWatcher.watch(record.mint);
      }
    }, 60000); // Scan every 60 seconds

    // Wire bonding curve ticks from curveWatcher
    eventBus.on('CURVE_TICK', (tick) => this.handleCurveTick(tick));
    eventBus.on('DEV_DUMP_ALERT', (alert) => this.handleDevDumpAlert(alert));
    eventBus.on('POSITION_CLOSED', (tradeRecord) => this.handlePositionClosed(tradeRecord));


  }

  setCurveWatcher(watcher) {
    this.curveWatcher = watcher;
  }

  setAutoBuy(enabled) {
    if (enabled && this.positionManager && this.positionManager.isDailyLossExceeded()) {
      this.autoBuyEnabled = false;
      log(`🛑 [DAILY STOP LOSS] Cannot enable Auto-Snipe: Daily loss cap exceeded (${this.positionManager.getTodayRealizedLossSol().toFixed(3)} / ${this.positionManager.dailyLossCapSol} SOL).`);
      return false;
    }
    this.autoBuyEnabled = !!enabled;
    log(`[ORCHESTRATOR] Auto-Snipe ${this.autoBuyEnabled ? 'ENABLED' : 'DISABLED'}`);
    return this.autoBuyEnabled;
  }

  setBuySize(sol) {
    this.buySizeSol = Number(sol);
  }

  getToken(mint) {
    return this.tokens.get(mint);
  }

  getAllTokens() {
    return Array.from(this.tokens.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Main entry point for newly detected tokens
   */
  async handleTokenLaunch(eventData) {
    const mint = eventData.mint;
    if (!mint) return;

    if (this.tokens.has(mint)) {
      return this.tokens.get(mint);
    }

    // Step 0: Initialize Record (DETECTED)
    const record = new TokenRecord(mint);
    record.creator = eventData.creator || 'UNKNOWN';
    record.devPercent = eventData.devPercent || 0;
    record.bundledBuysCount = eventData.bundledBuysCount || 0;
    record.initialMarketCapSol = eventData.initialMarketCapSol || 30.0;
    record.name = eventData.name || 'Resolving...';
    record.symbol = eventData.symbol || '...';
    this.tokens.set(mint, record);

    // Preload token program & creator in Execution Cache for 0ms trade construction
    if (this.execution) {
      if (this.execution.tokenResolver) {
        this.execution.tokenResolver.resolve(mint).catch(() => {});
      }
      if (this.execution.executionCache && record.creator && record.creator !== 'UNKNOWN') {
        this.execution.executionCache.prewarmToken(mint, { creator: record.creator });
      }
    }

    eventBus.emit('STATE_TRANSITION', {
      mint,
      state: record.state,
      record: this.serializeToken(record),
    });

    // Check known ruggers immediately
    const isKnownRugger = this.devWatcher ? this.devWatcher.isKnownRugger(record.creator) : false;
    if (isKnownRugger) {
      this.vetoCount++;
      record.transitionTo(TokenState.REJECTED, 'FLAGGED_PREVIOUS_RUGGER');
      log(`[STAGE 1 VETO] Flagged known rugger creator: ${record.creator.slice(0, 8)}`);
      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        reason: record.rejectionReason,
        record: this.serializeToken(record),
      });
      return record;
    }

    // Hard creator holding limit (Strict 8%)
    if (record.devPercent > 8.0) {
      this.vetoCount++;
      record.transitionTo(TokenState.REJECTED, `DEV_OVERALLOCATED (${record.devPercent.toFixed(1)}% > 8%)`);
      log(`[STAGE 1 VETO] Dev holding too high: ${record.devPercent.toFixed(1)}%`);
      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        reason: record.rejectionReason,
        record: this.serializeToken(record),
      });
      return record;
    }

    // Transition to Stage 1: NARRATIVE_AUDIT
    record.transitionTo(TokenState.NARRATIVE_AUDIT);
    eventBus.emit('STATE_TRANSITION', {
      mint,
      state: record.state,
      record: this.serializeToken(record),
    });

    // Fetch full metadata & socials asynchronously with on-chain name fallback
    try {
      const meta = await fetchTokenMetadata(mint, record.name, record.symbol);
      if (meta) {
        if (meta.name) record.name = meta.name;
        if (meta.symbol) record.symbol = meta.symbol;
        if (meta.imageUrl) record.imageUrl = meta.imageUrl;
        eventBus.emit('TOKEN_METADATA_UPDATED', {
          mint,
          name: record.name,
          symbol: record.symbol,
          imageUrl: record.imageUrl,
        });

        // Rapid adaptive metadata polling (300ms, 800ms, 1800ms, 3500ms) to catch images and names immediately as indexed
        const hasPlaceholderName = !record.name || record.name === 'Unknown Token' || record.name === 'Resolving...';
        if (!record.imageUrl || hasPlaceholderName || (!meta.twitter && !meta.telegram)) {
          const delays = [300, 800, 1800, 3500];
          delays.forEach(delay => {
            setTimeout(async () => {
              const nameReady = record.name && record.name !== 'Unknown Token' && record.name !== 'Resolving...';
              if (record.imageUrl && nameReady && record.stage1_narrative?.socialsFound > 0) return;
              try {
                const fresh = await fetchTokenMetadata(mint);
                if (fresh) {
                  let updated = false;
                  if (fresh.imageUrl && fresh.imageUrl !== record.imageUrl) {
                    record.imageUrl = fresh.imageUrl;
                    updated = true;
                  }
                  if (fresh.name && fresh.name !== record.name && fresh.name !== 'Unknown Token' && fresh.name !== 'Resolving...') {
                    record.name = fresh.name;
                    updated = true;
                  }
                  if (fresh.symbol && fresh.symbol !== record.symbol && fresh.symbol !== 'UNK') {
                    record.symbol = fresh.symbol;
                    updated = true;
                  }
                  if (fresh.twitter || fresh.telegram) {
                    const freshVerdict = narrativeEngine.evaluateNarrative(fresh);
                    record.stage1_narrative = freshVerdict;
                    record.narrativeScore = freshVerdict.narrativeScore;
                    updated = true;
                  }
                  if (updated) {
                    eventBus.emit('TOKEN_METADATA_UPDATED', {
                      mint,
                      name: record.name,
                      symbol: record.symbol,
                      imageUrl: record.imageUrl,
                    });
                  }
                }
              } catch (e) {}
            }, delay);
          });
        }

        // Evaluate Stage 1: Narrative & Mindshare
        const narrativeVerdict = narrativeEngine.evaluateNarrative(meta);
        record.stage1_narrative = narrativeVerdict;
        record.narrativeScore = narrativeVerdict.narrativeScore;

        if (!narrativeVerdict.passed) {
          this.vetoCount++;
          record.transitionTo(
            TokenState.REJECTED,
            `STAGE 1 FAILED: WEAK_NARRATIVE (${narrativeVerdict.theme}, Score: ${narrativeVerdict.narrativeScore}/100)`
          );
          log(`[STAGE 1 REJECT] ${record.name} dropped: Weak narrative (${narrativeVerdict.theme}, ${narrativeVerdict.narrativeScore}/100)`);
          eventBus.emit('STATE_TRANSITION', {
            mint,
            state: record.state,
            reason: record.rejectionReason,
            record: this.serializeToken(record),
          });
          return record;
        }

        // Passed Stage 1!
        log(`💡 [STAGE 1 PASS] Narrative Confirmed for ${record.name} (${narrativeVerdict.theme}, Score: ${narrativeVerdict.narrativeScore}/100, Socials: ${narrativeVerdict.socialsFound})`);
        
        // Advance to Stage 2: MONEY_FLOW_WATCH
        record.transitionTo(TokenState.MONEY_FLOW_WATCH);
        record.stageEnteredAt = Date.now();
        // Seed candle builder (Dynamic timeframe: 4s micro-candles for high-velocity/top narrative tokens, 8s standard)
        const candleTf = (record.narrativeScore >= 75 || record.bundledBuysCount >= 15) ? 4 : 8;
        this.candleBuilders.set(mint, new CandleBuilder(candleTf));

        // Start tracking live on-chain bonding curve reserves
        if (this.curveWatcher) {
          this.curveWatcher.watch(mint);
        }

        // Guard against dev dump during Stage 2
        if (this.devWatcher && record.creator && record.creator !== 'UNKNOWN') {
          this.devWatcher.watchDev(mint, record.creator);
        }

        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          record: this.serializeToken(record),
        });
      } else {
        // Metadata completely missing after timeout
        record.transitionTo(TokenState.REJECTED, 'STAGE 1 FAILED: METADATA_TIMEOUT');
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
      }
    } catch (err) {
      log(`[ORCHESTRATOR WARN] Metadata resolution error for ${mint.slice(0, 8)}: ${err.message}`);
    }

    return record;
  }

  /**
   * Processes live bonding curve ticks for tokens in MONEY_FLOW_WATCH or PATTERN_FORMING
   */
  async handleCurveTick(tick) {
    const mint = tick.mint;
    const record = this.tokens.get(mint);
    if (!record || record.state === TokenState.REJECTED || record.state === TokenState.CLOSED) {
      return;
    }

    // Accumulate real order flow ONLY when an actual trade occurred
    if (tick.hasTraded && tick.solDelta > 0) {
      record.txCount++;
      if (tick.isBuy) {
        record.buyVolumeSol += tick.solDelta;
        if (tick.buyerPubkey) {
          record.uniqueBuyers.add(tick.buyerPubkey);
          this.buyerQualityEngine.recordBuy(mint, tick.buyerPubkey, tick.solDelta, tick.timestamp || Date.now(), tick.slot || 0);
        }
      } else {
        record.sellVolumeSol += tick.solDelta;
      }
    }

    // Check dev dumping
    if (record.devSoldAny) {
      this.vetoCount++;
      record.transitionTo(TokenState.REJECTED, 'STAGE 2 VETO: DEV_SOLD_INTO_MARKET');
      log(`🚨 [STAGE 2 VETO] Dev dumped tokens on ${record.name || mint.slice(0, 8)}! Exited immediately.`);
      if (this.curveWatcher) this.curveWatcher.unwatch(mint);
      if (this.devWatcher) this.devWatcher.unwatchDev(mint);
      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        reason: record.rejectionReason,
        record: this.serializeToken(record),
      });
      return;
    }

    // Update real-time candles & track live curve reserves
    record.lastVirtualSolReserves = tick.virtualSolReserves;
    record.lastVirtualTokenReserves = tick.virtualTokenReserves;
    const cb = this.candleBuilders.get(mint);
    if (cb) {
      cb.addTick(tick.priceSol, tick.solDelta || 0, tick.timestamp);
    }

    // Handle Stage 2: MONEY_FLOW_WATCH
    if (record.state === TokenState.MONEY_FLOW_WATCH) {
      const quality = this.buyerQualityEngine.evaluateBuyerQuality(mint);
      record.buyerQuality = quality;

      // 1. HARD VETO: Extreme Coordinated Sybil Cluster / Cartel
      if (quality.isHardVeto) {
        this.vetoCount++;
        record.transitionTo(TokenState.REJECTED, `STAGE 2 VETO: COORDINATED_BUYER_CLUSTER (${quality.reasons[0] || 'Extreme Sybil Domination'})`);
        log(`🚨 [STAGE 2 VETO] Coordinated sybil cluster rejected on ${record.name || mint.slice(0, 8)}! (${quality.reasons.join('; ')})`);
        if (this.curveWatcher) this.curveWatcher.unwatch(mint);
        if (this.devWatcher) this.devWatcher.unwatchDev(mint);
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
        return;
      }

      // 2. Derive true organic buyer breadth and cleaned organic volume
      const rawBuyerCount = Math.max(record.uniqueBuyers.size, record.bundledBuysCount);
      const effectiveOrganicBuyers = quality.organicBuyerCount > 0 ? quality.organicBuyerCount : rawBuyerCount;
      const effectiveBuyVolume = quality.organicBuyVolumeSol > 0 ? quality.organicBuyVolumeSol : record.buyVolumeSol;

      const flowVerdict = validateMoneyFlow({
        buyVolumeSol: effectiveBuyVolume,
        sellVolumeSol: record.sellVolumeSol,
        uniqueBuyersCount: effectiveOrganicBuyers,
        organicBuyersCount: effectiveOrganicBuyers,
        rawBuyersCount: rawBuyerCount,
        clusterRisk: quality.coordinationRisk,
        txCount: record.txCount,
        liquiditySol: Number(tick.virtualSolReserves || 30000000000n) / 1e9,
        requiresExceptionalMomentum: record.stage1_narrative?.requiresExceptionalMomentum || false,
        marketCapSol: record.initialMarketCapSol || 30.0,
        devHoldingPercent: record.devPercent,
        devSoldAny: record.devSoldAny,
      });

      record.stage2_moneyFlow = flowVerdict;
      record.moneyFlowScore = flowVerdict.score;

      if (flowVerdict.passed) {
        log(`💰 [STAGE 2 PASS] Real Money Flow Confirmed for ${record.name}! (Net Delta: +${flowVerdict.netVolumeDeltaSol} SOL, Ratio: ${flowVerdict.buySellRatio}x, Organic Buyers: ${flowVerdict.uniqueBuyersCount}/${rawBuyerCount}, Cluster Risk: ${quality.coordinationRisk})`);
        
        // Advance to Stage 3: PATTERN_FORMING
        record.transitionTo(TokenState.PATTERN_FORMING);
        record.stageEnteredAt = Date.now();
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          record: this.serializeToken(record),
        });
      }
      return;
    }

    // Handle Stage 3: PATTERN_FORMING
    if (record.state === TokenState.PATTERN_FORMING && cb) {
      const candles = cb.getCandles();
      const patternVerdict = evaluateThreeCandlePattern(candles);
      record.stage3_pattern = patternVerdict;
      record.patternScore = patternVerdict.score;

      if (patternVerdict.patternTriggered) {
        log(`🎯 [STAGE 3 TRIGGER CONFIRMED] ${record.name}: 3-Candle Breakout-Retest Complete!`);
        log(`   -> ${patternVerdict.reason}`);

        // Calculate composite entry score
        record.entryScore = Math.round(
          record.narrativeScore * 0.3 +
          record.moneyFlowScore * 0.35 +
          record.patternScore * 0.35
        );

        // AI Learner Gatekeeper - Final Check before buying
        if (this.smartAgent) {
          const realBuyerCount = Math.max(record.uniqueBuyers.size, record.bundledBuysCount);
          const aiVerdict = this.smartAgent.evaluateEntry({
            devPercent: record.devPercent,
            bundledBuysCount: realBuyerCount,
            devSoldAny: record.devSoldAny,
            buyVolumeSol: record.buyVolumeSol,
            uniqueBuyersCount: record.uniqueBuyers.size,
          });
          
          if (!aiVerdict.shouldTrade) {
            this.vetoCount++;
            record.transitionTo(TokenState.REJECTED, `STAGE 3 VETO (AI LEARNER): ${aiVerdict.reason}`);
            log(`[AI LEARNER VETO] Blocked entry on ${record.name}: ${aiVerdict.reason}`);
            if (this.curveWatcher) this.curveWatcher.unwatch(mint);
            if (this.devWatcher) this.devWatcher.unwatchDev(mint);
            eventBus.emit('STATE_TRANSITION', {
              mint,
              state: record.state,
              reason: record.rejectionReason,
              record: this.serializeToken(record),
            });
            return;
          }
        }

        record.transitionTo(TokenState.ENTRY_READY);

        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          record: this.serializeToken(record),
        });

        // Trigger execution if Auto-Snipe is active
        await this.triggerExecution(record);
      }
    }
  }

  /**
   * Executes position entry once Stage 1, 2, and 3 are all validated
   */
  async triggerExecution(record) {
    if (!this.autoBuyEnabled) {
      log(`[ORCHESTRATOR] Token ${record.name} is ENTRY_READY. Auto-Snipe is OFF.`);
      return;
    }

    const mint = record.mint;

    // Guardrail: Daily Loss Cap Protection
    if (this.positionManager.isDailyLossExceeded()) {
      log(`🛑 [DAILY LOSS CAP EXCEEDED] Realized losses reached cap. Blocking new entries.`);
      return;
    }

    // Guardrail: Portfolio Capacity
    if (this.positionManager.positions.size >= this.maxConcurrentPositions) {
      log(`[ORCHESTRATOR] Portfolio full (${this.maxConcurrentPositions} max active positions). Entry shelved.`);
      return;
    }

    if (this.positionManager.positions.has(mint)) {
      return;
    }

    // Guardrail: Inter-trade cooldown
    const elapsed = Date.now() - this.lastTradeTime;
    if (elapsed < this.tradeCooldownMs) {
      const waitTime = this.tradeCooldownMs - elapsed;
      log(`[ORCHESTRATOR] Pacing entry for ${record.name}: cooldown active (${Math.ceil(waitTime/1000)}s). Queuing token for retry.`);
      setTimeout(() => {
        if (record.state === TokenState.ENTRY_READY) {
          this.triggerExecution(record);
        }
      }, waitTime + 100); // add 100ms padding
      return;
    }

    this.lastTradeTime = Date.now();
    record.transitionTo(TokenState.BUY_PENDING);
    eventBus.emit('STATE_TRANSITION', {
      mint,
      state: record.state,
      record: this.serializeToken(record),
    });

    try {
      log(`⚡ [ORCHESTRATOR BUY] Executing 3-Stage Entry on ${record.name} (${mint.slice(0, 8)}) with ${this.buySizeSol} SOL`);
      
      // Dynamic Jito Tip Escalation: Boost tip by 1.3x for top-tier high-conviction entries (entryScore >= 85)
      let dynamicTipLamports = this.execution?.jitoTipLamports ?? 10_000_000;
      const maxSensibleTip = Math.max(1_000_000, Math.floor(this.buySizeSol * 1e9 * 0.10));
      if (dynamicTipLamports > maxSensibleTip && this.buySizeSol < 0.1) {
        dynamicTipLamports = maxSensibleTip;
      }
      if (record.entryScore >= 85 && dynamicTipLamports > 0) {
        dynamicTipLamports = Math.round(dynamicTipLamports * 1.3);
      }

      const buyFill = await this.execution.executeBuy({
        mint,
        solAmount: this.buySizeSol,
        creator: record.creator,
        virtualSolReserves: record.lastVirtualSolReserves,
        virtualTokenReserves: record.lastVirtualTokenReserves,
        jitoTipLamports: dynamicTipLamports,
      });

      record.buyTxHash = buyFill.txHash || 'simulated_tx';
      record.transitionTo(TokenState.POSITION_OPEN);

      const position = this.positionManager.openPosition(buyFill, {
        name: record.name,
        symbol: record.symbol,
        creator: record.creator,
        riskScore: record.riskScore,
        entryScore: record.entryScore,
        devPercent: record.devPercent,
        bundledBuysCount: Math.max(record.uniqueBuyers.size, record.bundledBuysCount),
        imageUrl: record.imageUrl,
        stopLossPercent: this.positionManager.stopLossPercent,
      });

      record.position = position;

      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        record: this.serializeToken(record),
      });
    } catch (err) {
      log(`[ORCHESTRATOR BUY ERR] Failed to buy ${mint}: ${err.message}`);
      record.transitionTo(TokenState.REJECTED, `EXECUTION_FAILED: ${err.message}`);
      if (this.curveWatcher) this.curveWatcher.unwatch(mint);
      if (this.devWatcher) this.devWatcher.unwatchDev(mint);
      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        reason: record.rejectionReason,
        record: this.serializeToken(record),
      });
    }
  }

  /**
   * Sync position closure with TokenRecord state
   */
  handlePositionClosed(closedData) {
    const record = this.tokens.get(closedData.mint);
    if (record) {
      record.transitionTo(TokenState.CLOSED, closedData.reason);
      record.sellTxHash = closedData.txHash || 'simulated_tx';
      record.closedData = closedData;
      eventBus.emit('STATE_TRANSITION', {
        mint: closedData.mint,
        state: record.state,
        reason: closedData.reason,
        record: this.serializeToken(record),
      });
    }

    // Stop watching curve if no open position remains
    if (this.curveWatcher) {
      this.curveWatcher.unwatch(closedData.mint);
    }

    // Feed trade experience into Smart Agent to enhance win rate
    if (this.smartAgent && typeof this.smartAgent.learnFromTrade === 'function') {
      this.smartAgent.learnFromTrade({
        ...closedData,
        devPercent: record ? record.devPercent : 0,
        bundleCount: record ? record.bundledBuysCount : 0,
        entryScore: record ? record.entryScore : 0,
        riskScore: record ? record.riskScore : 0,
      });
    }
  }

  /**
   * Catches dev dump alerts from DevWatcher and immediately vetoes / stops tracking
   */
  handleDevDumpAlert(alert) {
    const record = this.tokens.get(alert.mint);
    if (record && record.state !== TokenState.REJECTED && record.state !== TokenState.CLOSED) {
      this.vetoCount++;
        record.devSoldAny = true;
      record.transitionTo(TokenState.REJECTED, `STAGE 2 VETO: DEV_DUMP_DETECTED (${(alert.dumpPercent || 0).toFixed(0)}% dumped)`);
      log(`🚨 [DEV DUMP VETO] Dev dumped ${(alert.dumpPercent || 0).toFixed(0)}% on ${record.name || alert.mint.slice(0, 8)}! Stopped tracking.`);
      if (this.curveWatcher) this.curveWatcher.unwatch(alert.mint);
      if (this.devWatcher) this.devWatcher.unwatchDev(alert.mint);
        eventBus.emit('STATE_TRANSITION', {
          mint: alert.mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
      }
    }

    handlePositionClosed(tradeRecord) {
      if (!tradeRecord || !tradeRecord.mint) return;
      const record = this.tokens.get(tradeRecord.mint);
      if (record) {
        record.transitionTo(TokenState.CLOSED, tradeRecord.reason);
        this.tokens.delete(tradeRecord.mint);
        this.candleBuilders.delete(tradeRecord.mint);
      }
    }

    serializeToken(record) {
    return {
      mint: record.mint,
      name: record.name,
      symbol: record.symbol,
      imageUrl: record.imageUrl || null,
      creator: record.creator,
      state: record.state,
      detectedAt: record.detectedAt,
      updatedAt: record.updatedAt,
      riskScore: record.riskScore,
      entryScore: record.entryScore,
      devPercent: record.devPercent,
      bundledBuysCount: record.bundledBuysCount,
      rejectionReason: record.rejectionReason,
      // 3-Stage details
      stage1_narrative: record.stage1_narrative,
      stage2_moneyFlow: record.stage2_moneyFlow,
      stage3_pattern: record.stage3_pattern,
      buyerQuality: record.buyerQuality || null,
      narrativeScore: record.narrativeScore,
      moneyFlowScore: record.moneyFlowScore,
      patternScore: record.patternScore,
      buyVolumeSol: Number(record.buyVolumeSol.toFixed(2)),
      sellVolumeSol: Number(record.sellVolumeSol.toFixed(2)),
      position: record.position ? {
        mint: record.position.mint,
        entryPriceSol: record.position.entryPriceSol,
        currentPriceSol: record.position.currentPriceSol,
        peakPriceSol: record.position.peakPriceSol,
        initialSolSpent: record.position.initialSolSpent,
        unrealizedPnlPercent: record.position.unrealizedPnlPercent,
        unrealizedPnlSol: record.position.unrealizedPnlSol,
        status: record.position.status,
      } : null,
      closedData: record.closedData || null,
    };
  }
}
