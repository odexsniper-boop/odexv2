import { buildFeature } from './featureWrapperV2.js';

export class DistributionRiskEngine {
    constructor(registry, windows = [1, 5, 10, 30, 60]) {
        this.registry = registry;
        this.windows = windows;
    }

    processEvents(events, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'SELL');
            
            let score = 0;
            let confidence = 0.0;
            const evidence = [];
            
            const uniqueWallets = new Set(windowEvents.map(e => e.initiator));
            
            if (windowEvents.length > 0) {
                confidence = 0.3;
                
                const totalSellVolume = windowEvents.reduce((sum, e) => sum + e.cleanSOLVolume, 0);
                
                if (totalSellVolume > 5.0) {
                    score += 40;
                    evidence.push('large_volume_exit');
                    confidence += 0.2;
                }
                
                // Smart money selling
                let smartMoneySelling = false;
                for (const w of uniqueWallets) {
                    const intel = this.registry.getWalletIntelligence(w);
                    if (intel.score >= 50) {
                        smartMoneySelling = true;
                    }
                }
                if (smartMoneySelling) {
                    score += 30;
                    evidence.push('smart_money_distribution');
                    confidence += 0.2;
                }
                
                // Synchronized selling
                if (uniqueWallets.size >= 3) {
                    const slots = windowEvents.map(e => e.slot);
                    const uniqueSlots = new Set(slots);
                    if (uniqueSlots.size === 1) {
                        score += 50;
                        evidence.push('synchronized_selling');
                        confidence += 0.3;
                    }
                }
            }
            
            metrics[`${w}s`] = {
                distributionRisk: buildFeature(Math.min(score, 100), currentTime, 'DistributionRisk', windowEvents.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                evidence,
                confidence: Math.min(confidence, 1.0)
            };
        }
        
        return metrics;
    }
}
