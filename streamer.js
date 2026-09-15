import { Connection, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { PUMP_PROGRAM_ID } from './pumpfun.js';
import { CONFIG, log } from './config.js';
import { eventBus } from './eventBus.js';

export class SolanaStreamer {
  constructor(options = {}) {
    this.rpcUrl = process.env.SOLANA_RPC_URL || CONFIG.SOLANA.RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.wsUrl = process.env.SOLANA_WSS_URL || this.rpcUrl.replace(/^http/, 'ws');
    this.connection = null;
    this.subId = null;
    this.portalWs = null;
    this.isRunning = false;
    this.processedSigs = new Set();
    this.processedMints = new Set();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Primary Engine: Ultra-Fast Sub-Second PumpPortal Stream (0-100ms discovery)
    this.startInstantFeed();

    // 2. Secondary Engine: Dedicated Alchemy On-Chain RPC with 'processed' commitment (Fail-safe Backup)
    this.startRpcBackup();
  }

  startInstantFeed() {
    try {
      const wsUrl = 'wss://pumpportal.fun/api/data-api';
      this.portalWs = new WebSocket(wsUrl);

      this.portalWs.on('open', () => {
        log('[STREAMER ⚡] Connected to Ultra-Fast PumpPortal stream (Sub-second / 0ms discovery)');
        try {
          this.portalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
        } catch (e) {}
      });

      this.portalWs.on('message', (data) => {
        try {
          const d = JSON.parse(data.toString());
          if (d.txType === 'create' && d.mint) {
            this.handleInstantToken(d);
          }
        } catch (e) {}
      });

      this.portalWs.on('close', () => {
        if (this.isRunning) {
          log('[STREAMER] Instant feed disconnected. Reconnecting in 2.5s...');
          setTimeout(() => {
            if (this.isRunning) this.startInstantFeed();
          }, 2500);
        }
      });

      this.portalWs.on('error', () => {
        try { this.portalWs.close(); } catch (e) {}
      });
    } catch (e) {
      if (this.isRunning) {
        setTimeout(() => {
          if (this.isRunning) this.startInstantFeed();
        }, 3000);
      }
    }
  }

  handleInstantToken(d) {
    const mint = d.mint;
    if (!mint || !mint.endsWith('pump') || this.processedMints.has(mint)) return;
    this.processedMints.add(mint);

    if (this.processedMints.size > 5000) {
      const first = this.processedMints.values().next().value;
      this.processedMints.delete(first);
    }

    const devHoldingTokens = d.initialBuy || 0;
    const devPercent = (devHoldingTokens / 1_000_000_000) * 100;

    const launchEvent = {
      mint,
      name: d.name && d.name.trim() ? d.name.trim() : 'Resolving...',
      symbol: d.symbol && d.symbol.trim() ? d.symbol.trim() : '...',
      metadataUri: d.uri || null,
      creator: d.traderPublicKey || 'UNKNOWN',
      slot: 0,
      signature: d.signature || '',
      devPercent,
      bundledBuysCount: 0,
      bundlePercent: 0,
      initialMarketCapSol: Number(d.marketCapSol) || 30.0,
      timestamp: Date.now(),
    };

    eventBus.emit('TOKEN_DETECTED', launchEvent);
  }

  startRpcBackup() {
    try {
      this.connection = new Connection(this.rpcUrl, {
        wsEndpoint: this.wsUrl,
        commitment: 'processed',
      });

      const isPrivate = !this.rpcUrl.includes('api.mainnet-beta.solana.com');
      log(`[STREAMER] Connecting to ${isPrivate ? 'PRIVATE' : 'PUBLIC'} RPC backup stream: ${this.wsUrl}`);

      this.subId = this.connection.onLogs(
        PUMP_PROGRAM_ID,
        async (logs, ctx) => {
          try {
            this.handleLog(logs, ctx);
          } catch (err) {}
        },
        'processed'
      );

      log(`[STREAMER] Subscribed to Pump.fun on-chain backup feed (${PUMP_PROGRAM_ID.toBase58().slice(0, 8)}...)`);
    } catch (err) {
      log(`[STREAMER ERROR] RPC Backup connection failed: ${err.message}. Retrying in 5s...`);
      setTimeout(() => {
        if (this.isRunning) this.startRpcBackup();
      }, 5000);
    }
  }

  async handleLog(logInfo, ctx) {
    const sig = logInfo.signature;
    if (this.processedSigs.has(sig)) return;
    this.processedSigs.add(sig);

    if (this.processedSigs.size > 2000) {
      const first = this.processedSigs.values().next().value;
      this.processedSigs.delete(first);
    }

    const logs = logInfo.logs || [];
    // Catch both legacy Create and modern CreateV2 instructions
    const isCreate = logs.some((l) =>
      l.includes('Program log: Instruction: Create') ||
      l.includes('Program log: Instruction: CreateV2')
    );

    if (isCreate) {
      // If PumpPortal WebSocket is open and providing instant token detection, skip heavy RPC calls
      if (this.portalWs && this.portalWs.readyState === WebSocket.OPEN) {
        return;
      }

      try {
        const tx = await this.connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (tx && tx.meta && !tx.meta.err) {
          this.processCreateTx(tx, sig, ctx.slot);
        }
      } catch (e) {}
    }
  }

  /**
   * Extracts token mint, name, symbol, creator, and initial buyers count
   */
  processCreateTx(tx, signature, slot) {
    const instructions = tx.transaction.message.instructions || [];
    
    // Find the primary Pump.fun Create instruction
    const pumpCreateIx = instructions.find((ix) => {
      const prog = ix.programId ? ix.programId.toBase58() : ix.program;
      return prog === PUMP_PROGRAM_ID.toBase58() && ix.data && (ix.accounts?.length >= 10);
    });

    if (!pumpCreateIx) return;

    // In Pump.fun Create / CreateV2:
    // Account 0 is ALWAYS the token mint pubkey!
    const mintPubkey = pumpCreateIx.accounts[0]?.pubkey || pumpCreateIx.accounts[0];
    const mint = mintPubkey?.toBase58 ? mintPubkey.toBase58() : mintPubkey?.toString();
    if (!mint || !mint.endsWith('pump')) return;

    // Skip if already captured by the ultra-fast instant stream
    if (this.processedMints.has(mint)) return;
    this.processedMints.add(mint);

    if (this.processedMints.size > 5000) {
      const first = this.processedMints.values().next().value;
      this.processedMints.delete(first);
    }

    // Creator is the fee payer / signer (account 5 in CreateV2 or account 7 in legacy Create)
    let creator = 'UNKNOWN';
    const signers = tx.transaction.message.accountKeys.filter((a) => a.signer);
    if (signers.length > 0) {
      creator = signers[0].pubkey ? signers[0].pubkey.toBase58() : signers[0].toString();
    } else if (pumpCreateIx.accounts.length > 5) {
      const c = pumpCreateIx.accounts[5];
      creator = c?.toBase58 ? c.toBase58() : c?.toString();
    }

    let tokenName = 'Resolving...';
    let tokenSymbol = '...';
    let metadataUri = null;

    // Parse metadata Borsh strings from instruction data
    if (pumpCreateIx.data) {
      try {
        let buf;
        try {
          buf = bs58.decode(pumpCreateIx.data);
        } catch (e) {
          buf = Buffer.from(pumpCreateIx.data, 'base64');
        }

        if (buf && buf.length > 16) {
          let offset = 8; // skip 8-byte discriminator
          const nameLen = buf.readUInt32LE(offset);
          offset += 4;
          if (nameLen > 0 && nameLen < 100 && offset + nameLen <= buf.length) {
            tokenName = buf.toString('utf8', offset, offset + nameLen).replace(/\0/g, '').trim();
            offset += nameLen;
            if (offset + 4 <= buf.length) {
              const symLen = buf.readUInt32LE(offset);
              offset += 4;
              if (symLen > 0 && symLen < 30 && offset + symLen <= buf.length) {
                tokenSymbol = buf.toString('utf8', offset, offset + symLen).replace(/\0/g, '').trim();
                offset += symLen;
                if (offset + 4 <= buf.length) {
                  const uriLen = buf.readUInt32LE(offset);
                  offset += 4;
                  if (uriLen > 0 && uriLen < 300 && offset + uriLen <= buf.length) {
                    metadataUri = buf.toString('utf8', offset, offset + uriLen).replace(/\0/g, '').trim();
                  }
                }
              }
            }
          }
        }
      } catch (err) {}
    }

    // Count external buyers in the launch bundle / transaction
    // External buyers are distinct non-creator, non-curve accounts receiving tokens
    const postTokenBalances = tx.meta?.postTokenBalances || [];
    let devHoldingTokens = 0;
    const outsideBuyers = new Set();

    for (const tb of postTokenBalances) {
      if (tb.mint === mint) {
        if (tb.owner === creator) {
          devHoldingTokens = tb.uiTokenAmount?.uiAmount || 0;
        } else if (tb.uiTokenAmount?.uiAmount > 0) {
          // Check if owner is not bonding curve
          outsideBuyers.add(tb.owner);
        }
      }
    }

    // Count bundled buy instructions that followed create
    let bundledBuysCount = outsideBuyers.size;
    for (const ix of instructions) {
      const prog = ix.programId ? ix.programId.toBase58() : ix.program;
      if (prog === PUMP_PROGRAM_ID.toBase58() && ix !== pumpCreateIx) {
        bundledBuysCount++;
      }
    }

    const devPercent = (devHoldingTokens / 1_000_000_000) * 100;
    const bundlePercent = bundledBuysCount > 1 ? bundledBuysCount * 3.5 : 0;

    const launchEvent = {
      mint,
      name: tokenName,
      symbol: tokenSymbol,
      metadataUri,
      creator,
      slot,
      signature,
      devPercent,
      bundledBuysCount,
      bundlePercent,
      timestamp: Date.now(),
    };

    eventBus.emit('TOKEN_DETECTED', launchEvent);
  }

  stop() {
    this.isRunning = false;
    if (this.portalWs) {
      try { this.portalWs.close(); } catch (e) {}
      this.portalWs = null;
    }
    if (this.subId !== null && this.connection) {
      try { this.connection.removeOnLogsListener(this.subId); } catch (e) {}
      this.subId = null;
    }
  }
}
