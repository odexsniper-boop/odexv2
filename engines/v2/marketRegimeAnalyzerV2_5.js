/**
 * Market Regime Analyzer V2.5 (Research / Forensic Diagnostic Module)
 * 
 * Objectives:
 * - Quantify broad market conditions and launch environments in real-time.
 * - Decouple Token Quality (individual token metrics) from Market Regime (surrounding macro/launch climate).
 * - Maintain strict zero-lookahead: At time T, only information occurring at or before T is used.
 * - Compute rolling cross-token metrics across Flow, Participation, Momentum, and Liquidity.
 * - Categorize market environment into: STRONG, HEALTHY, NEUTRAL, WEAK, HOSTILE.
 */

export const MarketRegimeLevel = {
    STRONG: 'STRONG',
    HEALTHY: 'HEALTHY',
    NEUTRAL: 'NEUTRAL',
    WEAK: 'WEAK',
    HOSTILE: 'HOSTILE'
};

export class MarketRegimeAnalyzerV2_5 {
    constructor(config = {}) {
        this.config = {
            rollingWindowSeconds: config.rollingWindowSeconds ?? 1800, // 30 minutes rolling history
            shortWindowSeconds: config.shortWindowSeconds ?? 300,       // 5 minutes short burst
            minTokensForRegime: config.minTokensForRegime ?? 3,         // Minimum active tokens to establish cross-token regime
            ...config
        };

        // Rolling event log across all tokens: { timestamp, token, side, solAmount, isNewToken }
        this.eventHistory = [];
        
        // Per-token rolling tracking: mint -> { firstSeen, lastSeen, totalBuySol, totalSellSol, uniqueBuyers: Set, uniqueSellers: Set, peakPrice, startPrice }
        this.tokenProfiles = new Map();

        // Closed token performance tracker (causal rolling record of past completed tokens)
        this.recentTokenOutcomes = [];
    }

    /**
     * Process an incoming classified economic trade event to update broad market regime.
     * ZERO-LOOKAHEAD: Uses only event.event_time and past events.
     */
    processEvent(event, mint) {
        const t = event.event_time;
        const side = event.side; // 'BUY' | 'SELL'
        const solAmount = event.cleanSOLVolume || 0;
        const initiator = event.initiator;

        // 1. Update Token Profile
        if (!this.tokenProfiles.has(mint)) {
            this.tokenProfiles.set(mint, {
                mint,
                firstSeen: t,
                lastSeen: t,
                totalBuySol: 0,
                totalSellSol: 0,
                buyers: new Set(),
                sellers: new Set(),
                tradeCount: 0,
                startPrice: event.effectivePrice || 0,
                peakPrice: event.effectivePrice || 0,
                currentPrice: event.effectivePrice || 0,
                mfePct: 0
            });
        }

        const profile = this.tokenProfiles.get(mint);
        profile.lastSeen = t;
        profile.tradeCount++;
        profile.currentPrice = event.effectivePrice || profile.currentPrice;
        if (profile.currentPrice > profile.peakPrice) {
            profile.peakPrice = profile.currentPrice;
        }
        if (profile.startPrice > 0) {
            profile.mfePct = Math.max(profile.mfePct, ((profile.peakPrice - profile.startPrice) / profile.startPrice) * 100);
        }

        if (side === 'BUY') {
            profile.totalBuySol += solAmount;
            if (initiator) profile.buyers.add(initiator);
        } else if (side === 'SELL') {
            profile.totalSellSol += solAmount;
            if (initiator) profile.sellers.add(initiator);
        }

        // 2. Append to rolling event log
        this.eventHistory.push({
            timestamp: t,
            token: mint,
            side,
            solAmount,
            initiator
        });

        // 3. Prune events outside rolling window
        const cutoff = t - this.config.rollingWindowSeconds;
        while (this.eventHistory.length > 0 && this.eventHistory[0].timestamp < cutoff) {
            this.eventHistory.shift();
        }
    }

