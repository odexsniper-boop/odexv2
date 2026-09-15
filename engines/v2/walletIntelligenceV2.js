import { buildFeature } from './featureWrapperV2.js';

export class WalletIntelligenceEngine {
    constructor(registry, windows = [1, 5, 10, 30, 60]) {
        this.registry = registry;
        this.windows = windows;
    }

    processEvents(events, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'BUY');
            
            let maxScore = 0;
            let combinedConfidence = 0;
            let allEvidence = new Set();
            
            for (const e of windowEvents) {
                const intel = this.registry.getWalletIntelligence(e.initiator);
                if (intel.score > maxScore) maxScore = intel.score;
                if (intel.confidence > combinedConfidence) combinedConfidence = intel.confidence;
                intel.evidence.forEach(ev => allEvidence.add(ev));
            }
            
            metrics[`${w}s`] = {
                smartMoneyScore: buildFeature(maxScore, currentTime, 'WalletIntelligence', windowEvents.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                evidence: Array.from(allEvidence),
                confidence: combinedConfidence
            };
        }
        
        return metrics;
    }
}
