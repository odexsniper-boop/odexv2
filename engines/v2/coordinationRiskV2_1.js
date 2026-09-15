import { buildFeature } from './featureWrapperV2.js';

/**
 * Coordination Risk Engine V2.1
 * 
 * Context-Aware Coordination Architecture:
 * - Decomposed into 6 explicit components
 * - Timing sync capped so opening-block snipers alone cannot trigger extreme risk
 * - Context dampener active when broad participation, flow acceleration, or smart money is present
 * - Classified into LOW, MEDIUM, HIGH, EXTREME
 */

export class CoordinationRiskEngineV2_1 {
    constructor(registry, windows = [1, 5, 10, 30, 60]) {
        this.registry = registry;
        this.windows = windows;
    }

    processEvents(events, currentTime, context = {}) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'BUY');
            
            let timing_sync = 0;
            let size_similarity = 0;
            let cooccurrence = 0;
            let concentration = 0;
            let distribution = 0;
            let confidence = 0.0;
            const evidence = [];
            
            const uniqueWallets = new Set(windowEvents.map(e => e.initiator));
            
            if (uniqueWallets.size >= 3) {
                confidence = 0.5;
                
                // 1. Timing Sync (Capped weight: same-slot sniper presence is evidence, not proof)
                const slots = windowEvents.map(e => e.slot);
                const uniqueSlots = new Set(slots);
                if (uniqueSlots.size === 1) {
                    timing_sync = 40; // Reduced from 50
                    evidence.push('same_slot_clustering');
                    confidence += 0.2;
                } else if (uniqueSlots.size <= uniqueWallets.size / 2) {
                    timing_sync = 20;
                    evidence.push('dense_slot_activity');
                    confidence += 0.1;
                }
                
                // 2. Size Similarity (High suspicion only if standard deviation < 10% of mean)
                const sizes = windowEvents.map(e => e.cleanSOLVolume);
                const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
                const variance = sizes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / sizes.length;
                const stdDev = Math.sqrt(variance);
                
                if (avg > 0 && (stdDev / avg) < 0.10) {
                    size_similarity = 40;
                    evidence.push('identical_trade_sizes');
                    confidence += 0.2;
                } else if (avg > 0 && (stdDev / avg) < 0.25) {
                    size_similarity = 20;
                    evidence.push('similar_trade_sizes');
                    confidence += 0.1;
                }
                
                // 3. Historical Co-occurrence across launches
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
                    cooccurrence = Math.min(50, coOccurredCount * 15);
                    evidence.push(`repeated_co_occurrence_${coOccurredCount}`);
                    confidence += 0.2;
                }
                
                // 4. Concentration (Dominant wallet share)
                const totalVol = sizes.reduce((a, b) => a + b, 0);
                const maxVol = Math.max(...sizes);
                if (totalVol > 0 && (maxVol / totalVol) > 0.60) {
                    concentration = 35;
                    evidence.push('high_buyer_concentration');
                }

                // Record co-occurrences for future blocks
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
            }

            // 5. Sell-side Distribution
            const sellEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.side === 'SELL');
            if (sellEvents.length >= 2) {
                const sellSlots = sellEvents.map(e => e.slot);
                if (new Set(sellSlots).size === 1) {
                    distribution = 35;
                    evidence.push('synchronized_sell_distribution');
                }
            }

            // Raw Composite Coordination Score
            let rawScore = (timing_sync * 0.25) + 
                           (size_similarity * 0.25) + 
                           (cooccurrence * 0.25) + 
                           (concentration * 0.15) + 
                           (distribution * 0.10);

            // 6. Context-Aware Dampener:
            // If broad participation, accelerating flow, or smart money is present, damp clustering suspicion
            let dampFactor = 1.0;
            if (uniqueWallets.size >= 5) {
                dampFactor *= 0.70; // 30% reduction for organic crowd
                evidence.push('dampened_by_broad_crowd');
            }
            if (context.buyAcceleration && context.buyAcceleration > 0) {
                dampFactor *= 0.80; // 20% reduction for accelerating flow
                evidence.push('dampened_by_flow_acceleration');
            }
            if (context.smartMoneyScore && context.smartMoneyScore >= 30) {
                dampFactor *= 0.70; // 30% reduction for smart money alignment
                evidence.push('dampened_by_smart_money');
            }

            const finalScore = Math.min(100, Math.round(rawScore * dampFactor));

            // Level Classification: LOW, MEDIUM, HIGH, EXTREME
            let level = 'LOW';
            if (finalScore >= 75) {
                // EXTREME requires at least 3 active component signals
                const activeSignals = [timing_sync > 0, size_similarity > 0, cooccurrence > 0, concentration > 0, distribution > 0].filter(Boolean).length;
                level = (activeSignals >= 3) ? 'EXTREME' : 'HIGH';
            } else if (finalScore >= 50) {
                level = 'HIGH';
            } else if (finalScore >= 25) {
                level = 'MEDIUM';
            } else {
                level = 'LOW';
            }

            metrics[`${w}s`] = {
                coordinationRisk: buildFeature(finalScore, currentTime, 'CoordinationRiskV2_1', uniqueWallets.size > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                level,
                components: {
                    timing_sync,
                    size_similarity,
                    cooccurrence,
                    concentration,
                    distribution,
                    dampFactor
                },
                evidence,
                confidence: Math.min(confidence, 1.0)
            };
        }
        
        return metrics;
    }
}