    /**
     * Evaluate the current market regime at timestamp currentTime.
     * Purely causal.
     */
    evaluateRegime(currentTime) {
        const windowEvents = this.eventHistory.filter(e => e.timestamp >= (currentTime - this.config.rollingWindowSeconds));
        const shortEvents = this.eventHistory.filter(e => e.timestamp >= (currentTime - this.config.shortWindowSeconds));

        // 1. Aggregate Flow Metrics
        let rollingBuySol = 0;
        let rollingSellSol = 0;
        const activeTokensInWindow = new Set();
        const buyersInWindow = new Set();
        const sellersInWindow = new Set();

        windowEvents.forEach(e => {
            activeTokensInWindow.add(e.token);
            if (e.side === 'BUY') {
                rollingBuySol += e.solAmount;
                if (e.initiator) buyersInWindow.add(e.initiator);
            } else if (e.side === 'SELL') {
                rollingSellSol += e.solAmount;
                if (e.initiator) sellersInWindow.add(e.initiator);
            }
        });

        const totalSolVolume = rollingBuySol + rollingSellSol;
        const netFlowSol = rollingBuySol - rollingSellSol;
        const netFlowRatio = totalSolVolume > 0 ? netFlowSol / totalSolVolume : 0;

        // Short burst flow (last 5 min)
        let shortBuySol = 0;
        let shortSellSol = 0;
        shortEvents.forEach(e => {
            if (e.side === 'BUY') shortBuySol += e.solAmount;
            else if (e.side === 'SELL') shortSellSol += e.solAmount;
        });
        const shortNetFlowRatio = (shortBuySol + shortSellSol) > 0 ? (shortBuySol - shortSellSol) / (shortBuySol + shortSellSol) : 0;

        // 2. Token Breadth & Launch Quality
        let positiveFlowTokens = 0;
        let negativeFlowTokens = 0;
        let tokensWithSubstantialBuyers = 0;
        let tokensWithExcursion15 = 0;

        activeTokensInWindow.forEach(m => {
            const p = this.tokenProfiles.get(m);
            if (!p) return;
            if (p.totalBuySol > p.totalSellSol) positiveFlowTokens++;
            else negativeFlowTokens++;

            if (p.buyers.size >= 5) tokensWithSubstantialBuyers++;
            if (p.mfePct >= 15.0) tokensWithExcursion15++;
        });

        const totalActiveTokens = activeTokensInWindow.size;
        const positiveFlowBreadthPct = totalActiveTokens > 0 ? (positiveFlowTokens / totalActiveTokens) * 100 : 50;
        const runnerBreadthPct = totalActiveTokens > 0 ? (tokensWithExcursion15 / totalActiveTokens) * 100 : 0;

        // 3. Participation Quality
        const buyerSellerRatio = sellersInWindow.size > 0 ? buyersInWindow.size / sellersInWindow.size : (buyersInWindow.size > 0 ? 2.0 : 1.0);
        const avgBuyersPerToken = totalActiveTokens > 0 ? buyersInWindow.size / totalActiveTokens : 0;

        // 4. Composite Regime Scoring (0 - 100)
        // Score = 40% Net Flow Breadth + 30% Net Flow Ratio + 20% Buyer/Seller Ratio + 10% Runner Breadth
        let flowScore = Math.min(100, Math.max(0, (netFlowRatio + 0.5) * 100));
        let breadthScore = positiveFlowBreadthPct;
        let participationScore = Math.min(100, Math.max(0, (buyerSellerRatio / 2.0) * 100));
        let runnerScore = Math.min(100, runnerBreadthPct * 3);

        let compositeScore = Math.round(
            (flowScore * 0.35) +
            (breadthScore * 0.35) +
            (participationScore * 0.20) +
            (runnerScore * 0.10)
        );

        // Classify into Regime Bucket
        let regime = MarketRegimeLevel.NEUTRAL;
        if (totalActiveTokens < this.config.minTokensForRegime) {
            regime = MarketRegimeLevel.NEUTRAL; // Insufficient tokens to claim a macro regime
        } else if (compositeScore >= 75 && netFlowRatio > 0.15 && positiveFlowBreadthPct >= 65) {
            regime = MarketRegimeLevel.STRONG;
        } else if (compositeScore >= 55 && netFlowRatio >= 0.0) {
            regime = MarketRegimeLevel.HEALTHY;
        } else if (compositeScore >= 40 && netFlowRatio >= -0.15) {
            regime = MarketRegimeLevel.NEUTRAL;
        } else if (compositeScore >= 25 || netFlowRatio >= -0.35) {
            regime = MarketRegimeLevel.WEAK;
        } else {
            regime = MarketRegimeLevel.HOSTILE;
        }

        return {
            timestamp: currentTime,
            regime,
            compositeScore,
            metrics: {
                activeTokens: totalActiveTokens,
                totalVolumeSol: totalSolVolume,
                netFlowSol,
                netFlowRatio,
                shortNetFlowRatio,
                positiveFlowBreadthPct,
                runnerBreadthPct,
                uniqueBuyers: buyersInWindow.size,
                uniqueSellers: sellersInWindow.size,
                buyerSellerRatio,
                avgBuyersPerToken
            }
        };
    }
}
