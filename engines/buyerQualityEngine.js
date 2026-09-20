import { log } from '../config.js';

/**
 * Disjoint-Set Union (DSU) for clustering economically related wallets
 */
class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  find(item) {
    if (!this.parent.has(item)) {
      this.parent.set(item, item);
      return item;
    }
    if (this.parent.get(item) !== item) {
      this.parent.set(item, this.find(this.parent.get(item)));
    }
    return this.parent.get(item);
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
      return true;
    }
    return false;
  }
}

/**
 * BuyerQualityEngine
 * 
 * Sits directly between Raw Buyer Identity and Money Flow (Stage 2).
 * Filters sybil swarms, common-funder clusters, same-slot synchronized bots,
 * and high-concentration wash rings to produce:
 * 1. True Organic Buyer Count
 * 2. Cleaned Organic Buy Volume
 * 3. Coordination & Cluster Risk Verdict
 */
export class BuyerQualityEngine {
  constructor(connection = null) {
    this.connection = connection;
    // Per-token buyer maps: mint -> Map(buyerPubkey -> BuyerProfile)
    this.tokenBuyers = new Map();
    // Cross-launch co-occurrence tracking: walletA -> Map(walletB -> count)
    this.coOccurrenceRegistry = new Map();
    // Cache of known funding parents: walletPubkey -> funderPubkey
    this.funderCache = new Map();
    // In-flight funding lookup set to prevent duplicate RPC calls
    this.pendingFunderLookups = new Set();
  }

  /**
   * Initializes or gets the tracking bucket for a specific token mint
   */
  _getBucket(mint) {
    if (!this.tokenBuyers.has(mint)) {
      this.tokenBuyers.set(mint, {
        buyers: new Map(), // buyerPubkey -> { volumeSol, buyCount, firstSeen, lastSeen, slots: Set, amounts: [] }
        recentBuys: [],    // chronological list of buys for slot/timing correlation
        lastEval: null
      });
    }
    return this.tokenBuyers.get(mint);
  }

  /**
   * Records a live buy transaction from curveWatcher / onLogs
   */
  recordBuy(mint, buyerPubkey, solAmount, timestamp = Date.now(), slot = 0) {
    if (!mint || !buyerPubkey || solAmount <= 0) return;

    const bucket = this._getBucket(mint);
    const cleanAmount = typeof solAmount === 'number' ? solAmount : parseFloat(solAmount) || 0;

    let buyer = bucket.buyers.get(buyerPubkey);
    if (!buyer) {
      buyer = {
        pubkey: buyerPubkey,
        volumeSol: 0,
        buyCount: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        slots: new Set(),
        amounts: []
      };
      bucket.buyers.set(buyerPubkey, buyer);

      // Record cross-launch co-occurrence with already active buyers on this token
      for (const otherPubkey of bucket.buyers.keys()) {
        if (otherPubkey !== buyerPubkey) {
          this._recordCoOccurrence(buyerPubkey, otherPubkey);
        }
      }

      // Non-blocking background funder lookup
      this._scheduleFunderLookup(buyerPubkey);
    }

    buyer.volumeSol += cleanAmount;
    buyer.buyCount++;
    buyer.lastSeen = timestamp;
    if (slot > 0) buyer.slots.add(slot);
    buyer.amounts.push(cleanAmount);

    bucket.recentBuys.push({
      buyerPubkey,
      solAmount: cleanAmount,
      timestamp,
      slot
    });

    // Invalidate cached evaluation
    bucket.lastEval = null;
  }

  /**
   * Records that walletA and walletB were observed buying into the same token launch
   */
  _recordCoOccurrence(walletA, walletB) {
    if (walletA === walletB) return;
    if (!this.coOccurrenceRegistry.has(walletA)) {
      this.coOccurrenceRegistry.set(walletA, new Map());
    }
    const mapA = this.coOccurrenceRegistry.get(walletA);
    mapA.set(walletB, (mapA.get(walletB) || 0) + 1);

    if (!this.coOccurrenceRegistry.has(walletB)) {
      this.coOccurrenceRegistry.set(walletB, new Map());
    }
    const mapB = this.coOccurrenceRegistry.get(walletB);
    mapB.set(walletA, (mapB.get(walletA) || 0) + 1);
  }

  /**
   * Checks how many times walletA and walletB have historically co-occurred
   */
  _getCoOccurrenceCount(walletA, walletB) {
    const mapA = this.coOccurrenceRegistry.get(walletA);
    return mapA ? (mapA.get(walletB) || 0) : 0;
  }

