/**
 * Position Sizing Analyzer V2.7
 * 
 * Purpose: Forensic research engine to evaluate conviction-to-position-sizing mapping,
 * tier reliability, score vs realized reliability, catastrophic loss mitigation,
 * and multi-dimensional position allocation models (confidence, confluence, risk, conditional).
 * 
 * Zero-Lookahead Compliant: All sizing features use strictly t <= t_decision.
 */

export class PositionSizingAnalyzerV2_7 {
    constructor(config = {}) {
        this.config = {
            baseProbeSizeSol: config.baseProbeSizeSol ?? 0.025,
            standardSizeSol: config.standardSizeSol ?? 0.05,
            fullSizeSol: config.fullSizeSol ?? 0.075,
            ...config
        };
    }

    /**
     * Compute tier reliability metrics across trades.
     * @param {Array} trades Array of trades with tier, size, pnl, mae, mfe
     * @returns {Array} Tier reliability summary
     */
    computeTierReliability(trades) {
        const tiers = ['A+', 'A', 'B', 'C'];
        return tiers.map(t => {
            const trs = trades.filter(x => x.tier === t);
            const count = trs.length;
            if (count === 0) {
                return {
                    tier: t,
                    count: 0,
                    wins: 0,
                    losses: 0,
                    winRatePct: 0,
                    netPnlSol: 0,
                    expectancySol: 0,
                    profitFactor: 0,
                    avgWinnerSol: 0,
                    avgLoserSol: 0,
                    largestWinnerSol: 0,
                    largestLoserSol: 0,
                    avgMaePct: 0,
                    avgMfePct: 0,
                    pnlPerSolAllocated: 0,
                    pnlPerSolAtRisk: 0,
                    catastrophicLossRate: 0
                };
            }

            const wins = trs.filter(x => x.pnlSol > 0.0001);
            const losses = trs.filter(x => x.pnlSol <= 0.0001);
            const netPnlSol = trs.reduce((s, x) => s + x.pnlSol, 0);
            const grossWin = wins.reduce((s, x) => s + x.pnlSol, 0);
            const grossLoss = Math.abs(losses.reduce((s, x) => s + x.pnlSol, 0));
            const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

            const totalAllocated = trs.reduce((s, x) => s + x.sizeSol, 0);
            const totalAtRisk = trs.reduce((s, x) => s + (x.sizeSol * 0.20), 0); // Assuming 20% max hard loss
            const catLosses = trs.filter(x => x.pnlPct <= -20.0).length;

            const winPnls = wins.map(x => x.pnlSol);
            const lossPnls = losses.map(x => x.pnlSol);

            return {
                tier: t,
                count,
                wins: wins.length,
                losses: losses.length,
                winRatePct: (wins.length / count) * 100,
                netPnlSol,
                expectancySol: netPnlSol / count,
                profitFactor: pf,
                avgWinnerSol: wins.length > 0 ? grossWin / wins.length : 0,
                avgLoserSol: losses.length > 0 ? -grossLoss / losses.length : 0,
                largestWinnerSol: winPnls.length > 0 ? Math.max(...winPnls) : 0,
                largestLoserSol: lossPnls.length > 0 ? Math.min(...lossPnls) : 0,
                avgMaePct: trs.reduce((s, x) => s + x.maePct, 0) / count,
                avgMfePct: trs.reduce((s, x) => s + x.mfePct, 0) / count,
                pnlPerSolAllocated: totalAllocated > 0 ? netPnlSol / totalAllocated : 0,
                pnlPerSolAtRisk: totalAtRisk > 0 ? netPnlSol / totalAtRisk : 0,
                catastrophicLossRate: (catLosses / count) * 100
            };
        });
    }

