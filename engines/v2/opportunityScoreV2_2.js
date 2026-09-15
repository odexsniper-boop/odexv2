/**
 * Opportunity Score Engine V2.2
 * 
 * Implements Dynamic Relative Flow Normalization:
 * - Replaces fixed absolute SOL flow checks with relative_flow_strength
 * - Flow intensity = cleanBuyVolume / currentLiquidity
 * - Contextually modulated by net-flow ratio, flow acceleration, and participant diversity
 * - Context-aware coordination dampening when organic demand is strong
 */

export class OpportunityScoreEngineV2_2 {
    evaluate(state) {
        let score = 50; // Neutral starting baseline
        const positiveEvidence = [];
        const negativeEvidence = [];

        const mf15 = state.moneyFlow?.['15s'];
        const mf30 = state.moneyFlow?.['30s'];
        const part30 = state.participation?.['30s'];
        const pm10 = state.priceMomentum?.['10s'];
        const pm30 = state.priceMomentum?.['30s'];
        const liq = state.liquidityMetrics;
        const crObj = state.coordinationRisk?.['10s'];
        const wi30 = state.walletIntelligence?.['30s'];
        const dr10 = state.distributionRisk?.['10s'];

        const currentLiquidity = Math.max(5.0, liq?.currentLiquidity?.value ?? 30.0);
        const buyVol30 = mf30?.buyVolume?.value ?? 0;
        const netFlow30 = mf30?.netFlow?.value ?? 0;
        const buyAccel = mf30?.buyVolumeAcceleration?.value ?? mf15?.buyVolumeAcceleration?.value ?? 0;
        const uniqueBuyers = part30?.uniqueBuyers?.value ?? 0;
        const hhi = part30?.tradeFlowHerfindahlIndex?.value ?? 0;

        // =========================================================================
        // 1. DYNAMIC RELATIVE FLOW EVALUATION
        // =========================================================================
        const flowIntensity = buyVol30 / currentLiquidity; // e.g. 0.45 SOL / 30 SOL = 0.015
        const netRatio = buyVol30 > 0 ? Math.max(0, Math.min(1.0, netFlow30 / buyVol30)) : 0;
        const accelMultiplier = 1.0 + Math.tanh(Math.max(0, buyAccel * 2));
        const diversityMultiplier = Math.min(1.5, Math.max(0.5, uniqueBuyers / 3.0));

        // Combined relative flow strength metric
        const relative_flow_strength = flowIntensity * netRatio * accelMultiplier * diversityMultiplier;

        // Flow Strength Points (0 to +20 points)
        if (relative_flow_strength >= 0.015) {
            score += 20;
            positiveEvidence.push(`strong_relative_flow_${relative_flow_strength.toFixed(3)}`);
        } else if (relative_flow_strength >= 0.005) {
            score += 10;
            positiveEvidence.push(`healthy_relative_flow_${relative_flow_strength.toFixed(3)}`);
        } else if (netFlow30 > 0) {
            score += 5;
            positiveEvidence.push('positive_net_flow');
        }

        // Dedicated Flow Acceleration Bonus (+0 to +10 points)
        if (buyAccel > 0.05) {
            score += 10;
            positiveEvidence.push('expanding_buy_acceleration');
        } else if (buyAccel > 0.01) {
            score += 5;
            positiveEvidence.push('positive_buy_acceleration');
        }

        // =========================================================================
        // 2. PARTICIPATION & CONCENTRATION
        // =========================================================================
        if (uniqueBuyers >= 5 && hhi < 3500) {
            score += 10;
            positiveEvidence.push('broad_unconcentrated_participation');
        } else if (uniqueBuyers >= 3) {
            score += 5;
        }

        if (hhi > 5000) {
            score -= 10;
            negativeEvidence.push('extreme_flow_concentration');
        }

        // =========================================================================
        // 3. MOMENTUM & TREND PERSISTENCE
        // =========================================================================
        const pVel30 = pm30?.priceVelocity?.value ?? 0;
        const pTrend30 = pm30?.trendPersistence?.value ?? 0;
        if (pVel30 > 0) {
            score += 10;
            positiveEvidence.push('positive_price_velocity');
            if (pTrend30 >= 0.70) {
                score += 5;
                positiveEvidence.push('strong_trend_persistence');
            }
        }

        // =========================================================================
        // 4. WALLET INTELLIGENCE (Supporting signal)
        // =========================================================================
        const smScore = wi30?.smartMoneyScore?.value ?? 0;
        if (smScore >= 30) {
            score += 10;
            positiveEvidence.push(`smart_money_active_${smScore}`);
        }

        // =========================================================================
        // 5. COORDINATION RISK (Context-Dampened Penalty)
        // =========================================================================
        const cr = crObj?.coordinationRisk?.value ?? 0;
        const level = crObj?.level ?? 'LOW';

        let baseCoordPenalty = 0;
        if (level === 'EXTREME') {
            baseCoordPenalty = 35;
        } else if (level === 'HIGH') {
            baseCoordPenalty = Math.floor(cr / 4); // Max ~18
        } else if (level === 'MEDIUM') {
            baseCoordPenalty = Math.floor(cr / 7); // Max ~7
        }

        // Contextual Dampener: If organic flow is healthy and buyers are diverse, halve penalty
        if (relative_flow_strength >= 0.010 && uniqueBuyers >= 4 && baseCoordPenalty > 0) {
            baseCoordPenalty = Math.floor(baseCoordPenalty * 0.50);
            positiveEvidence.push('coordination_penalty_dampened_by_organic_flow');
        }

        if (baseCoordPenalty > 0) {
            score -= baseCoordPenalty;
            negativeEvidence.push(`coordination_risk_penalty_${baseCoordPenalty}`);
        }

        // =========================================================================
        // 6. DISTRIBUTION & LIQUIDITY PENALTIES
        // =========================================================================
        const distRisk = dr10?.distributionRisk?.value ?? 0;
        if (distRisk >= 70) {
            score -= 25;
            negativeEvidence.push('severe_distribution_penalty');
        } else if (distRisk >= 40) {
            score -= 12;
            negativeEvidence.push('moderate_distribution_penalty');
        }

        const exitImpact = liq?.estimatedExitImpact?.value ?? 0;
        if (exitImpact > 0.12) {
            score -= 10;
            negativeEvidence.push('high_slippage_exit_impact');
        }

        // Clamp to 0 - 100
        score = Math.min(100, Math.max(0, score));

        return {
            opportunityScore: score,
            relative_flow_strength,
            positiveEvidence,
            negativeEvidence
        };
    }
}
