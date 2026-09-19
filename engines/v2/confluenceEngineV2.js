export class ConfluenceEngine {
    evaluate(state) {
        const mf = state.moneyFlow && state.moneyFlow['30s'] ? state.moneyFlow['30s'] : null;
        const part = state.participation && state.participation['30s'] ? state.participation['30s'] : null;
        const pm = state.priceMomentum && state.priceMomentum['30s'] ? state.priceMomentum['30s'] : null;
        const cr = state.coordinationRisk && state.coordinationRisk['10s'] ? state.coordinationRisk['10s'] : null;
        
        let flowOk = Boolean(mf && mf.netFlow?.value > 0);
        let partOk = Boolean(part && (part.uniqueBuyers?.value ?? 0) >= 3 && (part.tradeFlowHerfindahlIndex?.value ?? 0) < 5000);
        let momOk = Boolean(pm && pm.priceVelocity?.value > 0);
        let coordOk = Boolean(!cr || (cr.coordinationRisk?.value ?? 0) < 50);
        
        const okCount = [flowOk, partOk, momOk, coordOk].filter(Boolean).length;
        
        if (okCount === 4) return 'HIGH';
        if (okCount === 3) return 'MEDIUM';
        if (okCount >= 1) {
            // Check for explicit contradiction
            if (flowOk && !momOk) return 'CONFLICTING';
            if (!flowOk && momOk) return 'CONFLICTING';
            return 'LOW';
        }
        
        return 'NONE';
    }
}