    /**
     * Compute score reliability (Opportunity Score bucket vs realized metrics)
     * @param {Array} trades Array of trades
     * @returns {Array} Opportunity Score bucket metrics
     */
    computeScoreReliability(trades) {
        const buckets = [
            { name: 'High (80 - 100)', min: 80, max: 100 },
            { name: 'Medium-High (65 - 79)', min: 65, max: 79 },
            { name: 'Moderate (55 - 64)', min: 55, max: 64 },
            { name: 'Low (50 - 54)', min: 50, max: 54 }
        ];

        return buckets.map(b => {
            const trs = trades.filter(x => x.opportunity >= b.min && x.opportunity <= b.max);
            const count = trs.length;
            if (count === 0) return { bucket: b.name, count: 0 };

            const wins = trs.filter(x => x.pnlSol > 0.0001);
            const netPnlSol = trs.reduce((s, x) => s + x.pnlSol, 0);
            const grossWin = wins.reduce((s, x) => s + x.pnlSol, 0);
            const grossLoss = Math.abs(trs.filter(x => x.pnlSol <= 0.0001).reduce((s, x) => s + x.pnlSol, 0));
            const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

            return {
                bucket: b.name,
                count,
                winRatePct: (wins.length / count) * 100,
                netPnlSol,
                expectancySol: netPnlSol / count,
                profitFactor: pf,
                avgMaePct: trs.reduce((s, x) => s + x.maePct, 0) / count,
                avgMfePct: trs.reduce((s, x) => s + x.mfePct, 0) / count
            };
        });
    }

    /**
     * Allocate position size based on profile.
     * @param {string} profileName Name of the profile
     * @param {Object} context Context at t_decision (tier, opportunity, confidence, confluence, state)
     * @returns {number} Allocated size in SOL
     */
    allocateSize(profileName, context) {
        const { tier, opportunity, confidence, confluence, state } = context;

        switch (profileName) {
            case 'PROFILE_A_BASELINE':
                // Current V2.4 behavior
                return tier === 'C' ? 0.025 : 0.10;

            case 'PROFILE_B_FLAT_PROBE':
                // Flat 0.025 SOL probe size across all entries
                return 0.025;

            case 'PROFILE_C_TIER_SCALED_INVERTED':
                // Reward Tier C proven positive expectancy, restrain unproven high tiers
                if (tier === 'C') return 0.05;
                if (tier === 'A+') return 0.05;
                return 0.025; // Tier B & A

            case 'PROFILE_D_CONFIDENCE_ADJUSTED':
                // Scale by Data Completeness & Confidence Score
                if (confidence >= 85) return 0.05;
                if (confidence >= 70) return 0.025;
                return 0.015;

            case 'PROFILE_E_CONFLUENCE_ADJUSTED':
                // Scale by Multi-Engine Agreement
                if (confluence === 'HIGH') return 0.05;
                if (confluence === 'MEDIUM') return 0.035;
                return 0.025;

            case 'PROFILE_F_RISK_ADJUSTED': {
                // Modulated by Coordination Risk & Herfindahl Concentration
                const cr = state?.coordinationRisk?.['10s']?.coordinationRisk?.value ?? 0;
                const hhi = state?.participation?.['30s']?.tradeFlowHerfindahlIndex?.value ?? 0;
                if (cr > 30 || hhi > 4000) return 0.025; // Severe clustering/concentration penalty
                if (tier === 'C') return 0.035;
                return 0.05;
            }

            case 'PROFILE_G_CONDITIONAL_ALLOCATION': {
                // 4 Explicit Allocation States: PROBE, REDUCED, STANDARD, FULL
                // PROBE: 0.025 SOL (Default for Tier C or any setup with unconfirmed flow)
                // REDUCED: 0.035 SOL (Tier B or moderate confidence)
                // STANDARD: 0.05 SOL (High confluence + positive net flow)
                // FULL: 0.075 SOL (A+ with High Confluence, Conf >= 85, Positive Flow, Low Coordination)
                const netFlow = state?.moneyFlow?.['30s']?.netFlow?.value ?? 0;
                const crLevel = state?.coordinationRisk?.['10s']?.level ?? 'LOW';

                if (tier === 'C') return 0.025; // PROBE
                if (netFlow <= 0 || crLevel === 'HIGH' || crLevel === 'EXTREME') {
                    return 0.025; // Downgrade to PROBE if flow is negative or coordination high
                }
                if (tier === 'A+' && confluence === 'HIGH' && confidence >= 85 && crLevel === 'LOW') {
                    return 0.075; // FULL
                }
                if (confluence === 'HIGH' || confidence >= 80) {
                    return 0.05; // STANDARD
                }
                return 0.035; // REDUCED
            }

            default:
                return 0.025;
        }
    }
}
