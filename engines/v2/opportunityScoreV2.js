export class OpportunityScoreEngine {
    evaluate(state) {
        let score = 50; 
        const positive = [];
        const negative = [];
        
        const mf = state.moneyFlow && state.moneyFlow['30s'] ? state.moneyFlow['30s'] : null;
        const part = state.participation && state.participation['30s'] ? state.participation['30s'] : null;
        const pm = state.priceMomentum && state.priceMomentum['30s'] ? state.priceMomentum['30s'] : null;
        const wi = state.walletIntelligence && state.walletIntelligence['30s'] ? state.walletIntelligence['30s'] : null;
        const cr = state.coordinationRisk && state.coordinationRisk['10s'] ? state.coordinationRisk['10s'] : null;
        const dr = state.distributionRisk && state.distributionRisk['10s'] ? state.distributionRisk['10s'] : null;

        // --- Positive Components ---
        
        // 1. Economic Flow
        if (mf && mf.netFlow.value > 1.0) {
            score += 15;
            positive.push('strong_economic_flow');
        } else if (mf && mf.netFlow.value > 0) {
            score += 5;
        }
        
        // Flow Acceleration
        if (mf && mf.buyVolumeAcceleration.value > 0.1) {
            score += 10;
            positive.push('buy_flow_accelerating');
        }
        
        // 2. Participation
        if (part && part.uniqueBuyers.value >= 5) {
            score += 10;
            positive.push('broad_participation');
        }
        
        // 3. Momentum
        if (pm && pm.priceVelocity.value > 0) {
            score += 15;
            positive.push('positive_price_momentum');
            if (pm.trendPersistence.value > 0.7) {
                score += 5;
                positive.push('strong_trend_persistence');
            }
        }
        
        // 4. Wallet Quality (Supporting only)
        if (wi && wi.smartMoneyScore.value >= 50) {
            score += 10;
            positive.push('smart_money_active');
        }
        
        // --- Penalties ---
        
        // 1. Coordination Risk
        if (cr && cr.coordinationRisk.value > 0) {
            const penalty = Math.floor(cr.coordinationRisk.value / 2);
            score -= penalty;
            negative.push(`coordination_risk_penalty_${penalty}`);
        }
        
        // 2. Distribution Risk
        if (dr && dr.distributionRisk.value > 0) {
            const penalty = Math.floor(dr.distributionRisk.value);
            score -= penalty;
            negative.push(`distribution_risk_penalty_${penalty}`);
        }
        
        // 3. Concentration Risk
        if (part && part.tradeFlowHerfindahlIndex.value > 5000) { // Highly concentrated
            score -= 15;
            negative.push('high_flow_concentration');
        }
        
        // 4. Slippage/Liquidity Exit Impact
        if (state.liquidityMetrics && state.liquidityMetrics.estimatedExitImpact && state.liquidityMetrics.estimatedExitImpact.value > 0.1) {
            score -= 10; // >10% exit impact for 1 SOL is poor liquidity
            negative.push('poor_liquidity_exit_impact');
        }
        
        // Clamp 0-100
        if (score > 100) score = 100;
        if (score < 0) score = 0;
        
        return { opportunityScore: score, positiveEvidence: positive, negativeEvidence: negative };
    }
}
