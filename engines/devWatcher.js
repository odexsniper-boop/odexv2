import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '../pumpfun.js';
import { TokenProgramResolver, TOKEN_2022_PROGRAM_ID } from './tokenProgramResolver.js';
import { log } from '../config.js';
import { eventBus } from '../eventBus.js';

export const DevRelationshipRole = {
  PRIMARY_CREATOR: 'PRIMARY_CREATOR',
  DIRECT_CREATOR_RECIPIENT: 'DIRECT_CREATOR_RECIPIENT',
  SUSPECTED_MULE: 'SUSPECTED_MULE',
  UNVERIFIED_RECIPIENT: 'UNVERIFIED_RECIPIENT',
  UNRELATED: 'UNRELATED',
};

// 10 Million Tokens in raw base units (6 decimals on Pump.fun = 1% of 1 Billion total supply)
export const RAW_TOKEN_DUMP_THRESHOLD = 10_000_000_000_000n;

export class DevWatcher {
  constructor(connection, positionManager, db = null, tokenProgramResolver = null) {
    this.connection = connection;
    this.positionManager = positionManager;
    this.db = db;
    this.tokenProgramResolver = tokenProgramResolver || (connection ? new TokenProgramResolver(connection) : null);
    this.monitoredDevs = new Map(); // mint -> { devPubkey, ataPubkey, subId, lastBalance, peakBalance, state, bufferQueue, tokenProgramId }
    this.knownRuggers = new Set();
    // Fix 7: Creator Distribution Graph for Mule Wallet Tracking
    this.creatorDistributionGraphs = new Map(); // mint -> { creatorAddress, initialClusterBaseline, cumulativeDumpedTokens, monitoredWallets, tokenProgramId }
    if (this.db && typeof this.db.getSetting === 'function') {
      try {
        const saved = this.db.getSetting('known_ruggers', []);
        if (Array.isArray(saved)) {
          saved.slice(-5000).forEach(r => this.knownRuggers.add(r));
        }
      } catch (e) {}
    }

    // Fix 6: Wire on-chain transfer events to mule tracking
    eventBus.on('DEV_TRANSFER_DETECTED', (data) => this.handleTransferEvent(data));
  }

  isKnownRugger(creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return false;
    return this.knownRuggers.has(creatorAddress);
  }

  flagRugger(creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return;
    if (this.knownRuggers.size >= 5000) {
      const first = this.knownRuggers.values().next().value;
      this.knownRuggers.delete(first);
    }
    this.knownRuggers.add(creatorAddress);
    if (this.db && typeof this.db.setSetting === 'function') {
      try {
        this.db.setSetting('known_ruggers', Array.from(this.knownRuggers));
      } catch (e) {}
    }
    log(`[DEV WATCHER] Blacklisted dev wallet for past rug behavior: ${creatorAddress.slice(0, 8)}...`);
  }

  getDevRisk(mintAddress) {
    const record = this.monitoredDevs.get(mintAddress);
    if (!record) {
      return {
        status: 'DEV_NORMAL',
        riskLevel: 'NONE',
        holdingTokens: 0,
        holdingPercent: 0,
        cumulativeDumpedTokens: 0,
        cumulativeDumpPercent: 0,
        hasSoldAny: false,
        safeForEntry: true,
        reason: 'Dev not tracked or already unmonitored'
      };
    }

    if (record.state === 'RECONCILING' || record.state === 'UNKNOWN') {
      return {
        status: 'DEV_WATCH',
        riskLevel: 'ELEVATED',
        holdingTokens: Number(record.lastBalance > 0n ? record.lastBalance : 0n) / 1e6,
        holdingPercent: Number(record.lastBalance > 0n ? record.lastBalance : 0n) / 1e7,
        cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens || 0n) / 1e6,
        cumulativeDumpPercent: 0,
        hasSoldAny: false,
        safeForEntry: false,
        reason: `Dev ATA state is ${record.state}`
      };
    }

