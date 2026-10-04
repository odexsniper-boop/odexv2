import { PublicKey } from '@solana/web3.js';
import { eventBus } from '../eventBus.js';
import { log, CONFIG } from '../config.js';
import WebSocket from 'ws';
import { getBondingCurvePDA, PUMP_PROGRAM_ID, calculateSpotPriceSol } from '../pumpfun.js';

export const CurveLifecycle = {
  BONDING: 'BONDING',
  NEAR_GRADUATION: 'NEAR_GRADUATION',
  GRADUATED: 'GRADUATED',
  MIGRATING: 'MIGRATING',
  MIGRATED: 'MIGRATED',
  UNKNOWN: 'UNKNOWN',
  RECONCILING: 'RECONCILING',
};

export class BondingCurveWatcher {
  constructor(connection, positionManager, executionEngine = null) {
    this.connection = connection; 
    this.positionManager = positionManager; 
    this.executionEngine = executionEngine;
    this.watchedMints = new Set(); 
    this.ws = null; 
    this.reconnectTimeout = null;
    this.pollInterval = null;
    this.healthCheckInterval = null;
    this.lastKnownReserves = new Map();
    this.recentTrades = new Set();
    this.onLogsSubId = null;
    this.pumpPortalStreaming = false;
    this.pumpPortalTradeSupported = true;
    this.hasWarnedUnfundedApiKey = false;

    // Fix 1: Explicit Curve Lifecycle State Tracking
    this.curveLifecycles = new Map(); // mint -> CurveLifecycle
    this.graduationMetadata = new Map(); // mint -> { graduatedAt, realSol, realTok, isComplete }

    // Fix 4: Resilient Stream Health and Liveness Monitoring
    this.streamHealth = {
      status: 'INITIALIZING', // 'HEALTHY', 'DEGRADED', 'RECONNECTING', 'POLLING_FALLBACK'
      lastMessageAt: Date.now(),
      lastTransactionAt: 0,
      reconnectCount: 0,
      droppedEvents: 0,
      errorCount: 0,
      activeSubscriptions: 0,
    };

    this.connectWs();
    this.startOnChainTradeStream();
    this.startPollingFallback();
    this.startStreamHealthMonitor();
  }

  getLifecycle(mint) {
    return this.curveLifecycles.get(mint) || CurveLifecycle.BONDING;
  }

  isGraduated(mint) {
    const state = this.getLifecycle(mint);
    return state === CurveLifecycle.GRADUATED || state === CurveLifecycle.MIGRATING || state === CurveLifecycle.MIGRATED;
  }

  getStreamHealth() {
    return {
      ...this.streamHealth,
      watchedCount: this.watchedMints.size,
      pumpPortalStreaming: this.pumpPortalStreaming,
    };
  }

  _scheduleWsReconnect() {
    this.pumpPortalStreaming = false;
    this.streamHealth.status = 'RECONNECTING';
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.streamHealth.reconnectCount++;
    const backoff = Math.min(20000, 1000 * Math.pow(1.5, Math.min(this.streamHealth.reconnectCount, 8)));
    const jitter = Math.random() * 500;
    this.reconnectTimeout = setTimeout(() => this.connectWs(), backoff + jitter);
  }

