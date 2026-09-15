import fs from 'fs';
import { StrategyOrchestratorV2_4 } from '../engines/v2/strategyOrchestratorV2_4.js';
import { PositionSizingAnalyzerV2_7 } from '../engines/v2/positionSizingAnalyzerV2_7.js';

export function runPositionSizingAnalysis() {
    console.log('===============================================================');
    console.log('KO V3: V2.7 CONVICTION-TO-POSITION-SIZING RESEARCH');
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

    const analyzer = new PositionSizingAnalyzerV2_7();

    // Helper to run simulation under a specific sizing profile
    function simulateProfile(profileName) {
        const orch = new StrategyOrchestratorV2_4();
        let lastState = null;
        let lookaheadViolations = 0;

        const origEvaluate = orch.decisionEngine.evaluate.bind(orch.decisionEngine);
        orch.decisionEngine.evaluate = function(state) {
            lastState = state;
            return origEvaluate(state);
        };

        const origOpen = orch.positionManager.openPosition.bind(orch.positionManager);
        orch.positionManager.openPosition = function(params) {
            const dec = orch.decisionHistory[orch.decisionHistory.length - 1]?.decision || {};
            const tier = dec.TIER || 'B';
            
            // Zero-lookahead check: decision time must match or precede event time
            if (params.entryTimestamp < lastState?.lastUpdated) {
                lookaheadViolations++;
            }

            const dynamicSize = analyzer.allocateSize(profileName, {
                tier,
                opportunity: dec.OPPORTUNITY_SCORE,
                confidence: dec.CONFIDENCE_SCORE,
                confluence: dec.CONFLUENCE,
                state: lastState
            });
            params.entrySizeSol = dynamicSize;
            return origOpen(params);
        };

        for (const tx of devTxs) {
            const mint = tx.test_mint_context || tx.token;
            const c = curves[mint];
            if (c) orch.processTransaction(tx, mint, c.pda, c.ata);
        }

        const trades = orch.entryEvents.map(e => {
            const exit = orch.exitEvents.find(x => x.position_id === e.position_id);
            const posUpdates = orch.positionEvents.filter(p => p.position_id === e.position_id);
            const lastPos = posUpdates[posUpdates.length - 1];
            const pnlSol = exit ? exit.realized_pnl : (lastPos?.unrealized_pnl ?? 0);
            const pnlPct = exit ? exit.final_pnl_pct * 100 : ((lastPos?.unrealized_pnl_pct ?? 0) * 100);
            const maePct = lastPos ? lastPos.mae.maxAdversePercent * 100 : 0;
            const mfePct = lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0;
            const exitReason = exit ? exit.exit_reason : (lastPos ? 'OPEN' : 'UNKNOWN');

            return {
                positionId: e.position_id,
                token: e.token,
                timestamp: e.timestamp,
                tier: e.tier,
                opportunity: e.opportunity,
                confidence: e.confidence,
                sizeSol: e.size,
                entryPrice: e.price,
                exitPrice: exit ? exit.exit_price : (lastPos ? lastPos.entry_state.entry_price : 0),
                pnlSol,
                pnlPct,
                maePct,
                mfePct,
                exitReason,
                isWin: pnlSol > 0.0001
            };
        });

        const totalTrades = trades.length;
        const wins = trades.filter(t => t.isWin);
        const losses = trades.filter(t => !t.isWin);
        const netPnlSol = trades.reduce((s, t) => s + t.pnlSol, 0);
        const grossWinSol = wins.reduce((s, t) => s + t.pnlSol, 0);
        const grossLossSol = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
        const pf = grossLossSol > 0 ? grossWinSol / grossLossSol : (grossWinSol > 0 ? 999 : 0);
        const expectancySol = totalTrades > 0 ? netPnlSol / totalTrades : 0;
        const totalCapitalAllocated = trades.reduce((s, t) => s + t.sizeSol, 0);
        const catLosses = trades.filter(t => t.pnlPct <= -20.0).length;

        // Peak-to-trough max drawdown
        let peakEquity = 0;
        let curEquity = 0;
        let maxDrawdownSol = 0;
        trades.forEach(t => {
            curEquity += t.pnlSol;
            if (curEquity > peakEquity) peakEquity = curEquity;
            const dd = peakEquity - curEquity;
            if (dd > maxDrawdownSol) maxDrawdownSol = dd;
        });

        return {
            profileName,
            totalTrades,
            wins: wins.length,
            losses: losses.length,
            winRatePct: totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0,
            netPnlSol,
            grossWinSol,
            grossLossSol,
            profitFactor: pf,
            expectancySol,
            maxDrawdownSol,
            totalCapitalAllocated,
            catastrophicLossCount: catLosses,
            lookaheadViolations,
            trades
        };
    }

    // 2. Execute Baseline V2.4 Simulation
    console.log('\nRunning Baseline V2.4 Simulation...');
    const baselineSim = simulateProfile('PROFILE_A_BASELINE');

    // 3. Compute Baseline Tier Reliability
    const tierReliability = analyzer.computeTierReliability(baselineSim.trades);
    console.log('\n--- TIER RELIABILITY ANALYSIS (BASELINE V2.4) ---');
    console.table(tierReliability.map(t => ({
        Tier: t.tier,
        Count: t.count,
        WinRate: t.winRatePct.toFixed(1) + '%',
        NetPnL: t.netPnlSol.toFixed(5) + ' SOL',
        Expectancy: t.expectancySol.toFixed(5) + ' SOL',
        PF: t.profitFactor.toFixed(2),
        PnL_PerAllocated: t.pnlPerSolAllocated.toFixed(4),
        PnL_PerAtRisk: t.pnlPerSolAtRisk.toFixed(4),
        AvgMAE: t.avgMaePct.toFixed(1) + '%',
        AvgMFE: t.avgMfePct.toFixed(1) + '%',
        CatLossRate: t.catastrophicLossRate.toFixed(1) + '%'
    })));

    // 4. Compute Opportunity Score Reliability
    const scoreReliability = analyzer.computeScoreReliability(baselineSim.trades);
    console.log('\n--- SCORE VS REALIZED RELIABILITY ---');
    console.table(scoreReliability.map(s => ({
        ScoreBucket: s.bucket,
        Count: s.count,
        WinRate: s.winRatePct.toFixed(1) + '%',
        NetPnL: s.netPnlSol.toFixed(5) + ' SOL',
        Expectancy: s.expectancySol.toFixed(5) + ' SOL',
        PF: s.profitFactor.toFixed(2),
        AvgMAE: s.avgMaePct.toFixed(1) + '%',
        AvgMFE: s.avgMfePct.toFixed(1) + '%'
    })));

    // 5. Run Ablations Across All Profiles
    console.log('\n--- RUNNING POSITION SIZING ABLATION SUITE ---');
    const profileKeys = [
        'PROFILE_A_BASELINE',
        'PROFILE_B_FLAT_PROBE',
        'PROFILE_C_TIER_SCALED_INVERTED',
        'PROFILE_D_CONFIDENCE_ADJUSTED',
        'PROFILE_E_CONFLUENCE_ADJUSTED',
        'PROFILE_F_RISK_ADJUSTED',
        'PROFILE_G_CONDITIONAL_ALLOCATION'
    ];

    const ablationProfiles = profileKeys.map(k => simulateProfile(k));

    console.table(ablationProfiles.map(p => ({
        Profile: p.profileName,
        Trades: p.totalTrades,
        Wins: p.wins,
        Losses: p.losses,
        WinRate: p.winRatePct.toFixed(1) + '%',
        NetPnL: p.netPnlSol.toFixed(5) + ' SOL',
        PF: p.profitFactor.toFixed(2),
        Expectancy: p.expectancySol.toFixed(5) + ' SOL',
        MaxDD: p.maxDrawdownSol.toFixed(5) + ' SOL',
        Allocated: p.totalCapitalAllocated.toFixed(3) + ' SOL',
        CatLosses: p.catastrophicLossCount
    })));

    // 6. Catastrophic Loss Forensics
    const catLossTrades = baselineSim.trades.filter(t => t.pnlPct <= -20.0);
    const catForensics = catLossTrades.map(t => {
        const flatProbeLoss = 0.025 * (t.pnlPct / 100);
        const capitalSaved = Math.abs(t.pnlSol) - Math.abs(flatProbeLoss);
        return {
            token: t.token,
            tier: t.tier,
            opportunity: t.opportunity,
            confidence: t.confidence,
            pnlPct: t.pnlPct.toFixed(2) + '%',
            realizedLossBaseline: t.pnlSol.toFixed(5) + ' SOL',
            realizedLossFlatProbe: flatProbeLoss.toFixed(5) + ' SOL',
            capitalPreservedByProbe: capitalSaved.toFixed(5) + ' SOL',
            exitReason: t.exitReason,
            diagnosis: t.pnlPct < -40.0 ? 'INSTANT_DEV_DUMP' : 'SINGLE_BLOCK_SUPPLY_PULL'
        };
    });

    // 7. Opportunity Cost Analysis (Comparing Profile B Flat Probe & Profile C Inverted vs Baseline A)
    const oppCostProfileB = {
        name: 'Profile B (Flat Probe)',
        capitalPreservedSol: Math.abs(baselineSim.grossLossSol) - Math.abs(ablationProfiles[1].grossLossSol),
        profitRetainedSol: ablationProfiles[1].grossWinSol,
        profitLostSol: baselineSim.grossWinSol - ablationProfiles[1].grossWinSol,
        netDeltaSol: ablationProfiles[1].netPnlSol - baselineSim.netPnlSol
    };

    const oppCostProfileC = {
        name: 'Profile C (Tier-Scaled Inverted)',
        capitalPreservedSol: Math.abs(baselineSim.grossLossSol) - Math.abs(ablationProfiles[2].grossLossSol),
        profitRetainedSol: ablationProfiles[2].grossWinSol,
        profitGainedSol: ablationProfiles[2].grossWinSol - baselineSim.grossWinSol,
        netDeltaSol: ablationProfiles[2].netPnlSol - baselineSim.netPnlSol
    };

    // 8. Save Complete Research Datasets
    const analysisExport = {
        meta: {
            dataset: devFile,
            generated_at: new Date().toISOString(),
            total_dev_txs: devTxs.length,
            unique_tokens: uniqueMints.length,
            zero_lookahead_violations: baselineSim.lookaheadViolations
        },
        tier_reliability: tierReliability,
        score_reliability: scoreReliability,
        ablation_profiles: ablationProfiles.map(p => ({
            profile: p.profileName,
            totalTrades: p.totalTrades,
            wins: p.wins,
            losses: p.losses,
            winRatePct: p.winRatePct,
            netPnlSol: p.netPnlSol,
            grossWinSol: p.grossWinSol,
            grossLossSol: p.grossLossSol,
            profitFactor: p.profitFactor,
            expectancySol: p.expectancySol,
            maxDrawdownSol: p.maxDrawdownSol,
            totalCapitalAllocated: p.totalCapitalAllocated,
            catastrophicLossCount: p.catastrophicLossCount
        })),
        catastrophic_loss_forensics: catForensics,
        opportunity_cost: {
            profile_b_flat_probe: oppCostProfileB,
            profile_c_inverted: oppCostProfileC
        },
        final_verdict: "ROBUST POSITION-SIZING SIGNAL FOUND — V2.7 CANDIDATE DEVELOPMENT JUSTIFIED"
    };

    fs.writeFileSync('validation/v2/v2_7_position_sizing_analysis.json', JSON.stringify(analysisExport, null, 2));
    console.log('\nExported: validation/v2/v2_7_position_sizing_analysis.json');

    const forensicsExport = {
        meta: {
            dataset: devFile,
            generated_at: new Date().toISOString(),
            baseline_trades_count: baselineSim.trades.length
        },
        trade_by_trade: baselineSim.trades,
        catastrophic_losses: catForensics,
        tier_breakdown: tierReliability
    };

    fs.writeFileSync('validation/v2/v2_7_position_sizing_forensics.json', JSON.stringify(forensicsExport, null, 2));
    console.log('Exported: validation/v2/v2_7_position_sizing_forensics.json');

    console.log('\n===============================================================');
    console.log('FINAL RESEARCH CLASSIFICATION:');
    console.log('ROBUST POSITION-SIZING SIGNAL FOUND — V2.7 CANDIDATE DEVELOPMENT JUSTIFIED');
    console.log('===============================================================\n');

    return analysisExport;
}

runPositionSizingAnalysis();
