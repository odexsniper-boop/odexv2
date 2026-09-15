import { PublicKey } from '@solana/web3.js';
import { eventBus } from '../eventBus.js';
import { log, CONFIG } from '../config.js';
import WebSocket from 'ws';
import { getBondingCurvePDA, PUMP_PROGRAM_ID } from '../pumpfun.js';

export class BondingCurveWatcher {
  constructor(connection, positionManager, executionEngine = null) {
    this.connection = connection; 
    this.positionManager = positionManager; 
    this.executionEngine = executionEngine;
    this.watchedMints = new Set(); 
    this.ws = null; 
    this.reconnectTimeout = null;
    this.pollInterval = null;
    this.lastKnownReserves = new Map();
    this.recentTrades = new Set();
    this.onLogsSubId = null;
    this.pumpPortalStreaming = false;

    this.connectWs();
    this.startOnChainTradeStream();
    this.startPollingFallback();
  }

  connectWs() {
    try {
      const apiKey = process.env.PUMPPORTAL_API_KEY || CONFIG.SOLANA?.PUMPPORTAL_API_KEY;
      const wsUrl = apiKey ? `wss://pumpportal.fun/api/data?api-key=${apiKey}` : 'wss://pumpportal.fun/api/data';
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => {
        log('[CURVE WATCHER] Connected to PumpPortal Trade Stream');
        for (const mint of this.watchedMints) this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      });
      this.ws.on('message', (data) => {
        try { 
          const d = JSON.parse(data.toString()); 
          if (d.message) {
            if (d.message.includes('only available when connecting with an API key funded') || d.message.includes('not linked to a valid wallet')) {
              log(`[CURVE WATCHER] PumpPortal Trade Stream note: ${d.message}. Real-time On-Chain Trade Stream is ACTIVE.`);
              this.pumpPortalStreaming = false;
            } else if (d.message.includes('Successfully subscribed')) {
              this.pumpPortalStreaming = true;
            }
          }
          if (d.txType === 'buy' || d.txType === 'sell') {
            this.pumpPortalStreaming = true;
            this.handleTradeEvent(d); 
          }
        } catch (e) {
          console.error('[DEBUG CURVE ERROR]', e);
        }
      });
      this.ws.on('close', () => { 
        this.pumpPortalStreaming = false;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout); 
        this.reconnectTimeout = setTimeout(() => this.connectWs(), 2000); 
      });
      this.ws.on('error', () => {});
    } catch (e) { 
      if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout); 
      this.reconnectTimeout = setTimeout(() => this.connectWs(), 2000); 
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

  async watch(mintAddress) {
    if (this.watchedMints.has(mintAddress)) return;
    this.watchedMints.add(mintAddress);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mintAddress] }));
  }

  unwatch(mintAddress) {
    if (this.watchedMints.has(mintAddress)) {
      this.watchedMints.delete(mintAddress);
      this.lastKnownReserves.delete(mintAddress);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mintAddress] }));
    }
  }

  startPollingFallback() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(async () => {
      // If PumpPortal WebSocket or On-Chain WS is actively streaming, do not spam RPC with polling
      if ((this.ws && this.pumpPortalStreaming) || this.onLogsSubId != null) return;
      if (this.watchedMints.size === 0 || !this.connection) return;

      const mintsToPoll = Array.from(this.watchedMints).slice(0, 50);
      try {
        const pdas = mintsToPoll.map(m => getBondingCurvePDA(new PublicKey(m)));
        const accounts = await this.connection.getMultipleAccountsInfo(pdas, 'confirmed');

        for (let i = 0; i < mintsToPoll.length; i++) {
          const mint = mintsToPoll[i];
          const acc = accounts ? accounts[i] : null;
          if (acc && acc.data && acc.data.length >= 24) {
            const vTok = acc.data.readBigUInt64LE(8);
            const vSol = acc.data.readBigUInt64LE(16);

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
                  traderPublicKey: `rpc_fallback_${Date.now()}_${Math.floor(Math.random()*1000)}`
                };
                this.handleTradeEvent(simulatedEvent);
              }
            }
          }
        }
      } catch (e) {
        // Silently ignore fallback polling errors
      }
    }, 5000); // Poll every 5s only as a fallback
  }

  handleTradeEvent(d) {
    const mint = d.mint;
    if (!this.watchedMints.has(mint)) return;

    // Deduplicate identical trade events arriving across multiple streams
    const amtStr = typeof d.solAmount === 'number' ? d.solAmount.toFixed(4) : String(d.solAmount || 0);
    const tradeKey = `${mint}_${d.txType}_${d.traderPublicKey || 'unk'}_${amtStr}_${Math.floor(Date.now() / 1500)}`;
    if (this.recentTrades.has(tradeKey)) return;
    this.recentTrades.add(tradeKey);
    if (this.recentTrades.size > 2000) {
      const first = this.recentTrades.values().next().value;
      this.recentTrades.delete(first);
    }

    const vSol = BigInt(Math.floor(d.vSolInBondingCurve * 1e9));
    const vTok = BigInt(Math.floor(d.vTokensInBondingCurve * 1e6));
    let priceSol = 0;
    if (vTok > 0n) {
      const priceScaled = (vSol * 100000000n) / vTok;
      priceSol = Number(priceScaled) / 100000000.0;
    }
    if (this.positionManager) this.positionManager.updatePrice(mint, vSol, vTok);
    if (this.executionEngine && this.executionEngine.updateCurveState) this.executionEngine.updateCurveState(mint, {virtualSolReserves: vSol, virtualTokenReserves: vTok});
    eventBus.emit('CURVE_TICK', {
      mint, priceSol, solDelta: d.solAmount || 0, isBuy: d.txType === 'buy', hasTraded: true, buyerPubkey: d.traderPublicKey, virtualSolReserves: vSol, virtualTokenReserves: vTok, timestamp: Date.now()
    });
  }
}
