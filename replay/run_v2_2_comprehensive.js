import fs from 'fs';
import { StrategyOrchestratorV2_1 } from '../engines/v2/strategyOrchestratorV2_1.js';
import { StrategyOrchestratorV2_2 } from '../engines/v2/strategyOrchestratorV2_2.js';

export function runV2_2ComprehensiveCalibration() {
    console.log('=== KO V3 V2.2: DYNAMIC FLOW CALIBRATION REPORT RUNNER ===\n');

    const devFile = 'replay/raw_txs_expanded_35.json';
    const allTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    allTxs.sort((a, b) => a.timestamp - b.timestamp);
    const uniqueMints = Array.from(new Set(allTxs.map(t => t.test_mint_context)));
    console.log(`Development Dataset: ${allTxs.length} transactions across ${uniqueMints.length} tokens.`);

    // 1. Resolve Curves using top transfer account frequency
    const curves = {};
    for (const m of uniqueMints) {
        const mintTxs = allTxs.filter(t => t.test_mint_context === m);
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
        const topUser = Object.entries(userCounts).sort((a,b)=>b[1]-a[1])[0];
        const topAta = Object.entries(ataCounts).sort((a,b)=>b[1]-a[1])[0];
        if (topUser && topAta) curves[m] = { pda: topUser[0], ata: topAta[0] };
    }

    // 2. Load V1 baseline
    const v1State = JSON.parse(fs.readFileSync('storage/trades_state.json', 'utf8'));
    const v1Map = new Map();
    (v1State.tradeHistory || []).forEach(t => v1Map.set(t.mint, t));

    const v1Winners = uniqueMints.filter(m => (v1Map.get(m)?.finalPnlPercent || 0) > 0);
    const v1Losers = uniqueMints.filter(m => v1Map.has(m) && (v1Map.get(m)?.finalPnlPercent || 0) <= 0);

    console.log(`Baseline V1 Cohorts: ${v1Winners.length} Winners, ${v1Losers.length} Losers.\n`);

    // 3. Execution function
    function simulateOrchestrator(name, OrchestratorClass) {
        const orch = new OrchestratorClass({
            standardSizeSol: 0.10,
            probeSizeSol: 0.025
        });

        for (const tx of allTxs) {
            const m = tx.test_mint_context;
            const curve = curves[m];
            if (!curve) continue;
            orch.processTransaction(tx, m, curve.pda, curve.ata);
        }

        const entries = orch.entryEvents;
        const exits = orch.exitEvents;
        const positions = orch.positionEvents;

        // Zero lookahead verification
        let noLookaheadPassed = true;
        for (const p of positions) {
            if (p.mae.timestamp > p.timestamp || p.mfe.timestamp > p.timestamp) {
                noLookaheadPassed = false;
            }
        }

        const trades = entries.map(e => {
            const exit = exits.find(x => x.position_id === e.position_id);
            const pnlSol = exit ? exit.realized_pnl : 0;
            const pnlPct = exit ? exit.final_pnl_pct * 100 : 0;
            const v1t = v1Map.get(e.token);
            const wasV1Winner = v1t ? (v1t.finalPnlPercent || 0) > 0 : false;
            return {
                token: e.token,
                tier: e.tier,
                size: e.size,
                opportunity: e.opportunity,
                confidence: e.confidence,
                pnlSol,
                pnlPct,
                exitReason: exit?.exit_reason,
                wasV1Winner
            };
        });

        const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
        const wins = trades.filter(t => t.pnlSol > 0);
        const losses = trades.filter(t => t.pnlSol <= 0);
        const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;
        const maxDrawdown = trades.length > 0 ? Math.min(0, ...trades.map(t => t.pnlPct)) : 0;

        const enteredMints = new Set(trades.map(t => t.token));
        const v1WinnersCaptured = v1Winners.filter(w => enteredMints.has(w));
        const v1WinnersMissed = v1Winners.filter(w => !enteredMints.has(w));
        const v1LosersAvoided = v1Losers.filter(l => !enteredMints.has(l));
        const v1LosersReintroduced = v1Losers.filter(l => enteredMints.has(l));

        return {
            name,
            totalTrades: trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
            totalPnlSol: totalPnl,
            grossProfit,
            grossLoss,
            profitFactor,
            expectancySol: expectancy,
            maxDrawdownPct: maxDrawdown,
            v1WinnersCaptured: v1WinnersCaptured.length,
            v1WinnersMissed: v1WinnersMissed.length,
            v1LosersAvoided: v1LosersAvoided.length,
            v1LosersReintroduced: v1LosersReintroduced.length,
            capturedWinnerTokens: v1WinnersCaptured,
            reintroducedLoserTokens: v1LosersReintroduced,
            noLookaheadPassed,
            trades
        };
    }

    const resV2_1 = simulateOrchestrator('V2.1 (Coordination Calibrated)', StrategyOrchestratorV2_1);
    const resV2_2 = simulateOrchestrator('V2.2 (Dynamic Flow Calibrated)', StrategyOrchestratorV2_2);

    console.log('-------------------------------------------------------------');
    console.log(`MODEL COMPARISON ON 35-TOKEN DEV SET:`);
    console.log(`Metric                     | V2.1             | V2.2`);
    console.log('-------------------------------------------------------------');
    console.log(`Total Trades               | ${resV2_1.totalTrades.toString().padEnd(16)} | ${resV2_2.totalTrades}`);
    console.log(`Wins / Losses              | ${(resV2_1.wins + ' / ' + resV2_1.losses).padEnd(16)} | ${resV2_2.wins} / ${resV2_2.losses}`);
    console.log(`Win Rate                   | ${(resV2_1.winRate.toFixed(1) + '%').padEnd(16)} | ${resV2_2.winRate.toFixed(1)}%`);
    console.log(`Gross Profit (SOL)         | ${('+'+resV2_1.grossProfit.toFixed(4)).padEnd(16)} | +${resV2_2.grossProfit.toFixed(4)}`);
    console.log(`Gross Loss (SOL)           | ${('-'+resV2_1.grossLoss.toFixed(4)).padEnd(16)} | -${resV2_2.grossLoss.toFixed(4)}`);
    console.log(`Net P&L (SOL)              | ${resV2_1.totalPnlSol.toFixed(4).padEnd(16)} | ${resV2_2.totalPnlSol.toFixed(4)}`);
    console.log(`Profit Factor              | ${resV2_1.profitFactor.toFixed(2).padEnd(16)} | ${resV2_2.profitFactor.toFixed(2)}`);
    console.log(`Expectancy (SOL/trade)     | ${resV2_1.expectancySol.toFixed(4).padEnd(16)} | ${resV2_2.expectancySol.toFixed(4)}`);
    console.log(`Max Drawdown (%)           | ${(resV2_1.maxDrawdownPct.toFixed(1)+'%').padEnd(16)} | ${resV2_2.maxDrawdownPct.toFixed(1)}%`);
    console.log(`V1 Winners Captured (/17)  | ${resV2_1.v1WinnersCaptured.toString().padEnd(16)} | ${resV2_2.v1WinnersCaptured}`);
    console.log(`V1 Winners Missed (/17)    | ${resV2_1.v1WinnersMissed.toString().padEnd(16)} | ${resV2_2.v1WinnersMissed}`);
    console.log(`V1 Losers Avoided (/18)    | ${resV2_1.v1LosersAvoided.toString().padEnd(16)} | ${resV2_2.v1LosersAvoided}`);
    console.log(`V1 Losers Reintroduced     | ${resV2_1.v1LosersReintroduced.toString().padEnd(16)} | ${resV2_2.v1LosersReintroduced}`);
    console.log(`Zero-Lookahead Passed      | ${resV2_1.noLookaheadPassed.toString().padEnd(16)} | ${resV2_2.noLookaheadPassed}`);
    console.log('-------------------------------------------------------------\n');

    console.log('V2.2 Captured Winners:', resV2_2.capturedWinnerTokens);
    console.log('V2.2 Reintroduced Losers:', resV2_2.reintroducedLoserTokens);

    return { resV2_1, resV2_2 };
}

runV2_2ComprehensiveCalibration();
