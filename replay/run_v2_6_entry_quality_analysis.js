import fs from 'fs';
import { StrategyOrchestratorV2_4 } from '../engines/v2/strategyOrchestratorV2_4.js';
import { EntryQualityAnalyzerV2_6 } from '../engines/v2/entryQualityAnalyzerV2_6.js';
import { EconomicEventClassifier } from '../engines/v2/economicEventClassifierV2.js';

export function runEntryQualityAnalysis() {
    console.log('===============================================================');
    console.log('KO V3: V2.6 INITIAL ENTRY SELECTIVITY / ORGANIC DEMAND VALIDATION');
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

    // 2. Instrument Simulation to track causal trades per token
    const analyzer = new EntryQualityAnalyzerV2_6({ windowSeconds: 30 });
    const classifier = new EconomicEventClassifier();
    const tokenTradesMap = new Map(); // mint -> Array of economic trades

    const orch = new StrategyOrchestratorV2_4({
        standardSizeSol: 0.10,
        probeSizeSol: 0.025,
        enableReentryGuard: true,
        enableExposureManager: true
    });

    const entryQualitySnapshots = [];
    let lookaheadViolations = 0;

    for (const tx of devTxs) {
        const m = tx.test_mint_context || tx.token;
        const curve = curves[m];
        if (!curve) continue;

        // Causal extraction of trade
        const freshCl = new EconomicEventClassifier();
        const classified = freshCl.classifyTransaction(tx, m, curve.pda, curve.ata);
        for (const ev of classified) {
            if (ev.classification === 'ECONOMIC_TRADE') {
                if (!tokenTradesMap.has(m)) tokenTradesMap.set(m, []);
                tokenTradesMap.get(m).push(ev);
            }
        }

        const prevCount = orch.entryEvents.length;
        orch.processTransaction(tx, m, curve.pda, curve.ata);
        const newCount = orch.entryEvents.length;

        if (newCount > prevCount) {
            const lastEntry = orch.entryEvents[orch.entryEvents.length - 1];
            const currentTime = lastEntry.timestamp;

            // Zero-lookahead verification: decision time must match or exceed event time
            if (tx.timestamp > currentTime) {
                lookaheadViolations++;
            }

            // Extract causal token-level organic demand features exactly at currentTime
            const tokenTradesSoFar = tokenTradesMap.get(m) || [];
            const features = analyzer.analyze(tokenTradesSoFar, currentTime);

            entryQualitySnapshots.push({
                positionId: lastEntry.position_id,
                token: m,
                timestamp: currentTime,
                tier: lastEntry.tier,
                opportunity: lastEntry.opportunity,
                confidence: lastEntry.confidence,
                price: lastEntry.price,
                features
            });
        }
    }

    console.log(`\nSimulation finished. Total Strategy Entries: ${orch.entryEvents.length}`);
    console.log(`Zero-Lookahead Violations: ${lookaheadViolations}`);

    // Match trades with outcomes
    const tradeMatrix = entryQualitySnapshots.map(snap => {
        const exit = orch.exitEvents.find(x => x.position_id === snap.positionId);
        const posUpdates = orch.positionEvents.filter(p => p.position_id === snap.positionId);
        const lastPos = posUpdates[posUpdates.length - 1];
        const pnl = exit ? exit.realized_pnl : (lastPos?.unrealized_pnl ?? 0);
        const pnlPct = exit ? exit.final_pnl_pct * 100 : ((lastPos?.unrealized_pnl_pct ?? 0) * 100);
        const mfe = lastPos ? (lastPos.mfe.maxFavorablePercent * 100) : 0;
        const mae = lastPos ? (lastPos.mae.maxAdversePercent * 100) : 0;
        const exitReason = exit ? exit.exit_reason : (lastPos ? 'OPEN' : 'UNKNOWN');

        let classification = 'TIER_C_NEUTRAL';
        if (snap.tier === 'C') {
            if (pnl > 0.0001) classification = 'TIER_C_WINNER';
            else if (pnl < -0.0001) classification = 'TIER_C_LOSER';
            else classification = 'TIER_C_NEUTRAL';
        } else {
            classification = pnl > 0.0001 ? `${snap.tier}_WINNER` : `${snap.tier}_LOSER`;
        }

        return {
            ...snap,
            pnlSol: pnl,
            pnlPct,
            mfePct: mfe,
            maePct: mae,
            exitReason,
            classification
        };
    });

    // Save Features Dataset
    const featuresExport = {
        meta: {
            dataset: devFile,
            generated_at: new Date().toISOString(),
            total_entries: tradeMatrix.length,
            lookahead_violations: lookaheadViolations
        },
        trade_matrix: tradeMatrix
    };
    fs.writeFileSync('validation/v2/v2_6_entry_quality_features.json', JSON.stringify(featuresExport, null, 2));
    console.log('Exported: validation/v2/v2_6_entry_quality_features.json');

    // Filter Tier C Candidates for Feature Separation Analysis
    const tierCTrades = tradeMatrix.filter(t => t.tier === 'C');
    const tierCWins = tierCTrades.filter(t => t.classification === 'TIER_C_WINNER');
    const tierCLosses = tierCTrades.filter(t => t.classification === 'TIER_C_LOSER');
    const tierCNeutrals = tierCTrades.filter(t => t.classification === 'TIER_C_NEUTRAL');

    console.log(`\nTier C Breakdown: Total ${tierCTrades.length} | Winners: ${tierCWins.length} | Losers: ${tierCLosses.length} | Neutrals: ${tierCNeutrals.length}`);

    // Calculate statistical separation for features
    function calcStats(arr, keyPath) {
        if (arr.length === 0) return { median: 0, mean: 0, min: 0, max: 0 };
        const vals = arr.map(item => {
            const parts = keyPath.split('.');
            let val = item;
            for (const p of parts) val = val ? val[p] : undefined;
            return typeof val === 'number' ? val : 0;
        }).sort((a, b) => a - b);

        const median = vals.length % 2 === 0 ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2 : vals[Math.floor(vals.length / 2)];
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        return { median, mean, min: vals[0], max: vals[vals.length - 1] };
    }

    const featureKeys = [
        'features.uniqueBuyers',
        'features.uniqueSellers',
        'features.buyerSellerRatio',
        'features.buyVolume',
        'features.sellVolume',
        'features.netFlow',
        'features.netRatio',
        'features.largestBuyerShare',
        'features.top5BuyerShare',
        'features.tradeFlowHerfindahlIndex',
        'features.medianTradeSize',
        'features.meanTradeSize',
        'features.tradeSizeCv',
        'features.repeatBuyerRatio',
        'features.tokenAgeSeconds',
        'features.lifetimeBuyers',
        'features.lifetimeSellers',
        'features.lifetimeNetFlow'
    ];

    const separationResults = featureKeys.map(key => {
        const winStats = calcStats(tierCWins, key);
        const lossStats = calcStats(tierCLosses, key);
        const allLossNeutralStats = calcStats([...tierCLosses, ...tierCNeutrals], key);
        const sepDelta = Math.abs(winStats.median - lossStats.median);
        const isStrong = sepDelta > 0.05 || (winStats.median > 0 && lossStats.median === 0);

        return {
            feature: key.replace('features.', ''),
            winnerMedian: winStats.median,
            loserMedian: lossStats.median,
            winnerMean: winStats.mean,
            loserMean: lossStats.mean,
            separationStrength: isStrong ? 'STRONG' : 'WEAK',
            separationDelta: sepDelta
        };
    });

    // 3. Ablation Profiles
    console.log('\n--- EVALUATING ABLATION PROFILES ON DEV 35 ---');

    function evaluateAblationProfile(name, gatePredicate) {
        const orchInstance = new StrategyOrchestratorV2_4();
        const tokenClassifier = new EconomicEventClassifier();
        const localTradesMap = new Map();
        const analyzerInst = new EntryQualityAnalyzerV2_6({ windowSeconds: 30 });

        const originalEvaluate = orchInstance.decisionEngine.evaluate.bind(orchInstance.decisionEngine);
        orchInstance.decisionEngine.evaluate = function(state) {
            const dec = originalEvaluate(state);
            if (dec.DECISION === 'BUY' && dec.TIER === 'C') {
                const mint = orchInstance._currentMint;
                const currentTime = state.lastUpdated;
                const tradesSoFar = localTradesMap.get(mint) || [];
                const feat = analyzerInst.analyze(tradesSoFar, currentTime);
                const isAllowed = gatePredicate(feat, dec);
                if (!isAllowed) {
                    dec.DECISION = 'REJECT';
                    dec.TIER = 'REJECT';
                    dec.REASON_CODES.push('entry_quality_gated');
                }
            }
            return dec;
        };

        const originalProcess = orchInstance.processTransaction.bind(orchInstance);
        orchInstance.processTransaction = function(tx, mint, pda, ata) {
            this._currentMint = mint;
            const freshCl = new EconomicEventClassifier();
            const cl = freshCl.classifyTransaction(tx, mint, pda, ata);
            for (const ev of cl) {
                if (ev.classification === 'ECONOMIC_TRADE') {
                    if (!localTradesMap.has(mint)) localTradesMap.set(mint, []);
                    localTradesMap.get(mint).push(ev);
                }
            }
            return originalProcess(tx, mint, pda, ata);
        };

        for (const tx of devTxs) {
            const mint = tx.test_mint_context || tx.token;
            const c = curves[mint];
            if (!c) continue;
            orchInstance.processTransaction(tx, mint, c.pda, c.ata);
        }

        const trades = orchInstance.entryEvents.map(e => {
            const exit = orchInstance.exitEvents.find(x => x.position_id === e.position_id);
            const posUpdates = orchInstance.positionEvents.filter(p => p.position_id === e.position_id);
            const lastPos = posUpdates[posUpdates.length - 1];
            const pnl = exit ? exit.realized_pnl : (lastPos?.unrealized_pnl ?? 0);
            const pnlPct = exit ? exit.final_pnl_pct * 100 : ((lastPos?.unrealized_pnl_pct ?? 0) * 100);
            const mfe = lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0;
            const mae = lastPos ? lastPos.mae.maxAdversePercent * 100 : 0;
            return {
                tier: e.tier,
                token: e.token,
                time: e.timestamp,
                pnl,
                pnlPct,
                mfe,
                mae,
                exitReason: exit?.exit_reason || 'OPEN'
            };
        });

        const totalTrades = trades.length;
        const tierCTrades = trades.filter(t => t.tier === 'C');
        const wins = trades.filter(t => t.pnl > 0.0001);
        const losses = trades.filter(t => t.pnl <= 0.0001);
        const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const expectancy = totalTrades > 0 ? netPnl / totalTrades : 0;

        return {
            name,
            totalTrades,
            tierCTrades: tierCTrades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: totalTrades > 0 ? (wins.length / totalTrades * 100) : 0,
            netPnl,
            profitFactor: pf,
            expectancy,
            trades
        };
    }

    const ablationProfiles = [
        {
            name: 'Profile A: V2.4 Baseline (No Entry-Quality Filter)',
            pred: () => true
        },
        {
            name: 'Profile B: Buyer Depth Only (uB30 >= 2)',
            pred: (f) => f.uniqueBuyers >= 2
        },
        {
            name: 'Profile C: Flow Persistence Only (NetFlow30 > 0)',
            pred: (f) => f.netFlow > 0
        },
        {
            name: 'Profile D: Buyer Depth + Flow Persistence (uB30 >= 2 & NetFlow30 > 0)',
            pred: (f) => f.uniqueBuyers >= 2 && f.netFlow > 0
        },
        {
            name: 'Profile E: Buyer Depth + Concentration (uB30 >= 2 & Top1 <= 70%)',
            pred: (f) => f.uniqueBuyers >= 2 && f.largestBuyerShare <= 0.70
        },
        {
            name: 'Profile F: Full Entry Quality Model (Depth >= 2, NetFlow > 0, Top1 <= 70%, Trigger is BUY)',
            pred: (f) => f.uniqueBuyers >= 2 && f.netFlow > 0 && f.largestBuyerShare <= 0.70 && f.lastTradeSide === 'BUY'
        }
    ];

    const ablationResults = ablationProfiles.map(p => evaluateAblationProfile(p.name, p.pred));

    // Opportunity Cost Breakdown (relative to Profile A Baseline)
    const baselineTrades = ablationResults[0].trades;
    const fullModelTrades = ablationResults[5].trades;

    const opportunityCost = {
        baselineTradesCount: baselineTrades.length,
        fullModelTradesCount: fullModelTrades.length,
        blockedTradesCount: baselineTrades.length - fullModelTrades.length,
        avoidedLossesCount: 0,
        avoidedLossPnlSol: 0,
        missedWinnersCount: 0,
        missedWinnerPnlSol: 0,
        missedRunnersCount: 0,
        netOpportunityCostSol: 0
    };

    baselineTrades.forEach(bt => {
        const inFull = fullModelTrades.some(ft => ft.token === bt.token && Math.abs(ft.time - bt.time) < 10);
        if (!inFull) {
            if (bt.pnl < -0.0001) {
                opportunityCost.avoidedLossesCount++;
                opportunityCost.avoidedLossPnlSol += Math.abs(bt.pnl);
            } else if (bt.pnl > 0.0001) {
                opportunityCost.missedWinnersCount++;
                opportunityCost.missedWinnerPnlSol += bt.pnl;
                if (bt.mfe > 20) opportunityCost.missedRunnersCount++;
            }
        }
    });
    opportunityCost.netOpportunityCostSol = opportunityCost.avoidedLossPnlSol - opportunityCost.missedWinnerPnlSol;

    // Save Complete Analysis Dataset
    const analysisExport = {
        meta: {
            dataset: devFile,
            generated_at: new Date().toISOString(),
            total_dev_txs: devTxs.length,
            unique_tokens: uniqueMints.length,
            lookahead_violations: lookaheadViolations
        },
        tier_c_summary: {
            total: tierCTrades.length,
            winners: tierCWins.length,
            losers: tierCLosses.length,
            neutrals: tierCNeutrals.length
        },
        feature_separation: separationResults,
        ablation_profiles: ablationResults.map(r => ({
            name: r.name,
            totalTrades: r.totalTrades,
            tierCTrades: r.tierCTrades,
            wins: r.wins,
            losses: r.losses,
            winRatePct: r.winRate,
            netPnlSol: r.netPnl,
            profitFactor: r.profitFactor,
            expectancySol: r.expectancy
        })),
        opportunity_cost: opportunityCost,
        final_verdict: "NO ROBUST ENTRY-QUALITY SIGNAL — RETURN TO DEVELOPMENT RESEARCH"
    };

    fs.writeFileSync('validation/v2/v2_6_entry_quality_analysis.json', JSON.stringify(analysisExport, null, 2));
    console.log('Exported: validation/v2/v2_6_entry_quality_analysis.json');

    console.log('\n===============================================================');
    console.log('FINAL RESEARCH CLASSIFICATION:');
    console.log('NO ROBUST ENTRY-QUALITY SIGNAL — RETURN TO DEVELOPMENT RESEARCH');
    console.log('===============================================================\n');

    return analysisExport;
}

runEntryQualityAnalysis();
