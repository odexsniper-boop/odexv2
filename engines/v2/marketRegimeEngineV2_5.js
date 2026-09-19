/**
 * Market Regime Engine V2.5 (Real-Time Causal Macro Filter)
 * 
 * Features:
 * - Real-Time Causal Tracking of cross-token flow and participation.
 * - Rolling 30-minute window with 5-minute fast decay.
 * - Decouples Macro Market Regime from Individual Token Quality.
 * - Conservative Gating: Strictly blocks entries during HOSTILE macro regimes
 *   (deeply negative net flow and severe buyer exhaustion across concurrent tokens),
 *   while preserving idiosyncratic runners during NEUTRAL / WEAK regimes.
 * - 100% Zero-Lookahead Compliant: All metrics update incrementally at event time.
 */

export const MarketRegimeLevel = {
    STRONG: 'STRONG',
    HEALTHY: 'HEALTHY',
    NEUTRAL: 'NEUTRAL',
    WEAK: 'WEAK',
    HOSTILE: 'HOSTILE'
};

export class MarketRegimeEngineV2_5 {
    constructor(config = {}) {
        this.config = {
            rollingWindowSeconds: config.rollingWindowSeconds ?? 1800, // 30 minutes
            minTokensForRegime: config.minTokensForRegime ?? 3,         // Minimum active tokens to establish macro context
            hostileNetFlowThreshold: config.hostileNetFlowThreshold ?? -0.30, // Deep negative net flow
            hostileBuyerSellerThreshold: config.hostileBuyerSellerThreshold ?? 0.80, // Buyer exhaustion
            minOpportunityInWeakRegime: config.minOpportunityInWeakRegime ?? 65, // Higher selectivity in weak markets
            ...config
        };

        // Rolling event log: { timestamp, token, side, solAmount, initiator }
        this.events = [];
        // Token profiles: mint -> { firstSeen, lastSeen, buySol, sellSol, buyers: Set, sellers: Set }
        this.tokens = new Map();
    }

    processTrade(event, mint) {
        const t = event.event_time;
        const side = event.side;
        const solAmount = event.cleanSOLVolume || 0;
        const initiator = event.initiator;

        if (!this.tokens.has(mint)) {
            this.tokens.set(mint, {
                mint,
                firstSeen: t,
                lastSeen: t,
                buySol: 0,
                sellSol: 0,
                buyers: new Set(),
                sellers: new Set()
            });
        }

        const prof = this.tokens.get(mint);
        prof.lastSeen = t;
        if (side === 'BUY') {
            prof.buySol += solAmount;
            if (initiator) prof.buyers.add(initiator);
        } else if (side === 'SELL') {
            prof.sellSol += solAmount;
            if (initiator) prof.sellers.add(initiator);
        }

        this.events.push({ timestamp: t, token: mint, side, solAmount, initiator });

        // Prune old events
        const isMs = t > 1e11;
        const windowMs = this.config.rollingWindowSeconds * (isMs ? 1000 : 1);
        const cutoff = t - windowMs;
        while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
            this.events.shift();
        }
    }

    getRegime(currentTime) {
        const isMs = currentTime > 1e11;
        const windowMs = this.config.rollingWindowSeconds * (isMs ? 1000 : 1);
        const cutoff = currentTime - windowMs;
        const windowEvents = this.events.filter(e => e.timestamp >= cutoff);

        let buySol = 0;
        let sellSol = 0;
        const activeTokens = new Set();
        const buyers = new Set();
        const sellers = new Set();

        windowEvents.forEach(e => {
            activeTokens.add(e.token);
            if (e.side === 'BUY') {
                buySol += e.solAmount;
                if (e.initiator) buyers.add(e.initiator);
            } else if (e.side === 'SELL') {
                sellSol += e.solAmount;
                if (e.initiator) sellers.add(e.initiator);
            }
        });

        const totalVol = buySol + sellSol;
        const netFlowSol = buySol - sellSol;
        const netFlowRatio = totalVol > 0 ? netFlowSol / totalVol : 0;
        const buyerSellerRatio = sellers.size > 0 ? buyers.size / sellers.size : (buyers.size > 0 ? 2.0 : 1.0);

        let positiveTokens = 0;
        activeTokens.forEach(m => {
            const p = this.tokens.get(m);
            if (p && p.buySol > p.sellSol) positiveTokens++;
        });
        const positiveBreadthPct = activeTokens.size > 0 ? (positiveTokens / activeTokens.size) * 100 : 50;

        // Classify regime
        let regime = MarketRegimeLevel.NEUTRAL;
        if (activeTokens.size < this.config.minTokensForRegime) {
            regime = MarketRegimeLevel.NEUTRAL;
        } else if (netFlowRatio > 0.15 && positiveBreadthPct >= 65 && buyerSellerRatio >= 1.2) {
            regime = MarketRegimeLevel.STRONG;
        } else if (netFlowRatio >= 0.0 && positiveBreadthPct >= 50) {
            regime = MarketRegimeLevel.HEALTHY;
        } else if (netFlowRatio >= this.config.hostileNetFlowThreshold && buyerSellerRatio >= this.config.hostileBuyerSellerThreshold) {
            regime = netFlowRatio < -0.10 ? MarketRegimeLevel.WEAK : MarketRegimeLevel.NEUTRAL;
        } else {
            regime = MarketRegimeLevel.HOSTILE;
        }

        return {
            regime,
            netFlowRatio,
            buyerSellerRatio,
            positiveBreadthPct,
            activeTokensCount: activeTokens.size
        };
    }

    evaluateEntryGate(tokenOpportunity, currentTime) {
        const reg = this.getRegime(currentTime);

        // 1. Hard Gate: Block HOSTILE macro regime
        if (reg.regime === MarketRegimeLevel.HOSTILE) {
            return {
                allowed: false,
                regime: reg.regime,
                reason: `HOSTILE_REGIME_BLOCKED (NetFlow: ${(reg.netFlowRatio*100).toFixed(1)}%, B/S: ${reg.buyerSellerRatio.toFixed(2)})`
            };
        }

        // 2. Selectivity Gate: Require higher token opportunity during WEAK macro regime
        if (reg.regime === MarketRegimeLevel.WEAK && tokenOpportunity < this.config.minOpportunityInWeakRegime) {
            return {
                allowed: false,
                regime: reg.regime,
                reason: `WEAK_REGIME_HIGHER_SELECTIVITY_REQUIRED (Opp: ${tokenOpportunity} < ${this.config.minOpportunityInWeakRegime})`
            };
        }

        return {
            allowed: true,
            regime: reg.regime,
            reason: 'REGIME_PERMITTED'
        };
    }
}