  startStreamHealthMonitor() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceMsg = now - this.streamHealth.lastMessageAt;
      if (timeSinceMsg > 60000 && this.watchedMints.size > 0) {
        if (this.streamHealth.status !== 'DEGRADED') {
          this.streamHealth.status = 'DEGRADED';
          log(`[STREAM HEALTH WARN] No trade messages received in ${Math.round(timeSinceMsg / 1000)}s while watching ${this.watchedMints.size} mints. Stream is DEGRADED.`);
          eventBus.emit('STREAM_HEALTH_DEGRADED', { timeSinceLastMessageMs: timeSinceMsg, watchedCount: this.watchedMints.size });
        }
      } else if (this.pumpPortalStreaming || timeSinceMsg < 20000) {
        if (this.streamHealth.status !== 'HEALTHY') {
          this.streamHealth.status = 'HEALTHY';
          this.streamHealth.reconnectCount = 0;
        }
      }
    }, 5000);
  }

  connectWs() {
    try {
      const apiKey = process.env.PUMPPORTAL_API_KEY || CONFIG.SOLANA?.PUMPPORTAL_API_KEY;
      const wsUrl = apiKey ? `wss://pumpportal.fun/api/data?api-key=${apiKey}` : 'wss://pumpportal.fun/api/data';
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => {
        log('[CURVE WATCHER] Connected to PumpPortal Trade Stream');
        this.streamHealth.status = 'HEALTHY';
        this.streamHealth.lastMessageAt = Date.now();
        if (this.pumpPortalTradeSupported !== false) {
          for (const mint of this.watchedMints) this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        }
      });
      this.ws.on('message', (data) => {
        try { 
          this.streamHealth.lastMessageAt = Date.now();
          const d = JSON.parse(data.toString()); 
          if (d.message) {
            if (d.message.includes('only available when connecting with an API key funded') || d.message.includes('not linked to a valid wallet')) {
              this.pumpPortalStreaming = false;
              this.pumpPortalTradeSupported = false;
              if (!this.hasWarnedUnfundedApiKey) {
                this.hasWarnedUnfundedApiKey = true;
                log(`[CURVE WATCHER] PumpPortal trade stream requires an API key funded with >=0.02 SOL. On-Chain Trade Stream fallback is ACTIVE.`);
              }
            } else if (d.message.includes('Successfully subscribed')) {
              this.pumpPortalStreaming = true;
            }
          }
          if (d.txType === 'buy' || d.txType === 'sell') {
            this.pumpPortalStreaming = true;
            this.handleTradeEvent({
              ...d,
              traderPublicKey: d.traderPublicKey || d.user || null,
              signature: d.signature || d.txHash || null,
            }); 
          }
        } catch (e) {
          console.error('[DEBUG CURVE ERROR]', e);
        }
      });
      this.ws.on('close', () => { 
        this._scheduleWsReconnect();
      });
      this.ws.on('error', () => {
        this.streamHealth.errorCount++;
      });
    } catch (e) { 
      this._scheduleWsReconnect();
    }
  }

  startOnChainTradeStream() {
    if (!this.connection || this.onLogsSubId != null) return;
    const DISCRIMINATOR = Buffer.from('bddb7fd34ee661ee', 'hex');

    try {
      this.onLogsSubId = this.connection.onLogs(
        PUMP_PROGRAM_ID,
        (logInfo) => {
          if (this.watchedMints.size === 0) return;
          const logs = logInfo.logs || [];
          for (const logLine of logs) {
            if (logLine.startsWith('Program data: ')) {
              try {
                const raw = Buffer.from(logLine.slice(14), 'base64');
                if (raw.length >= 113 && raw.subarray(0, 8).equals(DISCRIMINATOR)) {
                  const mint = new PublicKey(raw.subarray(8, 40)).toBase58();
                  if (!this.watchedMints.has(mint)) continue;

                  const solAmount = Number(raw.readBigUInt64LE(40)) / 1e9;
                  const isBuy = raw.readUInt8(56) === 1;
                  const traderPublicKey = new PublicKey(raw.subarray(57, 89)).toBase58();
                  const vSol = raw.readBigUInt64LE(97);
                  const vTok = raw.readBigUInt64LE(105);

                  this.handleTradeEvent({
                    mint,
                    txType: isBuy ? 'buy' : 'sell',
                    vSolInBondingCurve: Number(vSol) / 1e9,
                    vTokensInBondingCurve: Number(vTok) / 1e6,
                    solAmount,
                    traderPublicKey,
                    signature: logInfo.signature || null,
                    eventSource: 'RPC_TRANSACTION',
                    traderIdentityStatus: 'VERIFIED'
                  });
                }
              } catch (e) {}
            }
          }
        },
        'processed'
      );
      log('[CURVE WATCHER] Zero-Delay On-Chain Trade Stream connected (Full Buyer & Reserve Tracking)');
    } catch (err) {
      log(`[CURVE WATCHER WARN] Failed to subscribe to on-chain trade stream: ${err.message}`);
    }
  }

  _updateLifecycleFromAccount(mint, isComplete, realSol, realTok) {
    const prev = this.getLifecycle(mint);
    if (isComplete) {
      if (prev !== CurveLifecycle.GRADUATED && prev !== CurveLifecycle.MIGRATING && prev !== CurveLifecycle.MIGRATED) {
        this.curveLifecycles.set(mint, CurveLifecycle.GRADUATED);
        this.graduationMetadata.set(mint, { graduatedAt: Date.now(), realSol, realTok, isComplete: true });
        const solLabel = (realSol === 0n || realSol === 0) ? 'Reserves migrated to DEX' : `Real SOL: ${Number(realSol)/1e9}`;
        log(`🎓 [CURVE GRADUATED] Authoritative on-chain graduation confirmed for ${mint.slice(0, 8)} (complete=true, ${solLabel})`);
        eventBus.emit('BONDING_CURVE_GRADUATED', { mint, state: CurveLifecycle.GRADUATED, realSol, realTok, isComplete: true, timestamp: Date.now() });
        eventBus.emit('CURVE_LIFECYCLE_CHANGED', { mint, state: CurveLifecycle.GRADUATED, previousState: prev, isComplete: true });
        if (this.positionManager && typeof this.positionManager.handleCurveGraduated === 'function') {
          this.positionManager.handleCurveGraduated(mint);
        }
      }
    } else if (realSol >= 75_000_000_000n) {
      if (prev !== CurveLifecycle.NEAR_GRADUATION && prev !== CurveLifecycle.GRADUATED) {
        this.curveLifecycles.set(mint, CurveLifecycle.NEAR_GRADUATION);
        log(`⚠️ [CURVE PROXIMITY] ${mint.slice(0, 8)} approaching graduation threshold (${(Number(realSol)/1e9).toFixed(2)} / 85 SOL)`);
        eventBus.emit('BONDING_CURVE_NEAR_GRADUATION', { mint, state: CurveLifecycle.NEAR_GRADUATION, realSol, timestamp: Date.now() });
        eventBus.emit('CURVE_LIFECYCLE_CHANGED', { mint, state: CurveLifecycle.NEAR_GRADUATION, previousState: prev, isComplete: false });
      }
    } else if (!this.curveLifecycles.has(mint)) {
      this.curveLifecycles.set(mint, CurveLifecycle.BONDING);
    }
  }

  async watch(mintAddress) {
    if (this.watchedMints.has(mintAddress)) return;
    this.watchedMints.add(mintAddress);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.pumpPortalTradeSupported !== false) {
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mintAddress] }));
    }
  }

  unwatch(mintAddress) {
    if (this.watchedMints.has(mintAddress)) {
      this.watchedMints.delete(mintAddress);
      this.lastKnownReserves.delete(mintAddress);
      this.curveLifecycles.delete(mintAddress);
      this.graduationMetadata.delete(mintAddress);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mintAddress] }));
    }
  }

  startPollingFallback() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(async () => {
      if (this.watchedMints.size === 0 || !this.connection) return;

      // Priority scheduling: Open positions first, then tokens approaching graduation (vSol >= 70 SOL)
      const priorityMints = [];
      if (this.positionManager && this.positionManager.positions) {
        for (const mint of this.positionManager.positions.keys()) {
          if (this.watchedMints.has(mint)) priorityMints.push(mint);
        }
      }
      for (const [m, res] of this.lastKnownReserves.entries()) {
        if (!priorityMints.includes(m) && res.vSol && res.vSol >= 70_000_000_000n && this.watchedMints.has(m)) {
          priorityMints.push(m);
        }
      }

      // If PumpPortal WebSocket is actively streaming, ONLY poll priority mints (open positions & near-graduation)
      // to detect on-chain graduation without spamming RPC for all exploratory tokens
      if (this.ws && this.pumpPortalStreaming && priorityMints.length === 0) return;

      const otherMints = (this.ws && this.pumpPortalStreaming)
        ? []
        : Array.from(this.watchedMints).filter(m => !priorityMints.includes(m));
      const mintsToPoll = [...priorityMints, ...otherMints].slice(0, 50);
      if (mintsToPoll.length === 0) return;

      try {
        const pdas = mintsToPoll.map(m => getBondingCurvePDA(new PublicKey(m)));
        const accounts = await this.connection.getMultipleAccountsInfo(pdas, 'confirmed');

        for (let i = 0; i < mintsToPoll.length; i++) {
          const mint = mintsToPoll[i];
          const acc = accounts ? accounts[i] : null;
          if (acc && acc.data && acc.data.length >= 24) {
            const vTok = acc.data.readBigUInt64LE(8);
            const vSol = acc.data.readBigUInt64LE(16);
            const realTok = acc.data.length >= 32 ? acc.data.readBigUInt64LE(24) : 0n;
            const realSol = acc.data.length >= 40 ? acc.data.readBigUInt64LE(32) : 0n;
            const isComplete = acc.data.length >= 49 ? acc.data.readUInt8(48) === 1 : false;

            this._updateLifecycleFromAccount(mint, isComplete, realSol, realTok);

            const last = this.lastKnownReserves.get(mint);
            if (!last || last.vSol !== vSol) {
              this.lastKnownReserves.set(mint, { vSol, vTok, timestamp: Date.now() });

              if (last) {
                const solDeltaN = vSol - last.vSol;
                const isBuy = solDeltaN > 0n;
                const solAmount = Math.abs(Number(solDeltaN) / 1e9);

                const simulatedEvent = {
                  mint,
                  txType: isBuy ? 'buy' : 'sell',
                  vSolInBondingCurve: Number(vSol) / 1e9,
                  vTokensInBondingCurve: Number(vTok) / 1e6,
                  solAmount: solAmount,
                  traderPublicKey: null,
                  eventSource: 'RESERVE_POLL',
                  traderIdentityStatus: 'UNKNOWN'
                };
                this.handleTradeEvent(simulatedEvent);
              }
            }
          }
        }
      } catch (e) {
        this.streamHealth.errorCount++;
      }
    }, 5000); // Poll every 5s only as a fallback
  }

  handleTradeEvent(d) {
    const mint = d.mint;
    if (!this.watchedMints.has(mint)) return;

    d.eventSource = d.eventSource || 'WEBSOCKET';
    d.traderIdentityStatus = d.traderIdentityStatus || (d.traderPublicKey ? 'VERIFIED' : 'UNKNOWN');

    const vSol = BigInt(Math.floor(d.vSolInBondingCurve * 1e9));
    const vTok = BigInt(Math.floor(d.vTokensInBondingCurve * 1e6));

    // Deduplicate identical trade events using transaction signature or deterministic fallback
    let tradeKey;
    const sig = d.signature || d.txHash;
    if (sig) {
      tradeKey = `SIG_${sig}${d.instructionIndex !== undefined ? `_${d.instructionIndex}` : ''}`;
    } else if (d.eventSource === 'RESERVE_POLL') {
      tradeKey = `POLL_${mint}_${vSol.toString()}_${vTok.toString()}`;
    } else {
      tradeKey = `RAW_${mint}_${d.txType}_${d.traderPublicKey || 'unk'}_${d.solAmount}_${vSol.toString()}_${d.timestamp || Date.now()}`;
    }

    if (this.recentTrades.has(tradeKey)) return;
    this.recentTrades.add(tradeKey);
    if (this.recentTrades.size > 5000) {
      const first = this.recentTrades.values().next().value;
      this.recentTrades.delete(first);
    }

    // Canonical Spot Price in SOL per Token (Fix 4)
    const priceSol = calculateSpotPriceSol(vSol, vTok);

    if (this.positionManager) this.positionManager.updatePrice(mint, vSol, vTok);
    if (this.executionEngine && this.executionEngine.updateCurveState) this.executionEngine.updateCurveState(mint, {virtualSolReserves: vSol, virtualTokenReserves: vTok});
    eventBus.emit('CURVE_TICK', {
      mint, priceSol, solDelta: d.solAmount || 0, isBuy: d.txType === 'buy', hasTraded: true, buyerPubkey: d.traderPublicKey, virtualSolReserves: vSol, virtualTokenReserves: vTok, timestamp: Date.now(),
      eventSource: d.eventSource, traderIdentityStatus: d.traderIdentityStatus
    });

    // Proactive Graduation Check: If reserves indicate virtual SOL >= 115 SOL (~85 real SOL on pump.fun),
    // immediately check the on-chain account completion status!
    if (vSol >= 115_000_000_000n && !this.isGraduated(mint) && this.connection) {
      this.checkAccountGraduation(mint).catch(() => {});
    }
  }

  async checkAccountGraduation(mint) {
    if (!this.connection) return;
    try {
      const pda = getBondingCurvePDA(new PublicKey(mint));
      const acc = await this.connection.getAccountInfo(pda, 'confirmed');
      if (acc && acc.data && acc.data.length >= 49) {
        const realTok = acc.data.length >= 32 ? acc.data.readBigUInt64LE(24) : 0n;
        const realSol = acc.data.length >= 40 ? acc.data.readBigUInt64LE(32) : 0n;
        const isComplete = acc.data.readUInt8(48) === 1;
        this._updateLifecycleFromAccount(mint, isComplete, realSol, realTok);
      }
    } catch (e) {}
  }
}
