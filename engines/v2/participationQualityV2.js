import { buildFeature } from './featureWrapperV2.js';

export class ParticipationQualityEngine {
    constructor(windows = [5, 10, 15, 30]) {
        this.windows = windows;
    }

    processEvents(events, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime);
            
            let totalCleanSol = 0;
            const buyerVolumes = new Map();
            const sellerVolumes = new Map();
            const tradeSizes = [];
            let repeatBuyersCount = 0;

            for (const e of windowEvents) {
                if (e.side === 'BUY') {
                    totalCleanSol += e.cleanSOLVolume;
                    tradeSizes.push(e.cleanSOLVolume);
                    const prev = buyerVolumes.get(e.initiator) || 0;
                    if (prev > 0 && e.cleanSOLVolume > 0) repeatBuyersCount++; 
                    buyerVolumes.set(e.initiator, prev + e.cleanSOLVolume);
                } else if (e.side === 'SELL') {
                    const prev = sellerVolumes.get(e.initiator) || 0;
                    sellerVolumes.set(e.initiator, prev + e.cleanSOLVolume);
                }
            }
            
            const uniqueBuyers = Array.from(buyerVolumes.keys());
            const uniqueSellers = Array.from(sellerVolumes.keys());
            
            const sortedBuyVolumes = Array.from(buyerVolumes.values()).sort((a, b) => b - a);
            
            let largestShare = 0;
            let top5Share = 0;
            let top10Share = 0;
            let hhi = 0;
            
            if (totalCleanSol > 0) {
                largestShare = sortedBuyVolumes[0] / totalCleanSol;
                top5Share = sortedBuyVolumes.slice(0, 5).reduce((sum, v) => sum + v, 0) / totalCleanSol;
                top10Share = sortedBuyVolumes.slice(0, 10).reduce((sum, v) => sum + v, 0) / totalCleanSol;
                hhi = sortedBuyVolumes.reduce((sum, v) => sum + Math.pow((v / totalCleanSol) * 100, 2), 0);
            }
            
            tradeSizes.sort((a, b) => a - b);
            const medianSize = tradeSizes.length > 0 
                ? (tradeSizes.length % 2 === 0 
                    ? (tradeSizes[tradeSizes.length / 2 - 1] + tradeSizes[tradeSizes.length / 2]) / 2 
                    : tradeSizes[Math.floor(tradeSizes.length / 2)]) 
                : 0;
                
            const repeatBuyerRatio = uniqueBuyers.length > 0 ? repeatBuyersCount / uniqueBuyers.length : 0;
            
            metrics[`${w}s`] = {
                uniqueBuyers: buildFeature(uniqueBuyers.length, currentTime, 'ParticipationQuality', 'AVAILABLE', currentTime),
                uniqueSellers: buildFeature(uniqueSellers.length, currentTime, 'ParticipationQuality', 'AVAILABLE', currentTime),
                medianTradeSize: buildFeature(medianSize, currentTime, 'ParticipationQuality', tradeSizes.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                largestBuyerShare: buildFeature(largestShare, currentTime, 'ParticipationQuality', totalCleanSol > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                top5BuyerShare: buildFeature(top5Share, currentTime, 'ParticipationQuality', totalCleanSol > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                top10BuyerShare: buildFeature(top10Share, currentTime, 'ParticipationQuality', totalCleanSol > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                tradeFlowHerfindahlIndex: buildFeature(hhi, currentTime, 'ParticipationQuality', totalCleanSol > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                repeatBuyerRatio: buildFeature(repeatBuyerRatio, currentTime, 'ParticipationQuality', uniqueBuyers.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime)
            };
        }
        
        return metrics;
    }
}
