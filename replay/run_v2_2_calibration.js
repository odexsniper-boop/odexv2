import fs from 'fs';
import { StrategyOrchestratorV2_1 } from '../engines/v2/strategyOrchestratorV2_1.js';
import { StrategyOrchestratorV2_2 } from '../engines/v2/strategyOrchestratorV2_2.js';

export function runV2_2Calibration() {
    console.log('=== KO V3 V2.2: DYNAMIC FLOW CALIBRATION ON 35-TOKEN DEV SET ===\n');

    const devFile = 'replay/raw_txs_expanded_35.json';
    const allTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    allTxs.sort((a, b) => a.timestamp - b.timestamp);
    const uniqueMints = Array.from(new Set(allTxs.map(t => t.test_mint_context)));
    console.log(`Development Dataset: ${allTxs.length} transactions across ${uniqueMints.length} tokens.`);

    // 1. Resolve Curves
    const curves = {};
    for (const m of uniqueMints) {
        const mintTxs = allTxs.filter(t => t.test_mint_context === m);
        for (const tx of mintTxs) {
            if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;
            const transfers = tx.tokenTransfers.filter(t => t.mint === m);
            if (transfers.length === 0) continue;

            const initT = transfers.find(t => t.tokenAmount > 700000000);
            if (initT) {
                curves[m] = { pda: initT.toUserAccount, ata: initT.toTokenAccount };
                break;
            }

            if (tx.accountData) {
                for (const t of transfers) {
                    const fromAcct = tx.accountData.find(a => a.account === t.fromUserAccount && a.nativeBalanceChange !== 0);
                    const toAcct = tx.accountData.find(a => a.account === t.toUserAccount && a.nativeBalanceChange !== 0);
                    if (fromAcct) {
                        curves[m] = { pda: t.fromUserAccount, ata: t.fromTokenAccount };
                        break;
                    } else if (toAcct) {
                        curves[m] = { pda: t.toUserAccount, ata: t.toTokenAccount };
                        break;
                    }
                }
            }
            if (curves[m]) break;
        }
    }

    // 2. Load V1 baseline
    const v1State = JSON.parse(fs.readFileSync('storage/trades_state.json', 'utf8'));
    const v1Map = new Map();
    (v1State.tradeHistory || []).forEach(t => v1Map.set(t.mint, t));

    const v1Winners = [];
    const v1Losers = [];
    uniqueMints.forEach(m => {
        const t = v1Map.get(m);
        if (t) {
            if ((t.finalPnlPercent || 0) > 0) v1Winners.push(t);
            else v1Losers.push(t);
        }
    });

    console.log(`Baseline V1 Dev Cohorts: ${v1Winners.length} Winners, ${v1Losers.length} Losers.\n`);

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

        // Trace trades
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

        // V1 comparison breakdown
        const enteredMints = new Set(trades.map(t => t.token));
        const v1WinnersCaptured = v1Winners.filter(w => enteredMints.has(w.mint));
        const v1WinnersMissed = v1Winners.filter(w => !enteredMints.has(w.mint));
        const v1LosersAvoided = v1Losers.filter(l => !enteredMints.has(l.mint));
        const v1LosersReintroduced = v1Losers.filter(l => enteredMints.has(l.mint));

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
            v1WinnersCaptured: v1WinnersCaptured.length,
            v1WinnersMissed: v1WinnersMissed.length,
            v1LosersAvoided: v1LosersAvoided.length,
            v1LosersReintroduced: v1LosersReintroduced.length,
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
    console.log(`Net P&L (SOL)              | ${resV2_1.totalPnlSol.toFixed(4).padEnd(16)} | ${resV2_2.totalPnlSol.toFixed(4)}`);
    console.log(`Profit Factor              | ${resV2_1.profitFactor.toFixed(2).padEnd(16)} | ${resV2_2.profitFactor.toFixed(2)}`);
    console.log(`V1 Winners Captured (/17)  | ${resV2_1.v1WinnersCaptured.toString().padEnd(16)} | ${resV2_2.v1WinnersCaptured}`);
    console.log(`V1 Winners Missed (/17)    | ${resV2_1.v1WinnersMissed.toString().padEnd(16)} | ${resV2_2.v1WinnersMissed}`);
    console.log(`V1 Losers Avoided (/18)    | ${resV2_1.v1LosersAvoided.toString().padEnd(16)} | ${resV2_2.v1LosersAvoided}`);
    console.log(`V1 Losers Reintroduced     | ${resV2_1.v1LosersReintroduced.toString().padEnd(16)} | ${resV2_2.v1LosersReintroduced}`);
    console.log('-------------------------------------------------------------\n');

    console.log('V2.2 Detailed Trades:');
    resV2_2.trades.forEach((t, i) => {
        console.log(` Trade #${i + 1}: ${t.token.slice(0, 8)}... | Tier ${t.tier} (${t.size} SOL) | Opp: ${t.opportunity}, Conf: ${t.confidence} | PnL: ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)} SOL (${t.pnlPct.toFixed(1)}%) | Reason: ${t.exitReason} | V1: ${t.wasV1Winner ? 'WINNER' : 'LOSER'}`);
    });

    return { resV2_1, resV2_2 };
}

runV2_2Calibration();
