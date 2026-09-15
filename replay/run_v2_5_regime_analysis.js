import fs from 'fs';
import crypto from 'crypto';
import { StrategyOrchestratorV2_4 } from 'file:///C:/Users/Other%20Stores/Desktop/Meme/ODEX%20V2/ko/engines/v2/strategyOrchestratorV2_4.js';
import { MarketRegimeAnalyzerV2_5, MarketRegimeLevel } from 'file:///C:/Users/Other%20Stores/Desktop/Meme/ODEX%20V2/ko/engines/v2/marketRegimeAnalyzerV2_5.js';
import { EconomicEventClassifier } from 'file:///C:/Users/Other%20Stores/Desktop/Meme/ODEX%20V2/ko/engines/v2/economicEventClassifierV2.js';

export function runRegimeAnalysis() {
    console.log('===============================================================');
    console.log('KO V3: V2.5 MARKET REGIME / LAUNCH QUALITY INVESTIGATION');
    console.log('DATASET: 35-TOKEN EXPANDED DEV SET (replay/raw_txs_expanded_35.json)');
    console.log('===============================================================\n');

    const devFile = 'replay/raw_txs_expanded_35.json';
    const devTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    devTxs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const uniqueMints = Array.from(new Set(devTxs.map(t => t.test_mint_context || t.token)));

    console.log(`Loaded ${devTxs.length} transactions across ${uniqueMints.length} development tokens.`);

    // 1. Resolve Bonding Curve PDAs and ATAs
    const curves = {};
    for (const m of uniqueMints) {
        const mintTxs = devTxs.filter(t => (t.test_mint_context || t.token) === m);
        const userCounts = {};
        const ataCounts = {};
        mintTxs.forEach(tx => {
            (tx.tokenTransfers || []).filter(t => t.mint === m).forEach(t => {
                if (t.fromUserAccount) userCounts[t.fromUserAccount] = (userCounts[t.fromUserAccount] || 0) + 1;
                if (t.toUserAccount) userCounts[t.toUserAccount] = (userCounts[t.toUserAccount] || 0) + 1;
                if (t.fromTokenAccount) ataCounts[t.fromTokenAccount] = (ataCounts[t.fromTokenAccount] || 0) + 1;
                if (t.toTokenAccount) ataCounts[t.toTokenAccount] = (ataCounts[t.toTokenAccount] || 0) + 1;
            });
        });
        const topUser = Object.entries(userCounts).sort((a, b) => b[1] - a[1])[0];
        const topAta = Object.entries(ataCounts).sort((a, b) => b[1] - a[1])[0];
        if (topUser && topAta) curves[m] = { pda: topUser[0], ata: topAta[0] };
    }

    // 2. Instrument Simulation with Real-Time Regime Tracking
    const classifier = new EconomicEventClassifier();
    const regimeAnalyzer = new MarketRegimeAnalyzerV2_5({
        rollingWindowSeconds: 1800,
        shortWindowSeconds: 300,
        minTokensForRegime: 2
    });

    const orch = new StrategyOrchestratorV2_4({
        standardSizeSol: 0.10,
        probeSizeSol: 0.025,
        enableReentryGuard: true,
        reentryConfig: {
            cooldownHardSafetySeconds: 60,
            cooldownFlowFailureSeconds: 30,
            cooldownBreakevenSeconds: 15,
            cooldownTrailingSeconds: 5,
            cooldownDefaultSeconds: 30,
            progressiveMultiplier: 1.5,
            requireThesisReset: true,
            minExitDebounceSeconds: 2
        },
        enableExposureManager: true,
        exposureConfig: {
            maxCumulativeExposureSol: 0.30,
            maxConsecutiveLosses: 2,
            maxLifetimeEntries: 3,
            maxCumulativeLossSol: 0.05
        }
    });

    const tradeTelemetry = [];
    let lookaheadViolations = 0;

    for (const tx of devTxs) {
        const m = tx.test_mint_context || tx.token;
        const curve = curves[m];
        if (!curve) continue;

        // Feed classified event into Regime Analyzer before/at transaction time
        const classified = classifier.classifyTransaction(tx, m, curve.pda, curve.ata);
        for (const e of classified) {
            if (e.classification === 'ECONOMIC_TRADE') {
                regimeAnalyzer.processEvent(e, m);
            }
        }

        // Process transaction in V2.4 Strategy Orchestrator
        const prevEntriesCount = orch.entryEvents.length;
        orch.processTransaction(tx, m, curve.pda, curve.ata);
        const newEntriesCount = orch.entryEvents.length;

        // If a new entry was made, snapshot both Token Quality and Market Regime simultaneously
        if (newEntriesCount > prevEntriesCount) {
            const entryEvent = orch.entryEvents[orch.entryEvents.length - 1];
            const currentTime = entryEvent.timestamp;

            // Strict zero-lookahead check
            if (tx.timestamp > currentTime) {
                lookaheadViolations++;
            }

            const regimeSnapshot = regimeAnalyzer.evaluateRegime(currentTime);

            tradeTelemetry.push({
                positionId: entryEvent.position_id,
                token: entryEvent.token,
                timestamp: currentTime,
                tier: entryEvent.tier,
                size: entryEvent.size,
                price: entryEvent.price,
                // Token Quality Metrics
                tokenOpportunity: entryEvent.opportunity,
                tokenConfidence: entryEvent.confidence,
                tokenReasons: entryEvent.reason_codes,
                // Market Regime Metrics (Macro Environment)
                marketRegime: regimeSnapshot.regime,
                regimeScore: regimeSnapshot.compositeScore,
                regimeNetFlowRatio: regimeSnapshot.metrics.netFlowRatio,
                regimePositiveBreadthPct: regimeSnapshot.metrics.positiveFlowBreadthPct,
                regimeBuyerSellerRatio: regimeSnapshot.metrics.buyerSellerRatio,
                regimeActiveTokens: regimeSnapshot.metrics.activeTokens
            });
        }
    }

    const entries = orch.entryEvents;
    const exits = orch.exitEvents;
    const positions = orch.positionEvents;

    // Join trade outcomes
    const completedTrades = tradeTelemetry.map(meta => {
        const exit = exits.find(x => x.position_id === meta.positionId);
        const pnlSol = exit ? exit.realized_pnl : 0;
        const pnlPct = exit ? exit.final_pnl_pct * 100 : 0;

        const posUpdates = positions.filter(p => p.position_id === meta.positionId);
        const lastPos = posUpdates.length > 0 ? posUpdates[posUpdates.length - 1] : null;

        const mfePct = lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0;
        const maePct = lastPos ? lastPos.mae.maxAdversePercent * 100 : 0;

        // Zero-lookahead verification on MAE/MFE
        if (lastPos && (lastPos.mae.timestamp > lastPos.timestamp || lastPos.mfe.timestamp > lastPos.timestamp)) {
            lookaheadViolations++;
        }

        return {
            ...meta,
            exitPrice: exit?.exit_price,
            exitTime: exit?.exit_timestamp,
            exitReason: exit?.exit_reason,
            holdTimeSeconds: exit && meta.timestamp ? (exit.exit_timestamp - meta.timestamp) : 0,
            pnlSol,
            pnlPct,
            mfePct,
            maePct
        };
    });

    console.log(`\nCompleted V2.4 execution on Dev 35: ${completedTrades.length} trades recorded.`);
    console.log(`Zero-lookahead violations: ${lookaheadViolations}\n`);

    // 3. Group Trades by Market Regime Bucket
    const buckets = {
        [MarketRegimeLevel.STRONG]: [],
        [MarketRegimeLevel.HEALTHY]: [],
        [MarketRegimeLevel.NEUTRAL]: [],
        [MarketRegimeLevel.WEAK]: [],
        [MarketRegimeLevel.HOSTILE]: []
    };

    completedTrades.forEach(t => {
        if (buckets[t.marketRegime]) {
            buckets[t.marketRegime].push(t);
        } else {
            buckets[MarketRegimeLevel.NEUTRAL].push(t);
        }
    });

    function summarizeBucket(name, list) {
        const total = list.length;
        const wins = list.filter(t => t.pnlSol > 0);
        const losses = list.filter(t => t.pnlSol <= 0);
        const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
        const netPnl = grossProfit - grossLoss;
        const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const expectancy = total > 0 ? netPnl / total : 0;
        const winRate = total > 0 ? (wins.length / total) * 100 : 0;
        const avgMfe = total > 0 ? list.reduce((s, t) => s + t.mfePct, 0) / total : 0;
        const avgMae = total > 0 ? list.reduce((s, t) => s + t.maePct, 0) / total : 0;
        const runners = list.filter(t => t.mfePct >= 25.0).length;
        const hardStops = list.filter(t => t.exitReason === 'HARD_SAFETY').length;
        const flowStops = list.filter(t => t.exitReason === 'FLOW_FAILURE').length;

        return {
            regime: name,
            totalTrades: total,
            wins: wins.length,
            losses: losses.length,
            winRate,
            grossProfit,
            grossLoss,
            netPnlSol: netPnl,
            profitFactor: pf,
            expectancySol: expectancy,
            avgMfePct: avgMfe,
            avgMaePct: avgMae,
            runnersCount: runners,
            hardStopsCount: hardStops,
            flowStopsCount: flowStops,
            trades: list
        };
    }

    const bucketSummaries = [
        summarizeBucket(MarketRegimeLevel.STRONG, buckets[MarketRegimeLevel.STRONG]),
        summarizeBucket(MarketRegimeLevel.HEALTHY, buckets[MarketRegimeLevel.HEALTHY]),
        summarizeBucket(MarketRegimeLevel.NEUTRAL, buckets[MarketRegimeLevel.NEUTRAL]),
        summarizeBucket(MarketRegimeLevel.WEAK, buckets[MarketRegimeLevel.WEAK]),
        summarizeBucket(MarketRegimeLevel.HOSTILE, buckets[MarketRegimeLevel.HOSTILE])
    ];

    console.log('=============================================================================================================');
    console.log('DEV 35 TRADES GROUPED BY OBSERVED MARKET REGIME:');
    console.log('Regime   | Trades | Win Rate | Gross Profit | Gross Loss | Net PnL (SOL) | PF    | Exp (SOL) | Avg MFE | Hard Stops');
    console.log('=============================================================================================================');
    bucketSummaries.forEach(b => {
        console.log(`${b.regime.padEnd(8)} | ${b.totalTrades.toString().padEnd(6)} | ${(b.winRate.toFixed(1)+'%').padEnd(8)} | ${('+'+b.grossProfit.toFixed(4)).padEnd(12)} | ${('-'+b.grossLoss.toFixed(4)).padEnd(10)} | ${(b.netPnlSol>=0?'+':'')+b.netPnlSol.toFixed(4).padEnd(13)} | ${b.profitFactor.toFixed(2).padEnd(5)} | ${(b.expectancySol>=0?'+':'')+b.expectancySol.toFixed(4).padEnd(9)} | ${(b.avgMfePct.toFixed(1)+'%').padEnd(7)} | ${b.hardStopsCount}`);
    });
    console.log('=============================================================================================================\n');

    // 4. Token Quality vs Market Regime Analysis
    // Cross-tabulate High Opportunity (>= 65) vs Low Opportunity (< 65) with Favorable Regime vs Unfavorable Regime
    const favorableRegimes = new Set([MarketRegimeLevel.STRONG, MarketRegimeLevel.HEALTHY]);
    const unfavorableRegimes = new Set([MarketRegimeLevel.NEUTRAL, MarketRegimeLevel.WEAK, MarketRegimeLevel.HOSTILE]);

    const highQualFavorable = completedTrades.filter(t => t.tokenOpportunity >= 60 && favorableRegimes.has(t.marketRegime));
    const highQualUnfavorable = completedTrades.filter(t => t.tokenOpportunity >= 60 && unfavorableRegimes.has(t.marketRegime));
    const lowQualFavorable = completedTrades.filter(t => t.tokenOpportunity < 60 && favorableRegimes.has(t.marketRegime));
    const lowQualUnfavorable = completedTrades.filter(t => t.tokenOpportunity < 60 && unfavorableRegimes.has(t.marketRegime));

    const quadrantSummary = [
        { quadrant: 'High Token Quality / Favorable Regime', ...summarizeBucket('HQ_FR', highQualFavorable) },
        { quadrant: 'High Token Quality / Unfavorable Regime', ...summarizeBucket('HQ_UR', highQualUnfavorable) },
        { quadrant: 'Low Token Quality / Favorable Regime', ...summarizeBucket('LQ_FR', lowQualFavorable) },
        { quadrant: 'Low Token Quality / Unfavorable Regime', ...summarizeBucket('LQ_UR', lowQualUnfavorable) }
    ];

    console.log('=============================================================================================================');
    console.log('DECOUPLING TOKEN QUALITY VS MARKET REGIME (QUADRANT ANALYSIS):');
    console.log('Quadrant                                  | Trades | Win Rate | Net PnL (SOL) | PF    | Exp (SOL) | Runners');
    console.log('=============================================================================================================');
    quadrantSummary.forEach(q => {
        console.log(`${q.quadrant.padEnd(41)} | ${q.totalTrades.toString().padEnd(6)} | ${(q.winRate.toFixed(1)+'%').padEnd(8)} | ${(q.netPnlSol>=0?'+':'')+q.netPnlSol.toFixed(4).padEnd(13)} | ${q.profitFactor.toFixed(2).padEnd(5)} | ${(q.expectancySol>=0?'+':'')+q.expectancySol.toFixed(4).padEnd(9)} | ${q.runnersCount}`);
    });
    console.log('=============================================================================================================\n');

    // 5. Ablation Testing on Dev Data
    // Test A: V2.4 Baseline (All 22 trades)
    // Test B: Filter out HOSTILE regime
    // Test C: Filter out HOSTILE and WEAK regimes
    // Test D: Require higher opportunity (>= 60) during NEUTRAL/WEAK/HOSTILE
    function runAblationVariant(name, filterFn) {
        const accepted = completedTrades.filter(filterFn);
        const total = accepted.length;
        const wins = accepted.filter(t => t.pnlSol > 0);
        const losses = accepted.filter(t => t.pnlSol <= 0);
        const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
        const netPnl = grossProfit - grossLoss;
        const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const expectancy = total > 0 ? netPnl / total : 0;
        const blocked = completedTrades.filter(t => !filterFn(t));
        const avoidedLoss = blocked.filter(t => t.pnlSol <= 0).reduce((s, t) => s + Math.abs(t.pnlSol), 0);
        const missedProfit = blocked.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);

        return {
            name,
            totalTrades: total,
            winRate: total > 0 ? (wins.length / total) * 100 : 0,
            grossProfit,
            grossLoss,
            netPnlSol: netPnl,
            profitFactor: pf,
            expectancySol: expectancy,
            blockedTradesCount: blocked.length,
            riskPreservedSol: avoidedLoss,
            missedProfitSol: missedProfit,
            netFilterAlphaSol: avoidedLoss - missedProfit
        };
    }

    const ablationResults = [
        runAblationVariant('A. V2.4 Frozen Baseline (No Filter)', () => true),
        runAblationVariant('B. Block HOSTILE Regime', t => t.marketRegime !== MarketRegimeLevel.HOSTILE),
        runAblationVariant('C. Block WEAK & HOSTILE Regimes', t => t.marketRegime !== MarketRegimeLevel.HOSTILE && t.marketRegime !== MarketRegimeLevel.WEAK),
        runAblationVariant('D. Dynamic Filter: Opp >= 60 in Unfavorable Regimes', t => {
            if (t.marketRegime === MarketRegimeLevel.STRONG || t.marketRegime === MarketRegimeLevel.HEALTHY) return true;
            return t.tokenOpportunity >= 60;
        })
    ];

    console.log('=============================================================================================================');
    console.log('V2.5 REGIME FILTER ABLATION RESULTS (DEV 35):');
    console.log('Configuration Variant                     | Trades | Win Rate | Net PnL (SOL) | PF    | Exp (SOL) | Risk Preserved | Missed Profit');
    console.log('=============================================================================================================');
    ablationResults.forEach(a => {
        console.log(`${a.name.padEnd(41)} | ${a.totalTrades.toString().padEnd(6)} | ${(a.winRate.toFixed(1)+'%').padEnd(8)} | ${(a.netPnlSol>=0?'+':'')+a.netPnlSol.toFixed(4).padEnd(13)} | ${a.profitFactor.toFixed(2).padEnd(5)} | ${(a.expectancySol>=0?'+':'')+a.expectancySol.toFixed(4).padEnd(9)} | ${(a.riskPreservedSol>=0?'+':'')+a.riskPreservedSol.toFixed(4).padEnd(14)} | ${('-'+a.missedProfitSol.toFixed(4))}`);
    });
    console.log('=============================================================================================================\n');

    // 6. Save JSON Data Files
    fs.writeFileSync('validation/v2/market_regime_features.json', JSON.stringify({
        meta: { dataset: devFile, generated_at: new Date().toISOString() },
        trade_features: completedTrades
    }, null, 2));
    console.log('Saved validation/v2/market_regime_features.json successfully.');

    fs.writeFileSync('validation/v2/market_regime_analysis.json', JSON.stringify({
        meta: { dataset: devFile, generated_at: new Date().toISOString() },
        bucket_summaries: bucketSummaries,
        quadrant_analysis: quadrantSummary,
        ablation_results: ablationResults
    }, null, 2));
    console.log('Saved validation/v2/market_regime_analysis.json successfully.');

    return {
        completedTrades,
        bucketSummaries,
        quadrantSummary,
        ablationResults,
        lookaheadViolations
    };
}

runRegimeAnalysis();
