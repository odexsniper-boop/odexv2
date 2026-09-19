import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '../pumpfun.js';
import { log } from '../config.js';
import { eventBus } from '../eventBus.js';

export class DevWatcher {
  constructor(connection, positionManager) {
    this.connection = connection;
    this.positionManager = positionManager;
    this.monitoredDevs = new Map(); // mint -> { devPubkey, ataPubkey, subId, lastBalance }
    this.knownRuggers = new Set();  // set of dev addresses flagged for past rugs
  }

  /**
   * Fast check if creator has a flagged rug history
   */
  isKnownRugger(creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return false;
    return this.knownRuggers.has(creatorAddress);
  }

  /**
   * Flag creator as a rugger in memory
   */
  flagRugger(creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return;
    this.knownRuggers.add(creatorAddress);
    log(`[DEV WATCHER] Blacklisted dev wallet for past rug behavior: ${creatorAddress.slice(0, 8)}...`);
  }

  /**
   * Derives creator's Associated Token Account and monitors balance for immediate dumps
   */
  async watchDev(mintAddress, creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return;
    if (this.monitoredDevs.has(mintAddress)) return;

    // Guardrail: Cap max concurrent dev subscriptions to prevent RPC subscription / memory leaks
    const MAX_MONITORED_DEVS = 25;
    if (this.monitoredDevs.size >= MAX_MONITORED_DEVS) {
      // Find and evict oldest monitored dev that does NOT have an active open position
      for (const [candidateMint] of this.monitoredDevs.entries()) {
        const hasOpenPos = this.positionManager?.positions?.has(candidateMint);
        if (!hasOpenPos) {
          this.unwatch(candidateMint);
          break;
        }
      }
    }

    try {
      const mintPubkey = new PublicKey(mintAddress);
      const creatorPubkey = new PublicKey(creatorAddress);

      // Derive Dev ATA
      const devAta = PublicKey.findProgramAddressSync(
        [creatorPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      )[0];

      // Initial dev token balance initialized to 0; onAccountChange captures real balance immediately
      const initialBalance = 0;

      // Subscribe to real-time account changes on dev token account
      let subId = null;
      if (this.connection) {
        try {
          subId = this.connection.onAccountChange(
            devAta,
            (accountInfo) => {
              this.handleDevAccountUpdate(mintAddress, creatorAddress, accountInfo.data);
            },
            'confirmed'
          );
        } catch (e) {
          // Socket might be reconnecting
        }
      }

      this.monitoredDevs.set(mintAddress, {
        creatorPubkey,
        devAta,
        subId,
        lastBalance: initialBalance,
      });

      log(`[DEV WATCHER] Guarding ${mintAddress.slice(0, 8)} against dev dump (Creator: ${creatorAddress.slice(0, 8)}...)`);
    } catch (err) {
      log(`[DEV WATCHER ERR] Could not monitor dev for ${mintAddress.slice(0, 8)}: ${err.message}`);
    }
  }

  /**
   * Evaluates dev balance drop in real-time
   */
  handleDevAccountUpdate(mint, creator, buffer) {
    if (!buffer || buffer.length < 72) return;

    try {
      // In SPL token account layout, amount is 8 bytes at offset 64
      const currentBalance = Number(buffer.readBigUInt64LE(64));
      const record = this.monitoredDevs.get(mint);

      if (record && record.lastBalance > 0 && currentBalance < record.lastBalance) {
        const dumpedTokens = record.lastBalance - currentBalance;
        const dumpPercent = (dumpedTokens / record.lastBalance) * 100;
        
        // Require significant dump (>= 30% of dev balance or >= 10M tokens) to prevent panic exiting on small transfers
        if (dumpPercent >= 30 || dumpedTokens >= 10_000_000) {
          log(`⚠️ [DEV DUMP DETECTED] Creator dumped ${dumpPercent.toFixed(0)}% (${(dumpedTokens / 1e6).toFixed(1)}M) tokens on ${mint.slice(0, 8)}! Triggering Emergency Frontrun Exit.`);

          // Blacklist dev wallet for future launches
          this.flagRugger(creator);

          eventBus.emit('DEV_DUMP_ALERT', {
            mint,
            creator,
            dumpedTokens,
            timestamp: Date.now(),
          });

          // Trigger Priority Frontrun Exit via Position Manager
          this.positionManager.triggerEmergencyFrontrun(mint, 'DEV_RUG_FRONTRUN');
        }
      }

      if (record) {
        record.lastBalance = currentBalance;
      }
    } catch (e) {}
  }

  unwatch(mintAddress) {
    const record = this.monitoredDevs.get(mintAddress);
    if (record) {
      this.monitoredDevs.delete(mintAddress);
      if (record.subId !== undefined && record.subId !== null && this.connection) {
        try {
          Promise.resolve(this.connection.removeAccountChangeListener(record.subId)).catch(() => {});
        } catch (e) {}
      }
    }
  }

  unwatchDev(mintAddress) {
    this.unwatch(mintAddress);
  }
}
