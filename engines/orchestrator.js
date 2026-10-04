import { log } from '../config.js';
import { eventBus } from '../eventBus.js';
import { TokenState, TokenRecord } from './stateMachine.js';
import { fetchTokenMetadata } from './metadataFetcher.js';
import { narrativeEngine } from './narrativeEngine.js';
import { validateMoneyFlow } from './manipulationEngine.js';
import { evaluateThreeCandlePattern, CandleBuilder } from './priceEngine.js';
import { BuyerQualityEngine } from './buyerQualityEngine.js';
import { HardSafetyFilter } from './safetyEngine.js';
import { calculateSpotPriceSol } from '../pumpfun.js';

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

    // Fix 3: Bounded Entry Queue & Deferred Scheduler
    this.entryQueue = []; // array of { mint, queuedAt, reason, breakoutPriceSol }
    this.maxQueueSize = 20;
    this.maxQueueAgeMs = 60000; // 60s max signal validity
    this.cooldownTimer = null;

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
      const protectedStates = [
        TokenState.POSITION_OPEN, 
        TokenState.BUY_PENDING, 
        TokenState.EXIT_PENDING, 
        TokenState.WAITING_FOR_CAPACITY,
        TokenState.WAITING_FOR_COOLDOWN,
        TokenState.REVALIDATING,
        TokenState.LIGHTWEIGHT_WATCHLIST
      ];
      
      for (const [mint, record] of this.tokens.entries()) {
        // 1. Stale Active Trackers (Move to Watchlist after 120s of complete inactivity)
        if ((record.state === TokenState.MONEY_FLOW_WATCH || record.state === TokenState.PATTERN_FORMING) && (now - record.updatedAt > 120000)) {
          record.transitionTo(TokenState.LIGHTWEIGHT_WATCHLIST, 'Moved to Late Breakout Scanner');
          log(`[WATCHLIST] ${record.name || mint.slice(0,8)} sleeping, moved to Late Breakout Scanner`);
          if (this.curveWatcher) this.curveWatcher.unwatch(mint); // Disconnect WS to save RAM/RPC
          if (this.devWatcher) this.devWatcher.unwatchDev(mint); // Unsubscribe Dev ATA to prevent memory/RPC leak
          eventBus.emit('STATE_TRANSITION', {
            mint,
            state: record.state,
            reason: record.rejectionReason,
            record: this.serializeToken(record),
          });
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

    // Late Breakout Engine (Scanner): Periodically checks watchlist tokens for fresh volume surges
    setInterval(async () => {
      const watchlist = Array.from(this.tokens.values()).filter(t => t.state === TokenState.LIGHTWEIGHT_WATCHLIST);
      if (watchlist.length === 0) return;
      
      const now = Date.now();
      const connection = this.curveWatcher?.connection;

      // Rotate through least recently scanned tokens to prevent starvation
      const sortedWatchlist = watchlist.sort((a, b) => (a.lastWatchlistScannedAt || 0) - (b.lastWatchlistScannedAt || 0));

      for (const record of sortedWatchlist.slice(0, 10)) {
        record.lastWatchlistScannedAt = now;
        if (now - record.updatedAt > 7200000) { // 2 hour hard TTL for Watchlist
          this.tokens.delete(record.mint);
          this.candleBuilders.delete(record.mint);
          this.buyerQualityEngine.cleanupToken(record.mint);
          if (this.curveWatcher) this.curveWatcher.unwatch(record.mint);
          if (this.devWatcher) this.devWatcher.unwatchDev(record.mint);
          continue;
        }
        
        if (connection) {
          try {
            const { PublicKey } = await import('@solana/web3.js');
            const { getBondingCurvePDA } = await import('../pumpfun.js');
            const pda = getBondingCurvePDA(new PublicKey(record.mint));
            const acc = await connection.getAccountInfo(pda, 'processed');
            if (acc && acc.data && acc.data.length >= 24) {
              const vTok = acc.data.readBigUInt64LE(8);
              const vSol = acc.data.readBigUInt64LE(16);
              const prevSol = record.lastVirtualSolReserves || 30_000_000_000n;
              if (vSol > prevSol + 500_000_000n) { // >= 0.5 SOL inflow detected
                log(`🔥 [LATE BREAKOUT DETECTED] Watchlist token ${record.name || record.mint.slice(0, 8)} woke up (+${(Number(vSol - prevSol) / 1e9).toFixed(2)} SOL)! Resuming tracking.`);
                record.lastVirtualSolReserves = vSol;
                record.lastVirtualTokenReserves = vTok;
                record.transitionTo(TokenState.MONEY_FLOW_WATCH, 'LATE_BREAKOUT_INFLOW');
                if (this.curveWatcher) this.curveWatcher.watch(record.mint);
                if (this.devWatcher && record.creator && record.creator !== 'UNKNOWN') {
                  this.devWatcher.watchDev(record.mint, record.creator);
                }
                eventBus.emit('STATE_TRANSITION', { mint: record.mint, state: record.state, record: this.serializeToken(record) });
              }
            }
          } catch (e) {}
        }
      }
    }, 60000); // Scan every 60 seconds

    // Wire bonding curve ticks from curveWatcher
    eventBus.on('CURVE_TICK', (tick) => this.handleCurveTick(tick));
    eventBus.on('DEV_DUMP_ALERT', (alert) => this.handleDevDumpAlert(alert));
    eventBus.on('POSITION_CLOSED', (tradeRecord) => this.handlePositionClosed(tradeRecord));
    eventBus.on('BUNDLE_METRICS_UPDATED', (data) => this.handleBundleMetricsUpdated(data));
  }

  setCurveWatcher(watcher) {
    this.curveWatcher = watcher;
  }

  setAutoBuy(enabled) {
    this.autoBuyEnabled = !!enabled;
    log(`[ORCHESTRATOR] Auto-Snipe ${this.autoBuyEnabled ? 'ENABLED' : 'DISABLED'}`);
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
    record.metadataUri = eventData.metadataUri || null;
    record.description = eventData.description || '';
    record.twitter = eventData.twitter || null;
    record.telegram = eventData.telegram || null;
    record.website = eventData.website || null;
    record.imageUrl = eventData.imageUrl || null;
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

    // Authoritative Launch Safety Gate (HardSafetyFilter)
    const isKnownRugger = this.devWatcher ? this.devWatcher.isKnownRugger(record.creator) : false;
    const activeSafetyFilter = this.safetyFilter || new HardSafetyFilter({ maxDevPercent: 8.0, maxBundleWallets: 3, maxBundlePercent: 20.0, allowMissingBundleData: true });
    const safetyVerdict = activeSafetyFilter.evaluate({
      mint,
      creator: record.creator,
      devPercent: record.devPercent,
      bundledBuysCount: record.bundledBuysCount,
      bundlePercent: eventData.bundlePercent,
      bundleDataStatus: eventData.bundleDataStatus,
      isKnownRugger,
      mintDisabled: eventData.mintDisabled,
      freezeDisabled: eventData.freezeDisabled,
    });

    record.safetyVerdict = safetyVerdict;

    if (!safetyVerdict.pass) {
      this.vetoCount++;
      record.transitionTo(TokenState.REJECTED, `STAGE 0 HARD SAFETY VETO: ${safetyVerdict.reason}`);
      log(`[STAGE 0 SAFETY VETO] ${record.name || mint.slice(0, 8)} rejected: ${safetyVerdict.reason}`);
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
      const meta = await fetchTokenMetadata(mint, record.name, record.symbol, record.metadataUri, {
        description: record.description,
        twitter: record.twitter,
        telegram: record.telegram,
        website: record.website,
        imageUrl: record.imageUrl,
      });
      if (meta) {
        if (meta.name) record.name = meta.name;
        if (meta.symbol) record.symbol = meta.symbol;
        if (meta.imageUrl) record.imageUrl = meta.imageUrl;
        if (meta.description) record.description = meta.description;
        if (meta.twitter) record.twitter = meta.twitter;
        if (meta.telegram) record.telegram = meta.telegram;
        if (meta.website) record.website = meta.website;
        eventBus.emit('TOKEN_METADATA_UPDATED', {
          mint,
          name: record.name,
          symbol: record.symbol,
          imageUrl: record.imageUrl,
        });

        const advanceToStage2 = (verdict) => {
          if (record.state !== TokenState.NARRATIVE_AUDIT) return;

          // Anti-Clone / Copycat Protection:
          // If another token with the identical name is already actively tracked in Stage 2/3/Watchlist,
          // reject subsequent clone mints to protect against copycat spam & liquidity traps
          const normName = (record.name || '').trim().toLowerCase();
          if (normName.length >= 3 && normName !== 'resolving...' && normName !== 'unknown token') {
            for (const [otherMint, otherRec] of this.tokens.entries()) {
              if (otherMint === mint) continue;
              const isActive = otherRec.state === TokenState.MONEY_FLOW_WATCH ||
                               otherRec.state === TokenState.PATTERN_FORMING ||
                               otherRec.state === TokenState.BUY_PENDING ||
                               otherRec.state === TokenState.POSITION_OPEN;
              if (isActive && (otherRec.name || '').trim().toLowerCase() === normName) {
                rejectStage1({
                  passed: false,
                  narrativeScore: 10,
                  theme: 'CLONE_SPAM',
                  reasons: [`Duplicate clone of active token ${otherRec.name} (${otherMint.slice(0, 8)})`],
                  socialsFound: verdict.socialsFound || 0
                });
                return;
              }
            }
          }

          record.stage1_narrative = verdict;
          record.narrativeScore = verdict.narrativeScore;
          log(`💡 [STAGE 1 PASS] Narrative Confirmed for ${record.name} (${verdict.theme}, Score: ${verdict.narrativeScore}/100, Socials: ${verdict.socialsFound})`);
          
          record.transitionTo(TokenState.MONEY_FLOW_WATCH);
          record.stageEnteredAt = Date.now();
          const candleTf = (record.narrativeScore >= 75 || record.bundledBuysCount >= 15) ? 4 : 8;
          this.candleBuilders.set(mint, new CandleBuilder(candleTf));

          if (this.curveWatcher) {
            this.curveWatcher.watch(mint);
          }
          if (this.devWatcher && record.creator && record.creator !== 'UNKNOWN') {
            this.devWatcher.watchDev(mint, record.creator);
          }

          eventBus.emit('STATE_TRANSITION', {
            mint,
            state: record.state,
            record: this.serializeToken(record),
          });
        };

        const rejectStage1 = (verdict) => {
          if (record.state !== TokenState.NARRATIVE_AUDIT) return;
          this.vetoCount++;
          record.stage1_narrative = verdict;
          record.narrativeScore = verdict.narrativeScore;
          record.transitionTo(
            TokenState.REJECTED,
            `STAGE 1 FAILED: WEAK_NARRATIVE (${verdict.theme}, Score: ${verdict.narrativeScore}/100)`
          );
          log(`[STAGE 1 REJECT] ${record.name} dropped: Weak narrative (${verdict.theme}, ${verdict.narrativeScore}/100)`);
          eventBus.emit('STATE_TRANSITION', {
            mint,
            state: record.state,
            reason: record.rejectionReason,
            record: this.serializeToken(record),
          });
        };

        // Evaluate Stage 1: Narrative & Mindshare
        const narrativeVerdict = narrativeEngine.evaluateNarrative(meta);
        record.stage1_narrative = narrativeVerdict;
        record.narrativeScore = narrativeVerdict.narrativeScore;

        if (narrativeVerdict.passed) {
          advanceToStage2(narrativeVerdict);
          return record;
        }

        // If not passed initially, check if metadata is still in-flight / propagating on IPFS
        const isMetadataInFlight = Boolean(record.metadataUri) && (!meta.twitter && !meta.telegram && !meta.description);

        // Schedule adaptive metadata polling (400ms, 1000ms, 2000ms, 3200ms, 4800ms) to resolve in-flight metadata
        const delays = [400, 1000, 2000, 3200, 4800];
        delays.forEach((delay, idx) => {
          setTimeout(async () => {
            if (record.state !== TokenState.NARRATIVE_AUDIT) return;
            try {
              const fresh = await fetchTokenMetadata(mint, record.name, record.symbol, record.metadataUri);
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
                if (fresh.twitter || fresh.telegram || (fresh.description && fresh.description.length > 20)) {
                  const freshVerdict = narrativeEngine.evaluateNarrative(fresh);
                  record.stage1_narrative = freshVerdict;
                  record.narrativeScore = freshVerdict.narrativeScore;
                  updated = true;

                  if (freshVerdict.passed) {
                    advanceToStage2(freshVerdict);
                    return;
                  }
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

            // If final delay reached and still hasn't passed, issue final Stage 1 rejection
            if (idx === delays.length - 1 && record.state === TokenState.NARRATIVE_AUDIT) {
              const finalVerdict = record.stage1_narrative || narrativeVerdict;
              rejectStage1(finalVerdict);
            }
          }, delay);
        });

        if (!isMetadataInFlight) {
          // No off-chain URI pending; reject immediately
          rejectStage1(narrativeVerdict);
          return record;
        }
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
      if (record.state === TokenState.NARRATIVE_AUDIT) {
        this.vetoCount++;
        record.transitionTo(TokenState.REJECTED, `STAGE 1 FAILED: METADATA_ERROR (${err.message})`);
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
      }
    }

    return record;
  }

  handleBundleMetricsUpdated(data) {
    const mint = data?.mint;
    if (!mint) return;
    const record = this.tokens.get(mint);
    if (!record) return;

    if (data.bundledBuysCount !== undefined && data.bundledBuysCount !== null) {
      record.bundledBuysCount = data.bundledBuysCount;
    }
    if (data.bundlePercent !== undefined && data.bundlePercent !== null) {
      record.bundlePercent = data.bundlePercent;
    }
    record.bundleDataStatus = data.bundleDataStatus || 'VERIFIED';

    // Re-evaluate Stage 0 safety if token hasn't already opened a position or been rejected
    if (record.state !== TokenState.POSITION_OPEN && record.state !== TokenState.BUY_PENDING && record.state !== TokenState.REJECTED && record.state !== TokenState.CLOSED) {
      const isKnownRugger = this.devWatcher ? this.devWatcher.isKnownRugger(record.creator) : false;
      const activeSafetyFilter = this.safetyFilter || new HardSafetyFilter({ maxDevPercent: 8.0, maxBundleWallets: 3, maxBundlePercent: 20.0 });
      const safetyVerdict = activeSafetyFilter.evaluate({
        mint,
        creator: record.creator,
        devPercent: record.devPercent,
        bundledBuysCount: record.bundledBuysCount,
        bundlePercent: record.bundlePercent,
        bundleDataStatus: record.bundleDataStatus,
        isKnownRugger,
        mintDisabled: record.mintDisabled,
        freezeDisabled: record.freezeDisabled,
      });

      record.safetyVerdict = safetyVerdict;

      if (!safetyVerdict.pass) {
        this.vetoCount++;
        record.transitionTo(TokenState.REJECTED, `STAGE 0 HARD SAFETY VETO (VERIFIED BUNDLE): ${safetyVerdict.reason}`);
        log(`[STAGE 0 SAFETY VETO] ${record.name || mint.slice(0, 8)} rejected after on-chain bundle verification: ${safetyVerdict.reason}`);
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
      }
    }
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
      record.updatedAt = Date.now();
      record.txCount++;
      if (tick.isBuy) {
        record.buyVolumeSol += tick.solDelta;
        if (tick.buyerPubkey && tick.traderIdentityStatus === 'VERIFIED') {
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
      const rawBuyerCount = record.uniqueBuyers.size;
      const bundledCount = record.bundledBuysCount || 0;
      const totalObservedCount = rawBuyerCount + bundledCount;

      const isQualityPending = quality.reasons.includes('No buyer data recorded');
      const fallbackBuyers = (rawBuyerCount === 0 && record.txCount >= 5 && record.buyVolumeSol >= 1.5)
        ? Math.min(record.txCount, Math.max(3, Math.floor(record.buyVolumeSol / 0.5)))
        : rawBuyerCount;

      const effectiveOrganicBuyers = isQualityPending 
        ? Math.max(fallbackBuyers, bundledCount > 0 ? bundledCount : 0)
        : Math.max(quality.organicBuyerCount, fallbackBuyers);
      
      const effectiveBuyVolume = isQualityPending 
        ? record.buyVolumeSol 
        : quality.organicBuyVolumeSol;

      const flowVerdict = validateMoneyFlow({
        buyVolumeSol: effectiveBuyVolume,
        sellVolumeSol: record.sellVolumeSol,
        uniqueBuyersCount: rawBuyerCount,
        organicBuyersCount: effectiveOrganicBuyers,
        bundledBuysCount: bundledCount,
        rawBuyersCount: totalObservedCount,
        clusterRisk: quality.coordinationRisk,
        txCount: record.txCount,
        liquiditySol: Number(tick.virtualSolReserves || 30000000000n) / 1e9,
        requiresExceptionalMomentum: record.stage1_narrative?.requiresExceptionalMomentum || false,
        marketCapSol: record.initialMarketCapSol || 30.0,
        topHoldersPercent: record.topHoldersPercent || 0,
        devHoldingPercent: record.devPercent,
        devSoldAny: record.devSoldAny,
      });

      record.stage2_moneyFlow = flowVerdict;
      record.moneyFlowScore = flowVerdict.score;

      eventBus.emit('MONEY_FLOW_TICK', {
        mint,
        buyVolumeSol: record.buyVolumeSol,
        sellVolumeSol: record.sellVolumeSol,
        uniqueBuyers: record.uniqueBuyers.size,
        buyerQuality: record.buyerQuality,
        stage2_moneyFlow: record.stage2_moneyFlow
      });

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
      // Check for severe dump or sell takeover during pattern formation
      if (record.sellVolumeSol >= 3.0 && record.sellVolumeSol > record.buyVolumeSol * 2.0) {
        this.vetoCount++;
        record.transitionTo(TokenState.REJECTED, `STAGE 3 VETO: SEVERE_SELL_PRESSURE (${record.sellVolumeSol.toFixed(1)} SOL sold vs ${record.buyVolumeSol.toFixed(1)} SOL bought)`);
        log(`🚨 [STAGE 3 VETO] Severe sell pressure on ${record.name || mint.slice(0, 8)}! Stopped tracking.`);
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

      const closedCandles = cb.getClosedCandles();
      const patternVerdict = evaluateThreeCandlePattern(closedCandles, {
        timeframeMs: cb.timeframeMs,
        maxAllowedGapMs: Math.max(cb.timeframeMs * 3.5, 20000),
      });
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
          const aiVerdict = this.smartAgent.evaluateEntry({
            devPercent: record.devPercent,
            bundledBuysCount: record.bundledBuysCount || 0,
            devSoldAny: record.devSoldAny,
            buyVolumeSol: record.buyVolumeSol,
            uniqueBuyersCount: record.uniqueBuyers.size,
            entryScore: record.entryScore,
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

    if (this.devWatcher && !this.devWatcher.isSafe(mint)) {
      // If devWatcher is actively reconciling the ATA baseline, give it a brief grace period to resolve
      const devRec = this.devWatcher.monitoredDevs?.get(mint);
      if (devRec && devRec.state === 'RECONCILING') {
        const startWait = Date.now();
        while (devRec.state === 'RECONCILING' && (Date.now() - startWait) < 1500) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!this.devWatcher.isSafe(mint)) {
        log(`[ORCHESTRATOR] Blocking entry for ${record.name}: Developer state is RECONCILING or UNKNOWN.`);
        record.transitionTo(TokenState.REJECTED, 'DEV_STATE_UNRESOLVED');
        eventBus.emit('STATE_TRANSITION', {
          mint,
          state: record.state,
          reason: record.rejectionReason,
          record: this.serializeToken(record),
        });
        return;
      }
    }

    // Guardrail: Daily Loss Cap Protection
    if (this.positionManager.isDailyLossExceeded()) {
      log(`🛑 [DAILY LOSS CAP EXCEEDED] Realized losses reached cap. Blocking new entries.`);
      record.transitionTo(TokenState.REJECTED, 'DAILY_LOSS_CAP_EXCEEDED');
      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        reason: record.rejectionReason,
        record: this.serializeToken(record),
      });
      return;
    }

    // Guardrail: Bonding Curve Graduation Check
    if (this.curveWatcher && typeof this.curveWatcher.isGraduated === 'function' && this.curveWatcher.isGraduated(mint)) {
      log(`[ORCHESTRATOR] Blocking entry for ${record.name}: Bonding curve is already GRADUATED.`);
      record.transitionTo(TokenState.REJECTED, 'CURVE_ALREADY_GRADUATED');
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

    // Guardrail: Portfolio Capacity
    if (this.positionManager.positions.size >= this.maxConcurrentPositions) {
      log(`[ORCHESTRATOR] Portfolio full (${this.maxConcurrentPositions} max active positions). Enqueueing ${record.name} for capacity.`);
      this._enqueueDeferredEntry(record, 'WAITING_FOR_CAPACITY');
      return;
    }

    if (this.positionManager.positions.has(mint)) {
      return;
    }

    // Guardrail: Inter-trade cooldown
    const elapsed = Date.now() - this.lastTradeTime;
    if (elapsed < this.tradeCooldownMs) {
      const waitTime = this.tradeCooldownMs - elapsed;
      log(`[ORCHESTRATOR] Pacing entry for ${record.name}: cooldown active (${Math.ceil(waitTime/1000)}s). Enqueueing for cooldown expiration.`);
      this._enqueueDeferredEntry(record, 'WAITING_FOR_COOLDOWN');
      if (!this.cooldownTimer) {
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          this._processEntryQueue().catch(() => {});
        }, waitTime + 50);
      }
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
        bundledBuysCount: record.bundledBuysCount || 0,
        uniqueBuyersCount: record.uniqueBuyers ? record.uniqueBuyers.size : 0,
        organicBuyersCount: record.buyerQuality?.organicBuyerCount ?? 0,
        bundleDataStatus: record.safetyVerdict?.metrics?.bundleDataStatus || 'VERIFIED',
        imageUrl: record.imageUrl,
        stopLossPercent: this.positionManager.stopLossPercent,
      });

      record.position = position;

      eventBus.emit('STATE_TRANSITION', {
        mint,
        state: record.state,
        record: this.serializeToken(record),
      });

      // Fix 1: If dev dumped while buy was in-flight, immediately trigger emergency frontrun!
      if (record.pendingDevRugAlert || record.devSoldAny) {
        log(`🚨 [IMMEDIATE EMERGENCY FRONTRUN] Executing emergency exit for ${record.name} due to dev dump during buy confirmation window.`);
        if (this.positionManager && typeof this.positionManager.triggerEmergencyFrontrun === 'function') {
          this.positionManager.triggerEmergencyFrontrun(mint, record.pendingDevRugAlert?.isMuleDump ? 'DEV_MULE_DUMP_FRONTRUN' : 'DEV_RUG_FRONTRUN');
        }
      }
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

  _enqueueDeferredEntry(record, stateName) {
    const mint = record.mint;
    const existingIdx = this.entryQueue.findIndex(item => item.mint === mint);
    if (existingIdx >= 0) {
      this.entryQueue[existingIdx].queuedAt = Date.now();
      this.entryQueue[existingIdx].reason = stateName;
      return;
    }

    if (this.entryQueue.length >= this.maxQueueSize) {
      const evicted = this.entryQueue.shift();
      const evictedRecord = this.tokens.get(evicted.mint);
      if (evictedRecord && (evictedRecord.state === TokenState.WAITING_FOR_CAPACITY || evictedRecord.state === TokenState.WAITING_FOR_COOLDOWN)) {
        evictedRecord.transitionTo(TokenState.EXPIRED, 'ENTRY_QUEUE_OVERFLOW');
      }
    }

    const targetState = stateName === 'WAITING_FOR_CAPACITY' ? TokenState.WAITING_FOR_CAPACITY : TokenState.WAITING_FOR_COOLDOWN;
    record.transitionTo(targetState, `Deferred: ${stateName}`);
    eventBus.emit('STATE_TRANSITION', { mint, state: record.state, record: this.serializeToken(record) });

    this.entryQueue.push({
      mint,
      queuedAt: Date.now(),
      reason: stateName,
      breakoutPriceSol: record.lastVirtualSolReserves && record.lastVirtualTokenReserves 
        ? calculateSpotPriceSol(record.lastVirtualSolReserves, record.lastVirtualTokenReserves)
        : 0,
    });
  }

  async _processEntryQueue() {
    if (this.entryQueue.length === 0) return;
    if (!this.autoBuyEnabled) return;

    const now = Date.now();
    const nextQueue = [];

    for (let i = 0; i < this.entryQueue.length; i++) {
      const item = this.entryQueue[i];
      const record = this.tokens.get(item.mint);
      if (!record) continue;

      // 1. Check expiration
      if (now - item.queuedAt > this.maxQueueAgeMs) {
        log(`⌛ [ENTRY EXPIRED] Breakout signal for ${record.name} expired in queue (${Math.round((now - item.queuedAt)/1000)}s > ${this.maxQueueAgeMs/1000}s).`);
        record.transitionTo(TokenState.EXPIRED, 'SIGNAL_VALIDITY_EXPIRED');
        eventBus.emit('STATE_TRANSITION', { mint: item.mint, state: record.state, record: this.serializeToken(record) });
        if (this.curveWatcher) this.curveWatcher.unwatch(item.mint);
        if (this.devWatcher) this.devWatcher.unwatchDev(item.mint);
        continue;
      }

      // 2. Capacity Check
      if (this.positionManager.positions.size >= this.maxConcurrentPositions) {
        nextQueue.push(item);
        continue;
      }

      // 3. Cooldown Check
      const elapsed = now - this.lastTradeTime;
      if (elapsed < this.tradeCooldownMs) {
        nextQueue.push(item);
        // Preserve any remaining queued items that were not yet evaluated
        for (let j = i + 1; j < this.entryQueue.length; j++) {
          nextQueue.push(this.entryQueue[j]);
        }
        const remaining = this.tradeCooldownMs - elapsed;
        if (!this.cooldownTimer) {
          this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = null;
            this._processEntryQueue().catch(() => {});
          }, remaining + 50);
        }
        break;
      }

      // 4. Revalidate Setup Conditions
      record.transitionTo(TokenState.REVALIDATING);
      const isDevSafe = this.devWatcher ? this.devWatcher.isSafe(item.mint) : true;
      const isGraduated = this.curveWatcher ? this.curveWatcher.isGraduated(item.mint) : false;
      const hasHardVeto = record.buyerQuality?.isHardVeto === true;
      const devSold = record.devSoldAny === true;

      if (!isDevSafe || isGraduated || hasHardVeto || devSold) {
        const rejectReason = devSold ? 'DEV_DUMP_WHILE_QUEUED' : (!isDevSafe ? 'DEV_UNSAFE' : (isGraduated ? 'CURVE_GRADUATED' : 'BUYER_QUALITY_VETO'));
        log(`🛑 [REVALIDATION FAILED] Queued entry for ${record.name} rejected: ${rejectReason}`);
        record.transitionTo(TokenState.REJECTED, `REVALIDATION_FAILED: ${rejectReason}`);
        eventBus.emit('STATE_TRANSITION', { mint: item.mint, state: record.state, record: this.serializeToken(record) });
        if (this.curveWatcher) this.curveWatcher.unwatch(item.mint);
        if (this.devWatcher) this.devWatcher.unwatchDev(item.mint);
        continue;
      }

      // Check excessive price drift against breakout price while queued
      const currentPrice = record.lastVirtualSolReserves && record.lastVirtualTokenReserves
        ? calculateSpotPriceSol(record.lastVirtualSolReserves, record.lastVirtualTokenReserves)
        : 0;
      if (item.breakoutPriceSol > 0 && currentPrice > 0) {
        const priceDriftPct = ((currentPrice - item.breakoutPriceSol) / item.breakoutPriceSol) * 100;
        if (priceDriftPct > 25 || priceDriftPct < -20) {
          log(`🛑 [REVALIDATION FAILED] Queued entry for ${record.name} drifted ${priceDriftPct > 0 ? '+' : ''}${priceDriftPct.toFixed(1)}% vs breakout trigger. Rejecting stale signal.`);
          record.transitionTo(TokenState.REJECTED, `REVALIDATION_FAILED: EXCESSIVE_PRICE_DRIFT_${priceDriftPct.toFixed(0)}%`);
          eventBus.emit('STATE_TRANSITION', { mint: item.mint, state: record.state, record: this.serializeToken(record) });
          if (this.curveWatcher) this.curveWatcher.unwatch(item.mint);
          if (this.devWatcher) this.devWatcher.unwatchDev(item.mint);
          continue;
        }
      }

      // Revalidation passed! Transition to ENTRY_READY and trigger execution
      record.transitionTo(TokenState.ENTRY_READY);
      await this.triggerExecution(record);

      // Preserve any remaining queued items that were not yet evaluated
      for (let j = i + 1; j < this.entryQueue.length; j++) {
        nextQueue.push(this.entryQueue[j]);
      }
      break; // Process one buy per queue cycle to respect pacing
    }

    this.entryQueue = nextQueue;
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

    // Fix 3: Re-evaluate queued deferred entries when capacity is freed
    this._processEntryQueue().catch(() => {});

    // Feed trade experience into Smart Agent to enhance win rate
    if (this.smartAgent && typeof this.smartAgent.learnFromTrade === 'function') {
      const isEmergencyRug = typeof closedData.reason === 'string' && (
        closedData.reason.includes('DEV_RUG') || 
        closedData.reason.includes('DEV_MULE_DUMP') ||
        closedData.reason.includes('HONEYPOT_DEV_DUMP')
      );
      if (!isEmergencyRug) {
        this.smartAgent.learnFromTrade({
          ...closedData,
          devPercent: record ? record.devPercent : 0,
          bundleCount: record ? record.bundledBuysCount : 0,
          uniqueBuyersCount: record?.uniqueBuyers ? record.uniqueBuyers.size : (closedData.uniqueBuyersCount || 0),
          organicBuyersCount: record?.buyerQuality?.organicBuyerCount ?? (closedData.organicBuyersCount || 0),
          entryScore: record ? record.entryScore : 0,
          riskScore: record ? record.riskScore : 0,
        });
      } else {
        log(`🛡️ [AI LEARNER SHIELD] Bypassed strategy learning for emergency dev rug liquidation (${closedData.reason}) to preserve pattern conviction.`);
      }
    }
  }

  /**
   * Catches dev dump alerts from DevWatcher and immediately vetoes / stops tracking
   */
  handleDevDumpAlert(alert) {
    const record = this.tokens.get(alert.mint);
    if (record && record.state !== TokenState.REJECTED && record.state !== TokenState.CLOSED) {
      record.devSoldAny = true;
      const isBuyPending = record.state === TokenState.BUY_PENDING;
      const hasOpenPos = (record.state === TokenState.POSITION_OPEN) || (this.positionManager?.positions?.has(alert.mint));

      if (hasOpenPos) {
        log(`🚨 [DEV DUMP WHILE POSITION OPEN] Dev dumped ${(alert.dumpPercent || 0).toFixed(0)}% on ${record.name || alert.mint.slice(0, 8)}! Preserving curve stream for emergency frontrun.`);
        if (this.positionManager && typeof this.positionManager.triggerEmergencyFrontrun === 'function') {
          this.positionManager.triggerEmergencyFrontrun(alert.mint, alert.isMuleDump ? 'DEV_MULE_DUMP_FRONTRUN' : 'DEV_RUG_FRONTRUN');
        }
        return;
      }

      if (isBuyPending) {
        log(`🚨 [DEV DUMP WHILE BUY IN-FLIGHT] Dev dumped ${(alert.dumpPercent || 0).toFixed(0)}% on ${record.name || alert.mint.slice(0, 8)} while buy is pending! Preserving watchers for emergency frontrun upon fill.`);
        record.pendingDevRugAlert = alert;
        return;
      }

      this.vetoCount++;
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
      uniqueBuyers: record.uniqueBuyers ? record.uniqueBuyers.size : 0,
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
