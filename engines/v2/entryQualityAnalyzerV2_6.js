import { buildFeature } from './featureWrapperV2.js';

/**
 * Entry Quality Analyzer V2.6
 * 
 * Purpose: Forensic research engine to evaluate causal token-level organic demand,
 * buyer depth, flow persistence, and price/flow alignment at the exact decision timestamp.
 * 
 * Zero-Lookahead Compliant: Strict constraint t <= decision_time.
 */
export class EntryQualityAnalyzerV2_6 {
    constructor(config = {}) {
        this.windowSeconds = config.windowSeconds ?? 30;
    }

    /**
     * Compute organic demand features from causal token trade history.
     * @param {Array} tokenTrades Array of classified economic trades for THIS specific token up to currentTime
     * @param {number} currentTime Exact decision timestamp
     * @returns {Object} Organic demand features
     */
    analyze(tokenTrades, currentTime) {
        const threshold = currentTime - (this.windowSeconds * 1000);
        const windowTrades = tokenTrades.filter(t => t.event_time >= threshold && t.event_time <= currentTime);

        let buyVol = 0;
        let sellVol = 0;
        const buyers = new Map();
        const sellers = new Map();
        const tradeSizes = [];
        let repeatBuyersCount = 0;

        for (const t of windowTrades) {
            if (t.side === 'BUY') {
                buyVol += t.cleanSOLVolume;
                tradeSizes.push(t.cleanSOLVolume);
                const prev = buyers.get(t.initiator) || 0;
                if (prev > 0) repeatBuyersCount++;
                buyers.set(t.initiator, prev + t.cleanSOLVolume);
            } else if (t.side === 'SELL') {
                sellVol += t.cleanSOLVolume;
                sellers.set(t.initiator, (sellers.get(t.initiator) || 0) + t.cleanSOLVolume);
            }
        }

        const uBuyers = buyers.size;
        const uSellers = sellers.size;
        const netFlow = buyVol - sellVol;
        const netRatio = buyVol > 0 ? netFlow / buyVol : (sellVol > 0 ? -1.0 : 0.0);
        const buyerSellerRatio = uSellers > 0 ? uBuyers / uSellers : (uBuyers > 0 ? 5.0 : 0.0);

        // Concentration
        const sortedBuyVolumes = Array.from(buyers.values()).sort((a, b) => b - a);
        const top1Share = buyVol > 0 ? sortedBuyVolumes[0] / buyVol : 0;
        const top5Share = buyVol > 0 ? sortedBuyVolumes.slice(0, 5).reduce((s, v) => s + v, 0) / buyVol : 0;
        const top10Share = buyVol > 0 ? sortedBuyVolumes.slice(0, 10).reduce((s, v) => s + v, 0) / buyVol : 0;
        const hhi = buyVol > 0 ? sortedBuyVolumes.reduce((s, v) => s + Math.pow((v / buyVol) * 100, 2), 0) : 0;

        // Trade sizes
        tradeSizes.sort((a, b) => a - b);
        const medianTradeSize = tradeSizes.length > 0 
            ? (tradeSizes.length % 2 === 0 
                ? (tradeSizes[tradeSizes.length / 2 - 1] + tradeSizes[tradeSizes.length / 2]) / 2 
                : tradeSizes[Math.floor(tradeSizes.length / 2)]) 
            : 0;

        const meanTradeSize = tradeSizes.length > 0 ? buyVol / tradeSizes.length : 0;
        const sizeVariance = tradeSizes.length > 0 
            ? tradeSizes.reduce((sum, s) => sum + Math.pow(s - meanTradeSize, 2), 0) / tradeSizes.length 
            : 0;
        const sizeStdDev = Math.sqrt(sizeVariance);
        const sizeCv = meanTradeSize > 0 ? sizeStdDev / meanTradeSize : 0;

        // Lifetime metrics for context
        const allBuys = tokenTrades.filter(t => t.side === 'BUY');
        const allSells = tokenTrades.filter(t => t.side === 'SELL');
        const uBLife = new Set(allBuys.map(t => t.initiator)).size;
        const uSLife = new Set(allSells.map(t => t.initiator)).size;
        const buyVLife = allBuys.reduce((s, t) => s + t.cleanSOLVolume, 0);
        const sellVLife = allSells.reduce((s, t) => s + t.cleanSOLVolume, 0);

        const lastTrade = tokenTrades.length > 0 ? tokenTrades[tokenTrades.length - 1] : null;
        const firstTrade = tokenTrades.length > 0 ? tokenTrades[0] : null;
        const tokenAge = (lastTrade && firstTrade) ? (lastTrade.event_time - firstTrade.event_time) : 0;

        // Alignment check: Price up, buying volume dominant, trigger is buy
        const isPriceFlowAligned = lastTrade?.side === 'BUY' && netFlow > 0 && uBuyers >= 2;

        return {
            timestamp: currentTime,
            uniqueBuyers: uBuyers,
            uniqueSellers: uSellers,
            buyerSellerRatio,
            buyVolume: buyVol,
            sellVolume: sellVol,
            netFlow,
            netRatio,
            largestBuyerShare: top1Share,
            top5BuyerShare: top5Share,
            top10BuyerShare: top10Share,
            tradeFlowHerfindahlIndex: hhi,
            medianTradeSize,
            meanTradeSize,
            tradeSizeVariance: sizeVariance,
            tradeSizeCv: sizeCv,
            repeatBuyersCount,
            repeatBuyerRatio: uBuyers > 0 ? repeatBuyersCount / uBuyers : 0,
            tokenAgeSeconds: tokenAge,
            totalTrades: tokenTrades.length,
            lastTradeSide: lastTrade ? lastTrade.side : null,
            lastTradeVolume: lastTrade ? lastTrade.cleanSOLVolume : 0,
            lifetimeBuyers: uBLife,
            lifetimeSellers: uSLife,
            lifetimeBuyVolume: buyVLife,
            lifetimeSellVolume: sellVLife,
            lifetimeNetFlow: buyVLife - sellVLife,
            isPriceFlowAligned
        };
    }
}
