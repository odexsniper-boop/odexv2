export class ConfidenceScoreEngine {
    evaluate(state) {
        let score = 100;
        const evidence = [];
        
        // 1. Check Data Completeness in the main 15s/30s evaluation windows
        const checkWindow = (metrics, name) => {
            if (!metrics || !metrics['30s']) {
                score -= 10;
                evidence.push(`Missing ${name} window data`);
                return;
            }
            for (const key in metrics['30s']) {
                const feature = metrics['30s'][key];
                if (feature && feature.status === 'UNAVAILABLE') {
                    score -= 5;
                    evidence.push(`Unavailable feature: ${name}.${key}`);
                } else if (feature && feature.status === 'ESTIMATED') {
                    score -= 2;
                }
            }
        };

        checkWindow(state.moneyFlow, 'MoneyFlow');
        checkWindow(state.participation, 'Participation');
        checkWindow(state.priceMomentum, 'PriceMomentum');
        
        // 2. Coordination Confidence
        if (state.coordinationRisk && state.coordinationRisk['10s']) {
            if (state.coordinationRisk['10s'].confidence < 0.2) {
                score -= 5;
                evidence.push('Low confidence in coordination check');
            }
        }
        
        // 3. Stale State
        // In replay, we check the age of the state against the last event time implicitly by feature freshness.
        if (state.price && state.price.freshness > 15000) {
            score -= 10;
            evidence.push('Price data is stale (> 15s)');
        }
        
        if (score < 0) score = 0;
        
        return { confidenceScore: score, evidence };
    }
}
