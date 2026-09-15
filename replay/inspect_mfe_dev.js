import fs from 'fs';
import { StrategyOrchestratorV2_2 } from '../engines/v2/strategyOrchestratorV2_2.js';

const devFile = 'replay/raw_txs_expanded_35.json';
const allTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
allTxs.sort((a, b) => a.timestamp - b.timestamp);
const uniqueMints = Array.from(new Set(allTxs.map(t => t.test_mint_context)));

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

const orch = new StrategyOrchestratorV2_2();

for (const tx of allTxs) {
    const m = tx.test_mint_context;
    const curve = curves[m];
    if (!curve) continue;
    orch.processTransaction(tx, m, curve.pda, curve.ata);
}

console.log('Total V2.2 trades on 35-token Dev dataset:', orch.entryEvents.length);
const positions = orch.positionEvents;
const exits = orch.exitEvents;

let totalMfe = 0;
let totalRealized = 0;
let monetizedCount = 0;
let givebackCount = 0;

orch.entryEvents.forEach((e, idx) => {
    const posUpdates = positions.filter(p => p.position_id === e.position_id);
    const lastPos = posUpdates[posUpdates.length - 1];
    const exit = exits.find(x => x.position_id === e.position_id);
    const mfe = lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0;
    const mae = lastPos ? lastPos.mae.maxAdversePercent * 100 : 0;
    const finalPnlPct = exit ? exit.final_pnl_pct * 100 : 0;
    const pnlSol = exit ? exit.realized_pnl : 0;
    
    totalMfe += mfe;
    totalRealized += finalPnlPct;
    if (mfe > 5 && finalPnlPct > 0) monetizedCount++;
    if (mfe > 10 && finalPnlPct <= 0) givebackCount++;

    console.log(`Trade #${(idx+1).toString().padStart(2)}: ${e.token.slice(0, 10)} | Tier ${e.tier} | Size: ${e.size} | MFE: +${mfe.toFixed(1).padStart(5)}% | MAE: ${mae.toFixed(1).padStart(5)}% | Realized: ${finalPnlPct.toFixed(1).padStart(5)}% (${(pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(4)} SOL) | Exit: ${exit?.exit_reason}`);
});

console.log('\nAggregate MFE / Realization Diagnostics:');
console.log(`Average MFE: +${(totalMfe / orch.entryEvents.length).toFixed(1)}%`);
console.log(`Average Realized P&L: ${(totalRealized / orch.entryEvents.length).toFixed(1)}%`);
console.log(`Profitable Excursions (>5% MFE) Monetized: ${monetizedCount}`);
console.log(`Trades with >10% MFE that ended at Breakeven/Loss: ${givebackCount}`);