  /**
   * Asynchronously look up parent funding wallet (SystemProgram.transfer)
   * Non-blocking and rate-limited.
   */
  async _scheduleFunderLookup(walletPubkey) {
    if (!this.connection || this.funderCache.has(walletPubkey) || this.pendingFunderLookups.has(walletPubkey)) {
      return;
    }

    if (this.pendingFunderLookups.size > 20) return; // RPC rate limit protection
    this.pendingFunderLookups.add(walletPubkey);

    try {
      // Query earliest signatures for the wallet to identify initial funding source
      const { PublicKey } = await import('@solana/web3.js');
      const pubkey = new PublicKey(walletPubkey);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 5 });
      
      if (sigs && sigs.length > 0) {
        // Earliest tx is at the end of the array
        const oldestSig = sigs[sigs.length - 1].signature;
        const tx = await this.connection.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0 });
        
        if (tx && tx.transaction && tx.transaction.message) {
          const instructions = tx.transaction.message.instructions || [];
          for (const ix of instructions) {
            if (ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer') {
              const source = ix.parsed.info?.source;
              if (source && source !== walletPubkey) {
                this.funderCache.set(walletPubkey, source);
                break;
              }
            }
          }
        }
      }
    } catch (e) {
      // Silently catch RPC lookup failures - heuristic will still use zero-delay signals
    } finally {
      this.pendingFunderLookups.delete(walletPubkey);
    }
  }

  /**
   * Evaluates buyer quality, collapsing clustered wallets into organic buyer count
   * and providing cleaned volume + risk assessment.
   */
  evaluateBuyerQuality(mint) {
    const bucket = this.tokenBuyers.get(mint);
    if (!bucket || bucket.buyers.size === 0) {
      return {
        rawBuyerCount: 0,
        organicBuyerCount: 0,
        clusterCount: 0,
        largestClusterSize: 0,
        largestClusterVolumeShare: 0,
        organicBuyVolumeSol: 0,
        totalBuyVolumeSol: 0,
        hhi: 0,
        qualityScore: 50,
        coordinationRisk: 'LOW',
        isHardVeto: false,
        reasons: ['No buyer data recorded']
      };
    }

    const buyersList = Array.from(bucket.buyers.values());
    const rawBuyerCount = buyersList.length;
    const totalBuyVolumeSol = buyersList.reduce((acc, b) => acc + b.volumeSol, 0);

    const dsu = new DisjointSet();
    const clusterEvidence = [];

    // 1. Same-Slot / Timing Synchronization Clustering
    // Check if pairs of buyers bought in the exact same slot with similar size (<20% std dev)
    const recentBuys = bucket.recentBuys;
    for (let i = 0; i < recentBuys.length; i++) {
      for (let j = i + 1; j < recentBuys.length; j++) {
        const b1 = recentBuys[i];
        const b2 = recentBuys[j];
        if (b1.buyerPubkey === b2.buyerPubkey) continue;

        // Same slot or within 400ms microsecond window
        const sameSlot = b1.slot > 0 && b1.slot === b2.slot;
        const sub400ms = Math.abs(b1.timestamp - b2.timestamp) <= 400;

        if (sameSlot || sub400ms) {
          const ratio = Math.max(b1.solAmount, b2.solAmount) / Math.max(0.0001, Math.min(b1.solAmount, b2.solAmount));
          // If similar trade sizes (within 25% of each other)
          if (ratio <= 1.25) {
            if (dsu.union(b1.buyerPubkey, b2.buyerPubkey)) {
              clusterEvidence.push(`Synchronized entry (${b1.buyerPubkey.slice(0, 4)}.. & ${b2.buyerPubkey.slice(0, 4)}.. in slot ${b1.slot || 'close-window'})`);
            }
          }
        }
      }
    }

    // 2. Common Funder Clustering
    for (let i = 0; i < buyersList.length; i++) {
      for (let j = i + 1; j < buyersList.length; j++) {
        const p1 = buyersList[i].pubkey;
        const p2 = buyersList[j].pubkey;
        const funder1 = this.funderCache.get(p1);
        const funder2 = this.funderCache.get(p2);

        if (funder1 && funder2 && funder1 === funder2) {
          if (dsu.union(p1, p2)) {
            clusterEvidence.push(`Shared funding source (${funder1.slice(0, 6)}..)`);
          }
        }
      }
    }

    // 3. Repeated Cross-Launch Co-Occurrence
    for (let i = 0; i < buyersList.length; i++) {
      for (let j = i + 1; j < buyersList.length; j++) {
        const p1 = buyersList[i].pubkey;
        const p2 = buyersList[j].pubkey;
        const count = this._getCoOccurrenceCount(p1, p2);
        if (count >= 2) {
          if (dsu.union(p1, p2)) {
            clusterEvidence.push(`Repeat cartel co-occurrence (${p1.slice(0, 4)}.. & ${p2.slice(0, 4)}.. in ${count} past tokens)`);
          }
        }
      }
    }

    // 4. Compile Cluster Groups
    const groups = new Map(); // rootKey -> [buyerPubkeys]
    for (const b of buyersList) {
      const root = dsu.find(b.pubkey);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(b);
    }

    let clusterCount = 0;
    let largestClusterSize = 1;
    let largestClusterVolume = 0;
    let washVolumeDiscountSol = 0;

    // Entities are either single independent buyers or multi-wallet clusters
    const entities = [];

    for (const [root, members] of groups.entries()) {
      const clusterVol = members.reduce((sum, m) => sum + m.volumeSol, 0);
      if (members.length > 1) {
        clusterCount++;
        if (members.length > largestClusterSize) {
          largestClusterSize = members.length;
          largestClusterVolume = clusterVol;
        }
        // If the cluster represents suspicious sybil activity (>= 3 wallets or > 40% volume share),
        // we discount 75% of its volume from the genuine organic buy volume
        if (members.length >= 3 || (totalBuyVolumeSol > 0 && (clusterVol / totalBuyVolumeSol) > 0.40)) {
          washVolumeDiscountSol += (clusterVol * 0.75);
        }
      }
      entities.push({
        root,
        size: members.length,
        volumeSol: clusterVol,
        members: members.map(m => m.pubkey)
      });
    }

    // Organic buyer count is the number of distinct entities
    const organicBuyerCount = entities.length;
    const largestClusterVolumeShare = totalBuyVolumeSol > 0 ? (largestClusterVolume / totalBuyVolumeSol) : 0;
    const organicBuyVolumeSol = Math.max(0.01, parseFloat((totalBuyVolumeSol - washVolumeDiscountSol).toFixed(3)));

    // 5. Herfindahl-Hirschman Index (HHI) for Volume Concentration
    let hhi = 0;
    if (totalBuyVolumeSol > 0) {
      for (const ent of entities) {
        const sharePercent = (ent.volumeSol / totalBuyVolumeSol) * 100;
        hhi += Math.pow(sharePercent, 2);
      }
      hhi = Math.round(hhi);
    }

    // 6. Risk Scoring & Classification
    let coordinationRisk = 'LOW';
    let qualityScore = 75;
    const reasons = [];

    if (largestClusterSize >= 5 || (largestClusterSize >= 3 && largestClusterVolumeShare > 0.50)) {
      coordinationRisk = 'CRITICAL';
      qualityScore = 15;
      reasons.push(`CRITICAL SYBIL CLUSTER: ${largestClusterSize} wallets control ${(largestClusterVolumeShare * 100).toFixed(0)}% of buy volume`);
    } else if (largestClusterSize >= 3 || largestClusterVolumeShare > 0.35 || hhi > 4000) {
      coordinationRisk = 'HIGH';
      qualityScore = 35;
      reasons.push(`HIGH COORDINATION: ${largestClusterSize}-wallet cluster detected (HHI: ${hhi})`);
    } else if (largestClusterSize >= 2 || hhi > 2500) {
      coordinationRisk = 'MEDIUM';
      qualityScore = 55;
      reasons.push(`MODERATE CLUSTER: ${largestClusterSize} wallets grouped into 1 entity`);
    } else {
      reasons.push(`Independent buyer distribution (${organicBuyerCount} organic buyers, HHI: ${hhi})`);
    }

    if (washVolumeDiscountSol > 0) {
      reasons.push(`Sybil wash discount: -${washVolumeDiscountSol.toFixed(2)} SOL removed`);
    }

    // Hard Veto: Dev/Cabal with extreme sybil control
    const isHardVeto = (coordinationRisk === 'CRITICAL' && largestClusterVolumeShare > 0.60);

    const result = {
      rawBuyerCount,
      organicBuyerCount,
      clusterCount,
      largestClusterSize,
      largestClusterVolumeShare: parseFloat(largestClusterVolumeShare.toFixed(3)),
      organicBuyVolumeSol,
      totalBuyVolumeSol: parseFloat(totalBuyVolumeSol.toFixed(3)),
      hhi,
      qualityScore,
      coordinationRisk,
      isHardVeto,
      reasons
    };

    bucket.lastEval = result;
    return result;
  }

  /**
   * Cleans up token data when rejected or closed
   */
  cleanupToken(mint) {
    this.tokenBuyers.delete(mint);
  }
}