    const currentBal = record.lastBalance > 0n ? record.lastBalance : 0n;
    const baseline = record.peakBalance > 0n ? record.peakBalance : (record.initialBalance > 0n ? record.initialBalance : currentBal);
    const cumulativePercent = baseline > 0n ? Number((record.cumulativeDumpedTokens * 100n) / baseline) : 0;
    const cumulativeDumpPercent = cumulativePercent;
    const isDepleted = record.isDepleted || currentBal === 0n || (baseline > 0n && (currentBal * 100n / baseline <= 5n) && cumulativePercent >= 90);

    const holdingTokens = Number(currentBal) / 1e6;
    const holdingPercent = Number(currentBal) / 1e7; // % of 1B total supply
    const hasSoldAny = record.cumulativeDumpedTokens > 0n;

    if (isDepleted) {
      return {
        status: 'DEV_DUMP_DETECTED',
        riskLevel: 'FULL_DEPLETION',
        holdingTokens,
        holdingPercent,
        cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens) / 1e6,
        cumulativeDumpPercent,
        hasSoldAny: true,
        safeForEntry: false,
        reason: 'Dev completely dumped allocation (FULL_DEPLETION)'
      };
    }

    if (cumulativePercent >= 20 || record.riskLevel === 'CRITICAL' || record.riskLevel === 'ELEVATED') {
      return {
        status: 'DEV_DUMP_DETECTED',
        riskLevel: record.riskLevel || 'CRITICAL',
        holdingTokens,
        holdingPercent,
        cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens) / 1e6,
        cumulativeDumpPercent,
        hasSoldAny: true,
        safeForEntry: false,
        reason: `Dev dumped ${cumulativePercent.toFixed(1)}% of allocation`
      };
    }

    if (hasSoldAny && cumulativePercent >= 5) {
      return {
        status: 'DEV_DUMP_RISK',
        riskLevel: 'EARLY_WARNING',
        holdingTokens,
        holdingPercent,
        cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens) / 1e6,
        cumulativeDumpPercent,
        hasSoldAny: true,
        safeForEntry: false,
        reason: `Dev actively selling before entry (${cumulativePercent.toFixed(1)}% dumped)`
      };
    }

    return {
      status: 'DEV_NORMAL',
      riskLevel: 'NONE',
      holdingTokens,
      holdingPercent,
      cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens) / 1e6,
      cumulativeDumpPercent,
      hasSoldAny: false,
      safeForEntry: true,
      reason: 'Dev holdings stable, zero dump risk'
    };
  }

  isSafe(mintAddress) {
    const record = this.monitoredDevs.get(mintAddress);
    if (!record) return true; // if we aren't tracking, assume safe or N/A
    // Unsafe if we are still reconciling or couldn't fetch a baseline
    if (record.state === 'RECONCILING' || record.state === 'UNKNOWN') return false;
    const devRisk = this.getDevRisk(mintAddress);
    return devRisk.safeForEntry;
  }

  async watchDev(mintAddress, creatorAddress) {
    if (!creatorAddress || creatorAddress === 'UNKNOWN') return;
    if (this.monitoredDevs.has(mintAddress)) return;

    const MAX_MONITORED_DEVS = 25;
    if (this.monitoredDevs.size >= MAX_MONITORED_DEVS) {
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

      // Fix 1: Resolve token program ID (Token-2022 vs SPL Token) before deriving developer ATA
      let tokenProgId = TOKEN_PROGRAM_ID;
      if (this.tokenProgramResolver) {
        try {
          tokenProgId = await this.tokenProgramResolver.resolve(mintPubkey);
        } catch (e) {
          tokenProgId = TOKEN_PROGRAM_ID;
        }
      }

      const devAta = PublicKey.findProgramAddressSync(
        [creatorPubkey.toBuffer(), tokenProgId.toBuffer(), mintPubkey.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      )[0];

      const record = {
        creatorPubkey,
        devAta,
        tokenProgramId: tokenProgId,
        subId: null,
        initialBalance: -1n,
        peakBalance: -1n,
        lastBalance: -1n,
        totalAcquired: 0n,
        cumulativeDumpedTokens: 0n,
        state: 'RECONCILING',
        bufferQueue: []
      };
      
      this.monitoredDevs.set(mintAddress, record);

      if (this.connection) {
        try {
          record.subId = this.connection.onAccountChange(
            devAta,
            (accountInfo) => {
              this.handleDevAccountUpdate(mintAddress, creatorAddress, accountInfo.data);
            },
            'confirmed'
          );
        } catch (e) {}
      }

      log(`[DEV WATCHER] Guarding ${mintAddress.slice(0, 8)} against dev dump (Creator: ${creatorAddress.slice(0, 8)}...)`);

      try {
        const accInfo = await this.connection.getAccountInfo(devAta, 'confirmed');
        const activeRecord = this.monitoredDevs.get(mintAddress);
        if (activeRecord && activeRecord.state === 'RECONCILING') {
          if (accInfo && accInfo.data && accInfo.data.length >= 72) {
            const bal = accInfo.data.readBigUInt64LE(64);
            activeRecord.initialBalance = bal;
            activeRecord.peakBalance = bal;
            activeRecord.totalAcquired = bal;
            activeRecord.lastBalance = bal;
            activeRecord.state = 'KNOWN';
          } else {
            // Account might not exist yet or is uninitialized
            activeRecord.initialBalance = 0n;
            activeRecord.peakBalance = 0n;
            activeRecord.totalAcquired = 0n;
            activeRecord.lastBalance = 0n;
            activeRecord.state = 'UNINITIALIZED'; // Do not assume permanent 0 baseline
          }
          
          const queue = activeRecord.bufferQueue;
          activeRecord.bufferQueue = [];
          for (const buf of queue) {
            this._processAccountUpdate(mintAddress, creatorAddress, buf);
          }
        }
      } catch (e) {
        const activeRecord = this.monitoredDevs.get(mintAddress);
        if (activeRecord) {
          activeRecord.state = 'UNKNOWN';
          setTimeout(async () => {
            const retryRec = this.monitoredDevs.get(mintAddress);
            if (retryRec && retryRec.state === 'UNKNOWN' && this.connection) {
              try {
                const acc = await this.connection.getAccountInfo(devAta, 'confirmed');
                if (acc && acc.data && acc.data.length >= 72) {
                  const bal = acc.data.readBigUInt64LE(64);
                  retryRec.initialBalance = bal;
                  retryRec.peakBalance = bal;
                  retryRec.totalAcquired = bal;
                  retryRec.lastBalance = bal;
                  retryRec.state = 'KNOWN';
                } else {
                  retryRec.initialBalance = 0n;
                  retryRec.peakBalance = 0n;
                  retryRec.totalAcquired = 0n;
                  retryRec.lastBalance = 0n;
                  retryRec.state = 'UNINITIALIZED';
                }
                log(`[DEV WATCHER RETRY] Resolved dev balance for ${mintAddress.slice(0, 8)} on retry: state=${retryRec.state}`);
              } catch (_) {}
            }
          }, 800);
        }
        log(`[DEV WATCHER ERR] Could not fetch initial balance for ${mintAddress}: ${e.message}`);
      }
    } catch (err) {
      log(`[DEV WATCHER ERR] Could not monitor dev for ${mintAddress.slice(0, 8)}: ${err.message}`);
    }
  }

  handleDevAccountUpdate(mint, creator, buffer) {
    const record = this.monitoredDevs.get(mint);
    if (!record) return;

    if (record.state === 'RECONCILING') {
      record.bufferQueue.push(buffer);
      return;
    }
    
    this._processAccountUpdate(mint, creator, buffer);
  }

  _processAccountUpdate(mint, creator, buffer) {
    const record = this.monitoredDevs.get(mint);
    if (!record) return;

    let currentBalance = 0n;
    if (!buffer || buffer.length === 0) {
      currentBalance = 0n;
      record.state = 'CLOSED';
    } else if (buffer.length >= 72) {
      currentBalance = buffer.readBigUInt64LE(64);
    } else {
      return; 
    }

    // Handle transition from UNINITIALIZED state when ATA is created / first funded
    if (record.state === 'UNINITIALIZED') {
      if (currentBalance > 0n) {
        record.initialBalance = currentBalance;
        record.peakBalance = currentBalance;
        record.totalAcquired = currentBalance;
        record.lastBalance = currentBalance;
        record.state = 'KNOWN';
        log(`[DEV WATCHER] Creator ATA initialized with ${Number(currentBalance)/1e6} tokens for ${mint.slice(0, 8)}`);
        return;
      } else {
        record.lastBalance = 0n;
        return;
      }
    }

    if (record.state === 'KNOWN' || record.state === 'CLOSED') {
      const lastBal = record.lastBalance;

      // Handle subsequent acquisitions or incoming transfers
      if (currentBalance > lastBal) {
        const gained = currentBalance - lastBal;
        record.totalAcquired += gained;
        if (currentBalance > record.peakBalance) {
          record.peakBalance = currentBalance;
        }
        log(`[DEV ACQUISITION] Creator acquired +${Number(gained)/1e6} tokens on ${mint.slice(0, 8)}. Current: ${Number(currentBalance)/1e6}, Peak: ${Number(record.peakBalance)/1e6}`);
      } else if (lastBal > 0n && currentBalance < lastBal) {
        // Reductions (sells, transfers, burns)
        const dumpedTokens = lastBal - currentBalance;
        const dumpPercent = Number((dumpedTokens * 100n) / lastBal);
        
        record.cumulativeDumpedTokens += dumpedTokens;
        
        const baseline = record.peakBalance > 0n ? record.peakBalance : (record.initialBalance > 0n ? record.initialBalance : lastBal);
        const cumulativePercent = baseline > 0n ? Number((record.cumulativeDumpedTokens * 100n) / baseline) : 0;
        
        // Reconciled FULL_DEPLETION condition: Remaining holdings must actually be depleted!
        const isDepleted = currentBalance === 0n || (baseline > 0n && (currentBalance * 100n / baseline <= 5n) && cumulativePercent >= 90);

        let riskLevel = 'NONE';
        if (isDepleted) riskLevel = 'FULL_DEPLETION';
        else if (cumulativePercent >= 50) riskLevel = 'CRITICAL';
        else if (cumulativePercent >= 30) riskLevel = 'ELEVATED';
        else if (cumulativePercent >= 10) riskLevel = 'EARLY_WARNING';
        
        if (dumpPercent >= 30 || dumpedTokens >= RAW_TOKEN_DUMP_THRESHOLD || cumulativePercent >= 30 || isDepleted) {
          log(`⚠️ [DEV RISK DETECTED] Creator allocation reduced by ${cumulativePercent.toFixed(0)}% cumulative (${dumpPercent.toFixed(0)}% this event) on ${mint.slice(0, 8)}. Risk Level: ${riskLevel} (Holding: ${Number(currentBalance)/1e6} / Peak: ${Number(baseline)/1e6})`);

          if (isDepleted || cumulativePercent >= 50 || dumpPercent >= 30) {
            this.flagRugger(creator);
          }

          eventBus.emit('DEV_DUMP_ALERT', {
            mint,
            creator,
            dumpedTokens: Number(dumpedTokens),
            dumpPercent,
            cumulativeDumpedTokens: Number(record.cumulativeDumpedTokens),
            cumulativePercent,
            currentBalance: Number(currentBalance),
            peakBalance: Number(baseline),
            riskLevel,
            isConfirmedMarketSell: false,
            timestamp: Date.now(),
          });

          if (this.positionManager && (dumpPercent >= 30 || dumpedTokens >= RAW_TOKEN_DUMP_THRESHOLD || cumulativePercent >= 50 || isDepleted)) {
            this.positionManager.triggerEmergencyFrontrun(mint, 'DEV_RUG_FRONTRUN');
          }
        }
      }
    }

    record.lastBalance = currentBalance;
    if (record.state !== 'CLOSED' && record.state !== 'UNINITIALIZED') {
      record.state = 'KNOWN';
    }
  }

  registerDistribution(mintAddress, fromWallet, toWallet, tokenAmountRaw, role = DevRelationshipRole.DIRECT_CREATOR_RECIPIENT, evidence = {}) {
    const mint = typeof mintAddress === 'string' ? mintAddress : mintAddress.toBase58();
    let graph = this.creatorDistributionGraphs.get(mint);
    const devRecord = this.monitoredDevs.get(mint);
    const tokenProgId = devRecord?.tokenProgramId || TOKEN_PROGRAM_ID;

    if (!graph) {
      graph = {
        creatorAddress: fromWallet,
        tokenProgramId: tokenProgId,
        initialClusterBaseline: 0n,
        totalAcquired: 0n,
        cumulativeDumpedTokens: 0n,
        monitoredWallets: new Map(),
      };
      this.creatorDistributionGraphs.set(mint, graph);
    }

    const amountBigInt = BigInt(tokenAmountRaw);
    const fromEntry = graph.monitoredWallets.get(fromWallet);
    const toEntry = graph.monitoredWallets.get(toWallet);

    // Internal transfer between monitored wallets: balance moves without false dump alert
    if (fromEntry && toEntry) {
      fromEntry.lastBalance = fromEntry.lastBalance >= amountBigInt ? fromEntry.lastBalance - amountBigInt : 0n;
      toEntry.lastBalance += amountBigInt;
      if (toEntry.lastBalance > toEntry.peakBalance) toEntry.peakBalance = toEntry.lastBalance;
      log(`[DEV DISTRIBUTION] Internal cluster transfer on ${mint.slice(0, 8)}: ${Number(amountBigInt)/1e6} tokens from ${fromWallet.slice(0, 4)}.. to ${toWallet.slice(0, 4)}..`);
      return;
    }

    // Register toWallet as a monitored mule if under cap (max 5 mules per mint)
    if (!toEntry && graph.monitoredWallets.size < 6) {
      let muleSubId = null;
      let muleAta = null;

      if (this.connection) {
        try {
          const mulePubkey = new PublicKey(toWallet);
          const mintPubkey = new PublicKey(mint);
          muleAta = PublicKey.findProgramAddressSync(
            [mulePubkey.toBuffer(), tokenProgId.toBuffer(), mintPubkey.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
          )[0];

          muleSubId = this.connection.onAccountChange(
            muleAta,
            (accountInfo) => {
              this.handleMuleAccountUpdate(mint, toWallet, accountInfo.data);
            },
            'confirmed'
          );
        } catch (err) {
          log(`[DEV WATCHER WARN] Failed to subscribe to mule ATA for ${toWallet.slice(0, 4)}..: ${err.message}`);
        }
      }

      graph.monitoredWallets.set(toWallet, {
        walletPubkey: toWallet,
        muleAta,
        subId: muleSubId,
        role,
        initialAllocation: amountBigInt,
        peakBalance: amountBigInt,
        lastBalance: amountBigInt,
        totalAcquired: amountBigInt,
        cumulativeDumpedTokens: 0n,
        evidence,
      });

      if (fromEntry) {
        fromEntry.lastBalance = fromEntry.lastBalance >= amountBigInt ? fromEntry.lastBalance - amountBigInt : 0n;
      }

      graph.initialClusterBaseline += amountBigInt;
      log(`[DEV MULE REGISTERED] Registered ${role} ${toWallet.slice(0, 4)}.. with ${Number(amountBigInt)/1e6} tokens on ${mint.slice(0, 8)}`);
    }
  }

  handleTransferEvent({ mint, from, to, amount, signature = null }) {
    if (!mint || !from || !to || !amount) return;
    const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
    const fromStr = typeof from === 'string' ? from : from.toBase58();
    const toStr = typeof to === 'string' ? to : to.toBase58();

    const devRecord = this.monitoredDevs.get(mintStr);
    if (!devRecord) return;
    const creatorStr = devRecord.creatorPubkey.toBase58();

    const isFromCreator = fromStr === creatorStr;
    const graph = this.creatorDistributionGraphs.get(mintStr);
    const isFromMule = graph && graph.monitoredWallets.has(fromStr);

    if ((isFromCreator || isFromMule) && toStr !== creatorStr) {
      const role = isFromCreator ? DevRelationshipRole.DIRECT_CREATOR_RECIPIENT : DevRelationshipRole.SUSPECTED_MULE;
      this.registerDistribution(mintStr, fromStr, toStr, amount, role, { signature });
    }
  }

  handleMuleAccountUpdate(mintAddress, walletAddress, buffer) {
    const mint = typeof mintAddress === 'string' ? mintAddress : mintAddress.toBase58();
    const graph = this.creatorDistributionGraphs.get(mint);
    if (!graph) return;

    const mule = graph.monitoredWallets.get(walletAddress);
    if (!mule) return;

    let currentBalance = 0n;
    if (!buffer || buffer.length === 0) {
      currentBalance = 0n;
    } else if (buffer.length >= 72) {
      currentBalance = buffer.readBigUInt64LE(64);
    } else {
      return;
    }

    const lastBal = mule.lastBalance;
    if (currentBalance < lastBal) {
      const dumpedTokens = lastBal - currentBalance;
      const dumpPercent = lastBal > 0n ? Number((dumpedTokens * 100n) / lastBal) : 0;
      mule.cumulativeDumpedTokens += dumpedTokens;
      graph.cumulativeDumpedTokens += dumpedTokens;

      const clusterBaseline = graph.initialClusterBaseline > 0n ? graph.initialClusterBaseline : 1n;
      const clusterPercent = Number((graph.cumulativeDumpedTokens * 100n) / clusterBaseline);

      let riskLevel = 'NONE';
      if (clusterPercent >= 50 || currentBalance === 0n) riskLevel = 'CRITICAL';
      else if (clusterPercent >= 30) riskLevel = 'ELEVATED';
      else if (clusterPercent >= 10) riskLevel = 'EARLY_WARNING';

      if (dumpPercent >= 30 || dumpedTokens >= RAW_TOKEN_DUMP_THRESHOLD || clusterPercent >= 30) {
        log(`🚨 [DEV MULE DUMP] Monitored mule ${walletAddress.slice(0, 4)}.. dumped ${dumpPercent}% (Cluster: ${clusterPercent}%) on ${mint.slice(0, 8)}. Risk Level: ${riskLevel}`);

        this.flagRugger(walletAddress);
        if (graph.creatorAddress) this.flagRugger(graph.creatorAddress);

        eventBus.emit('DEV_DUMP_ALERT', {
          mint,
          creator: graph.creatorAddress || walletAddress,
          muleWallet: walletAddress,
          isMuleDump: true,
          dumpedTokens: Number(dumpedTokens),
          dumpPercent,
          cumulativeDumpedTokens: Number(graph.cumulativeDumpedTokens),
          cumulativePercent: clusterPercent,
          currentBalance: Number(currentBalance),
          peakBalance: Number(clusterBaseline),
          riskLevel,
          isConfirmedMarketSell: false,
          timestamp: Date.now(),
        });

        if (this.positionManager && (dumpPercent >= 30 || clusterPercent >= 30)) {
          this.positionManager.triggerEmergencyFrontrun(mint, 'DEV_MULE_DUMP_FRONTRUN');
        }
      }
    }

    mule.lastBalance = currentBalance;
  }

  getDistributionGraph(mintAddress) {
    const mint = typeof mintAddress === 'string' ? mintAddress : mintAddress.toBase58();
    return this.creatorDistributionGraphs.get(mint) || null;
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
    const graph = this.creatorDistributionGraphs.get(mintAddress);
    if (graph) {
      for (const mule of graph.monitoredWallets.values()) {
        if (mule.subId !== null && mule.subId !== undefined && this.connection) {
          try {
            Promise.resolve(this.connection.removeAccountChangeListener(mule.subId)).catch(() => {});
          } catch (e) {}
        }
      }
    }
    this.creatorDistributionGraphs.delete(mintAddress);
  }

  unwatchDev(mintAddress) {
    this.unwatch(mintAddress);
  }
}
