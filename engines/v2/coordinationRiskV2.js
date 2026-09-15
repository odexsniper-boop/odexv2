import { buildFeature } from './featureWrapperV2.js';

export class CoordinationRiskEngine {
    constructor(registry, windows = [1, 5, 10, 30, 60]) {
        this.registry = registry;
        this.windows = windows;
    }

    processEvents(events, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'BUY');
            
            let timing_sync_score = 0;
            let size_similarity_score = 0;
            let funding_link_score = 0;
            let cooccurrence_score = 0;
            let concentration_score = 0;
            let distribution_score = 0;
            let confidence = 0.0;
            const evidence = [];
            
            const uniqueWallets = new Set(windowEvents.map(e => e.initiator));
            
            if (uniqueWallets.size >= 3) {
                confidence = 0.5;
                
                // 1. Timing Sync Score (Same Slot / Microsecond Clustering)
                const slots = windowEvents.map(e => e.slot);
                const uniqueSlots = new Set(slots);
                if (uniqueSlots.size === 1) {
                    timing_sync_score = 50;
                    evidence.push('same_slot_cluster');
                    confidence += 0.3;
                } else if (uniqueSlots.size <= uniqueWallets.size / 2) {
                    timing_sync_score = 25;
                    evidence.push('high_slot_density');
                    confidence += 0.1;
                }
                
                // 2. Size Similarity Score (Variance analysis)
                const sizes = windowEvents.map(e => e.cleanSOLVolume);
                const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
                const variance = sizes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / sizes.length;
                const stdDev = Math.sqrt(variance);
                
                if (avg > 0 && (stdDev / avg) < 0.1) {
                    size_similarity_score = 40;
                    evidence.push('similar_trade_sizes');
                    confidence += 0.2;
                } else if (avg > 0 && (stdDev / avg) < 0.25) {
                    size_similarity_score = 20;
                    evidence.push('moderate_size_similarity');
                    confidence += 0.1;
                }
                
                // 3. Co-occurrence Score (Historical relationships from WalletRegistry)
                let coOccurredCount = 0;
                const initiators = Array.from(uniqueWallets);
                for (let i = 0; i < initiators.length; i++) {
                    const data = this.registry.wallets.get(initiators[i]);
                    if (data) {
                        for (let j = i + 1; j < initiators.length; j++) {
                            if (data.coOccurrences.has(initiators[j])) {
                                coOccurredCount++;
                            }
                        }
                    }
                }
                
                if (coOccurredCount > 0) {
                    cooccurrence_score = Math.min(50, coOccurredCount * 15);
                    evidence.push(`repeated_co_occurrence_${coOccurredCount}`);
                    confidence += 0.2;
                }
                
                // 4. Concentration Score (Top buyer share in window)
                const totalVol = sizes.reduce((a, b) => a + b, 0);
                const maxVol = Math.max(...sizes);
                if (totalVol > 0 && (maxVol / totalVol) > 0.6) {
                    concentration_score = 30;
                    evidence.push('high_window_concentration');
                }

                // Record co-occurrences for future blocks (1s / 5s windows)
                if (w <= 5) {
                    for (let i = 0; i < initiators.length; i++) {
                        for (let j = i + 1; j < initiators.length; j++) {
                            this.registry.recordCoOccurrence(initiators[i], initiators[j]);
                            this.registry.recordCoOccurrence(initiators[j], initiators[i]);
                        }
                    }
                }
            } else if (uniqueWallets.size > 0) {
                confidence = 0.2; 
            } else {
                confidence = 0.0;
            }

            // Check sell side in window for distribution_score
            const sellEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'SELL');
            if (sellEvents.length >= 2) {
                const sellSlots = sellEvents.map(e => e.slot);
                if (new Set(sellSlots).size === 1) {
                    distribution_score = 35;
                    evidence.push('synchronized_sell_distribution');
                }
            }

            // Calculate total composite COORDINATION_RISK:
            // Weighted blend of component signals
            const compositeRaw = (timing_sync_score * 0.40) + 
                                 (size_similarity_score * 0.30) + 
                                 (cooccurrence_score * 0.30) + 
                                 (concentration_score * 0.20) +
                                 (distribution_score * 0.20);
            const totalScore = Math.min(100, Math.round(compositeRaw));
            
            metrics[`${w}s`] = {
                coordinationRisk: buildFeature(totalScore, currentTime, 'CoordinationRisk', uniqueWallets.size > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                components: {
                    timing_sync_score,
                    size_similarity_score,
                    funding_link_score,
                    cooccurrence_score,
                    concentration_score,
                    distribution_score
                },
                evidence,
                confidence: Math.min(confidence, 1.0)
            };
        }
        
        return metrics;
    }
}
