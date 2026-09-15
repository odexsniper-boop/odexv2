const fs = require('fs');

async function auditDiagnostics() {
    const { StrategyOrchestratorV2_1 } = await import('../engines/v2/strategyOrchestratorV2_1.js');

    const oos2File = 'replay/raw_txs_oos2_final.json';
    const oosTxs = JSON.parse(fs.readFileSync(oos2File, 'utf8'));
    oosTxs.sort((a, b) => a.timestamp - b.timestamp);
    const oosMints = Array.from(new Set(oosTxs.map(t => t.test_mint_context)));

    // Curves
    const curves = {};
    for (const m of oosMints) {
        const mintTxs = oosTxs.filter(t => t.test_mint_context === m);
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

    const v1State = JSON.parse(fs.readFileSync('storage/trades_state.json', 'utf8'));
    const v1Map = new Map();
    (v1State.tradeHistory || []).forEach(t => v1Map.set(t.mint, t));

    const orchestrator = new StrategyOrchestratorV2_1({
        standardSizeSol: 0.10,
        probeSizeSol: 0.025
    });

    const marketStatesAtDecisions = [];

    // Capture states
    const originalDec = orchestrator.decisionEngine.evaluate.bind(orchestrator.decisionEngine);
    orchestrator.decisionEngine.evaluate = function (state) {
        const dec = originalDec(state);
        marketStatesAtDecisions.push({
            token: state.token || 'unknown',
            time: state.lastUpdated,
            state: JSON.parse(JSON.stringify(state)),
            decision: JSON.parse(JSON.stringify(dec))
        });
        return dec;
    };

    for (const tx of oosTxs) {
        const m = tx.test_mint_context;
        const curve = curves[m];
        if (!curve) continue;
        orchestrator.processTransaction(tx, m, curve.pda, curve.ata);
    }

    console.log('=== SINGLE V2.1 LOSS FORENSIC ===');
    const exitTrade = orchestrator.exitEvents[0];
    const entryTrade = orchestrator.entryEvents[0];
    console.log('Entry Event:', entryTrade);
    console.log('Exit Event:', exitTrade);

    const enteredPos = orchestrator.positionEvents.filter(p => p.token === entryTrade?.token);
    console.log('Positions updates count:', enteredPos.length);
    if (enteredPos.length > 0) {
        const lastPos = enteredPos[enteredPos.length - 1];
        console.log('Last Position State:', {
            token: lastPos.token,
            thesis_state: lastPos.thesis_state,
            mae: lastPos.mae,
            mfe: lastPos.mfe,
            flow_state: lastPos.flow_state,
            coordination_risk: lastPos.coordination_risk,
            unrealized_pnl_pct: lastPos.unrealized_pnl_pct
        });
    }

    // Check all V1 winners in OOS-2
    console.log('\n=== MISSED V1 WINNERS AUDIT ===');
    const oosWinners = [];
    const oosLosers = [];
    oosMints.forEach(m => {
        const t = v1Map.get(m);
        if (t) {
            if ((t.finalPnlPercent || 0) > 0) oosWinners.push(t);
            else oosLosers.push(t);
        }
    });

    console.log('OOS-2 V1 Winners count:', oosWinners.length);
    console.log('OOS-2 V1 Losers count:', oosLosers.length);

    oosWinners.forEach(w => {
        const decs = orchestrator.decisionHistory.filter(d => d.token === w.mint);
        console.log(`\nWinner: ${w.mint} (V1 PnL: ${w.finalPnlPercent}%)`);
        console.log(`  Decisions emitted: ${decs.length}`);
        if (decs.length > 0) {
            decs.forEach((d, idx) => {
                console.log(`  [Tick ${idx}] Decision: ${d.decision.DECISION}, Tier: ${d.decision.TIER}, Opp: ${d.decision.OPPORTUNITY_SCORE}, Conf: ${d.decision.CONFIDENCE_SCORE}, Safety: ${d.decision.HARD_SAFETY_STATUS}, Reasons: ${d.decision.REASON_CODES.join(',')}`);
            });
        }
    });

    // Score distributions
    const oppScoresWinners = [];
    const oppScoresLosers = [];
    const confScoresWinners = [];
    const confScoresLosers = [];
    const coordScoresWinners = [];
    const coordScoresLosers = [];

    orchestrator.decisionHistory.forEach(d => {
        const isWin = oosWinners.some(w => w.mint === d.token);
        if (isWin) {
            oppScoresWinners.push(d.decision.OPPORTUNITY_SCORE);
            confScoresWinners.push(d.decision.CONFIDENCE_SCORE);
        } else {
            oppScoresLosers.push(d.decision.OPPORTUNITY_SCORE);
            confScoresLosers.push(d.decision.CONFIDENCE_SCORE);
        }
    });

    const avg = arr => arr.length > 0 ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : 0;
    console.log('\n=== SCORE DISTRIBUTIONS ===');
    console.log(`Winners Opp: avg=${avg(oppScoresWinners)}, min=${Math.min(...oppScoresWinners)}, max=${Math.max(...oppScoresWinners)}`);
    console.log(`Losers  Opp: avg=${avg(oppScoresLosers)}, min=${Math.min(...oppScoresLosers)}, max=${Math.max(...oppScoresLosers)}`);
    console.log(`Winners Conf: avg=${avg(confScoresWinners)}, min=${Math.min(...confScoresWinners)}, max=${Math.max(...confScoresWinners)}`);
    console.log(`Losers  Conf: avg=${avg(confScoresLosers)}, min=${Math.min(...confScoresLosers)}, max=${Math.max(...confScoresLosers)}`);
}

auditDiagnostics();
