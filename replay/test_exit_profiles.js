import fs from 'fs';
import { EconomicEventClassifier } from '../engines/v2/economicEventClassifierV2.js';
import { MarketStateBuilder } from '../engines/v2/marketStateBuilderV2.js';
import { WalletRegistry } from '../engines/v2/walletRegistryV2.js';
import { DecisionEngine } from '../engines/v2/decisionEngineV2.js';
import { CoordinationRiskEngineV2_1 } from '../engines/v2/coordinationRiskV2_1.js';
import { OpportunityScoreEngineV2_2 } from '../engines/v2/opportunityScoreV2_2.js';
import { PositionManagerV2 } from '../engines/v2/positionManagerV2.js';
import { ThesisStateEngine } from '../engines/v2/thesisStateEngineV2.js';

const devFile = 'replay/raw_txs_expanded_35.json';
const allTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
allTxs.sort((a, b) => a.timestamp - b.timestamp);
const uniqueMints = Array.from(new Set(allTxs.map(t => t.test_mint_context)));

// Curves
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

export function testExitProfile(profileName, configCustomizer) {
    const classifier = new EconomicEventClassifier();
    const walletRegistry = new WalletRegistry();
    const marketStateBuilder = new MarketStateBuilder(walletRegistry);
    marketStateBuilder.coordinationRiskEngine = new CoordinationRiskEngineV2_1(walletRegistry);

    const decisionEngine = new DecisionEngine();
    decisionEngine.opportunity = new OpportunityScoreEngineV2_2();

    // Standard Decision Logic
    const originalDecision = decisionEngine.evaluate.bind(decisionEngine);
    decisionEngine.evaluate = function (state) {
        const dec = originalDecision(state);
        const crObj = state.coordinationRisk?.['10s'];
        const level = crObj?.level ?? 'LOW';
        if (level === 'EXTREME') {
            dec.DECISION = 'REJECT';
            dec.TIER = 'REJECT';
            return dec;
        }
        if (level === 'HIGH' && dec.DECISION === 'BUY') {
            dec.TIER = 'C';
        } else if (dec.DECISION === 'REJECT' && dec.HARD_SAFETY_STATUS !== 'REJECT') {
            if (dec.OPPORTUNITY_SCORE >= 55 && dec.CONFIDENCE_SCORE >= 65) {
                dec.DECISION = 'BUY';
                dec.TIER = 'C';
            }
        }
        return dec;
    };

    const positionManager = new PositionManagerV2({
        initialProfitTargetPct: 0.40,
        partialExitFraction: 0.50,
        maxHardLossPct: -0.20,
        runnerTrailingPctStrong: 0.20,
        runnerTrailingPctWeak: 0.10
    });

    // Apply Profile Customizations
    configCustomizer(positionManager);

    const openPositions = new Map();
    const entryEvents = [];
    const exitEvents = [];
    const positionEvents = [];

    for (const tx of allTxs) {
        const mint = tx.test_mint_context;
        const curve = curves[mint];
        if (!curve) continue;

        const classifiedEvents = classifier.classifyTransaction(tx, mint, curve.pda, curve.ata);
        for (const event of classifiedEvents) {
            if (event.classification === 'ECONOMIC_TRADE' || event.classification === 'VIRTUAL_LIQUIDITY_EVENT') {
                const marketState = marketStateBuilder.processClassifiedEvent(event);
                const currentTime = event.event_time;

                if (openPositions.has(mint)) {
                    const posId = openPositions.get(mint);
                    const updateRes = positionManager.updatePosition(posId, marketState, currentTime);

                    if (updateRes) {
                        const pos = updateRes.position;
                        const action = updateRes.action;

                        positionEvents.push({
                            position_id: pos.position_id,
                            token: pos.token,
                            timestamp: currentTime,
                            mae: { ...pos.mae },
                            mfe: { ...pos.mfe },
                            unrealized_pnl_pct: pos.unrealized_pnl_pct
                        });

                        if (action.type === 'FULL_EXIT') {
                            exitEvents.push({
                                position_id: pos.position_id,
                                token: pos.token,
                                entry_size: pos.entry_size,
                                exit_price: pos.exit_price,
                                exit_timestamp: pos.exit_timestamp,
                                realized_pnl: pos.realized_pnl,
                                final_pnl_pct: (pos.exit_price - pos.entry_price) / pos.entry_price,
                                exit_reason: pos.exit_reason
                            });
                            openPositions.delete(mint);
                        }
                    }
                } else if (event.classification === 'ECONOMIC_TRADE') {
                    const decision = decisionEngine.evaluate(marketState);
                    if (decision.DECISION === 'BUY' && ['A+', 'A', 'B', 'C'].includes(decision.TIER)) {
                        const positionId = `dev_${mint}_${currentTime}`;
                        const entryPrice = marketState.price?.value ?? event.effectivePrice;
                        const sizeSol = (decision.TIER === 'C') ? 0.025 : 0.10;

                        const pos = positionManager.openPosition({
                            positionId,
                            token: mint,
                            entryTimestamp: currentTime,
                            entryPrice,
                            entrySizeSol: sizeSol,
                            opportunityAtEntry: decision.OPPORTUNITY_SCORE,
                            confidenceAtEntry: decision.CONFIDENCE_SCORE
                        });
                        pos.tier = decision.TIER;
                        openPositions.set(mint, positionId);

                        entryEvents.push({
                            position_id: positionId,
                            token: mint,
                            timestamp: currentTime,
                            price: entryPrice,
                            size: sizeSol,
                            tier: decision.TIER
                        });
                    }
                }
            }
        }
    }

    // Diagnostics calculation
    const trades = entryEvents.map(e => {
        const exit = exitEvents.find(x => x.position_id === e.position_id);
        const pnlSol = exit ? exit.realized_pnl : 0;
        const pnlPct = exit ? exit.final_pnl_pct * 100 : 0;
        const posUpdates = positionEvents.filter(p => p.position_id === e.position_id);
        const lastPos = posUpdates[posUpdates.length - 1];
        const mfe = lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0;
        const mae = lastPos ? lastPos.mae.maxAdversePercent * 100 : 0;
        return {
            token: e.token,
            tier: e.tier,
            size: e.size,
            pnlSol,
            pnlPct,
            mfe,
            mae,
            exitReason: exit?.exit_reason
        };
    });

    const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
    const wins = trades.filter(t => t.pnlSol > 0);
    const losses = trades.filter(t => t.pnlSol <= 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;
    const maxDd = trades.length > 0 ? Math.min(0, ...trades.map(t => t.pnlPct)) : 0;

    // MFE Capture Ratio
    const profitableExcursions = trades.filter(t => t.mfe >= 5);
    const monetizedExcursions = profitableExcursions.filter(t => t.pnlSol > 0);
    const totalPotentialMfeSol = trades.reduce((s, t) => s + (t.mfe / 100 * t.size), 0);
    const mfeCaptureRatio = totalPotentialMfeSol > 0 ? (grossProfit / totalPotentialMfeSol) * 100 : 0;
    const givebackCount = trades.filter(t => t.mfe >= 10 && t.pnlSol <= 0).length;

    return {
        profileName,
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: Number((trades.length > 0 ? (wins.length / trades.length) * 100 : 0).toFixed(1)),
        grossProfit: Number(grossProfit.toFixed(4)),
        grossLoss: Number(grossLoss.toFixed(4)),
        netPnlSol: Number(totalPnl.toFixed(4)),
        profitFactor: Number(profitFactor.toFixed(2)),
        expectancySol: Number(expectancy.toFixed(4)),
        maxDrawdownPct: Number(maxDd.toFixed(1)),
        mfeCaptureRatioPct: Number(mfeCaptureRatio.toFixed(1)),
        monetizedRatio: `${monetizedExcursions.length} / ${profitableExcursions.length}`,
        givebackCount,
        trades
    };
}

// 1. Profile A: Baseline V2.2 (TP +40%, size 50%)
const profA = testExitProfile('Profile A (V2.2 Baseline: TP +40%)', (pm) => {});

// 2. Profile B: Early Harvest (+15% TP, size 40%)
const profB = testExitProfile('Profile B (Early Harvest: TP +15%)', (pm) => {
    pm.config.initialProfitTargetPct = 0.15;
    pm.config.partialExitFraction = 0.40;
});

// 3. Profile C: Tier C Proportional Scaling (TP +18%, Break-even Arming at +10%)
const profC = testExitProfile('Profile C (Proportional Harvest: +18% TP, BE arm)', (pm) => {
    pm.config.initialProfitTargetPct = 0.18;
    pm.config.partialExitFraction = 0.50;
    
    // Add break-even stop logic
    const origExit = pm._evaluateExitPriority.bind(pm);
    pm._evaluateExitPriority = function (pos, marketState, elapsedSeconds, currentTime) {
        // If trade reached +12% MFE, protect capital: do not let it drop below -1%
        if (pos.mfe.maxFavorablePercent >= 0.12 && pos.unrealized_pnl_pct <= -0.01) {
            return { type: 'FULL_EXIT', reason: 'BREAKEVEN_PROTECTION' };
        }
        return origExit(pos, marketState, elapsedSeconds, currentTime);
    };
});

// 4. Profile D: Adaptive Momentum Harvest
const profD = testExitProfile('Profile D (Momentum Adaptive Ladder)', (pm) => {
    const origExit = pm._evaluateExitPriority.bind(pm);
    pm._evaluateExitPriority = function (pos, marketState, elapsedSeconds, currentTime) {
        // If thesis weakening or velocity negative, harvest earlier at +12%
        const pm10 = marketState.priceMomentum?.['10s'];
        const isSlowing = pos.thesis_state === 'THESIS_WEAKENING' || (pm10 && pm10.priceVelocity?.value < 0);
        
        if (pos.stage === 'INITIAL_POSITION') {
            const targetPct = isSlowing ? 0.14 : 0.25;
            if (pos.unrealized_pnl_pct >= targetPct) {
                return {
                    type: 'PARTIAL_EXIT',
                    fraction: 0.50,
                    reason: isSlowing ? 'ADAPTIVE_DEFENSIVE_HARVEST' : 'ADAPTIVE_MOMENTUM_HARVEST'
                };
            }
        }

        // Breakeven arming after +12% MFE
        if (pos.mfe.maxFavorablePercent >= 0.12 && pos.unrealized_pnl_pct <= -0.01) {
            return { type: 'FULL_EXIT', reason: 'BREAKEVEN_PROTECTION' };
        }

        return origExit(pos, marketState, elapsedSeconds, currentTime);
    };
});

console.log('\n========================================================================================================');
console.log('EXIT PROFILE CALIBRATION MATRIX (35-TOKEN DEV SET):');
console.log('Profile                         | Win Rate | Net PnL (SOL) | Profit Factor | Expectancy | MFE Capture | Givebacks');
console.log('========================================================================================================');
[profA, profB, profC, profD].forEach(p => {
    console.log(`${p.profileName.padEnd(31)} | ${(p.winRate + '%').padEnd(8)} | ${(p.netPnlSol >= 0 ? '+' : '') + p.netPnlSol.toFixed(4).padEnd(13)} | ${p.profitFactor.toFixed(2).padEnd(13)} | ${(p.expectancySol >= 0 ? '+' : '') + p.expectancySol.toFixed(4).padEnd(10)} | ${(p.mfeCaptureRatioPct + '%').padEnd(11)} | ${p.givebackCount}`);
});
console.log('========================================================================================================\n');
