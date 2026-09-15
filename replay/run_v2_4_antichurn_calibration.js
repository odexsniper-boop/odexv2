import fs from 'fs';
import { StrategyOrchestratorV2_3 } from '../engines/v2/strategyOrchestratorV2_3.js';
import { StrategyOrchestratorV2_4 } from '../engines/v2/strategyOrchestratorV2_4.js';

export function runAntichurnCalibration() {
    console.log('===============================================================');
    console.log('KO V3: V2.4 ANTI-CHURN & TOKEN RE-ENTRY CALIBRATION');
    console.log('DATASET: 35-TOKEN EXPANDED DEV SET (replay/raw_txs_expanded_35.json)');
    console.log('===============================================================\n');

    const devFile = 'replay/raw_txs_expanded_35.json';
    const devTxs = JSON.parse(fs.readFileSync(devFile, 'utf8'));
    devTxs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const uniqueMints = Array.from(new Set(devTxs.map(t => t.test_mint_context || t.token)));

    console.log(`Development dataset loaded: ${devTxs.length} transactions across ${uniqueMints.length} tokens.\n`);

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
        const topUser = Object.entries(userCounts).sort((a,b)=>b[1]-a[1])[0];
        const topAta = Object.entries(ataCounts).sort((a,b)=>b[1]-a[1])[0];
        if (topUser && topAta) curves[m] = { pda: topUser[0], ata: topAta[0] };
    }

    // 2. Simulation Runner Helper
    function simulateOrchestrator(name, OrchestratorClass, config = {}) {
        const orch = new OrchestratorClass({
            standardSizeSol: 0.10,
            probeSizeSol: 0.025,
            ...config
        });

        for (const tx of devTxs) {
            const m = tx.test_mint_context || tx.token;
            const curve = curves[m];
            if (!curve) continue;
            orch.processTransaction(tx, m, curve.pda, curve.ata);
        }

        const entries = orch.entryEvents;
        const exits = orch.exitEvents;
        const positions = orch.positionEvents;
        const blocked = orch.blockedReentries || [];

        // Verify zero-lookahead
        let lookaheadViolations = 0;
        for (const p of positions) {
            if (p.mae.timestamp > p.timestamp || p.mfe.timestamp > p.timestamp) {
                lookaheadViolations++;
            }
        }

        const trades = entries.map(e => {
            const exit = exits.find(x => x.position_id === e.position_id);
            const pnlSol = exit ? exit.realized_pnl : 0;
            const pnlPct = exit ? exit.final_pnl_pct * 100 : 0;

            const posUpdates = positions.filter(p => p.position_id === e.position_id);
            const lastPos = posUpdates.length > 0 ? posUpdates[posUpdates.length - 1] : null;

            return {
                positionId: e.position_id,
                token: e.token,
                entryTime: e.timestamp,
                tier: e.tier,
                size: e.size,
                entryPrice: e.price,
                exitPrice: exit?.exit_price,
                exitTime: exit?.exit_timestamp,
                opportunity: e.opportunity,
                confidence: e.confidence,
                pnlSol,
                pnlPct,
                exitReason: exit?.exit_reason,
                mae: lastPos ? lastPos.mae.maxAdversePercent * 100 : 0,
                mfe: lastPos ? lastPos.mfe.maxFavorablePercent * 100 : 0,
                thesisState: lastPos?.thesis_state,
                holdTimeSeconds: exit && e.timestamp ? (exit.exit_timestamp - e.timestamp) : 0
            };
        });

        const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
        const wins = trades.filter(t => t.pnlSol > 0);
        const losses = trades.filter(t => t.pnlSol <= 0);
        const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;
        const pnlPcts = trades.map(t => t.pnlPct);
        const maxDrawdown = pnlPcts.length > 0 ? Math.min(0, ...pnlPcts) : 0;

        // Churn & Token concentration metrics
        const tokensTradedMap = {};
        trades.forEach(t => {
            tokensTradedMap[t.token] = (tokensTradedMap[t.token] || 0) + 1;
        });
        const uniqueTokensTraded = Object.keys(tokensTradedMap).length;
        const tradeCounts = Object.values(tokensTradedMap);
        const maxTradesPerToken = tradeCounts.length > 0 ? Math.max(...tradeCounts) : 0;
        const avgTradesPerToken = tradeCounts.length > 0 ? tradeCounts.reduce((a,b)=>a+b, 0) / tradeCounts.length : 0;
        const reenteredTokensCount = tradeCounts.filter(c => c > 1).length;
        const sameTokenReentryRate = uniqueTokensTraded > 0 ? (reenteredTokensCount / uniqueTokensTraded) * 100 : 0;

        // Consecutive loss sequences per token
        let maxConsecutiveLossesPerToken = 0;
        for (const [m, count] of Object.entries(tokensTradedMap)) {
            const tList = trades.filter(t => t.token === m);
            let currentLossStreak = 0;
            tList.forEach(t => {
                if (t.pnlSol <= 0) {
                    currentLossStreak++;
                    if (currentLossStreak > maxConsecutiveLossesPerToken) maxConsecutiveLossesPerToken = currentLossStreak;
                } else {
                    currentLossStreak = 0;
                }
            });
        }

        // Givebacks (>10% MFE decaying into loss)
        const givebacks = trades.filter(t => t.mfe >= 10.0 && t.pnlPct <= 0).length;

        return {
            name,
            totalTrades: trades.length,
            uniqueTokensTraded,
            avgTradesPerToken,
            maxTradesPerToken,
            sameTokenReentryRate,
            maxConsecutiveLossesPerToken,
            wins: wins.length,
            losses: losses.length,
            winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
            grossProfit,
            grossLoss,
            netPnlSol: totalPnl,
            profitFactor,
            expectancySol: expectancy,
            maxDrawdownPct: maxDrawdown,
            givebacksCount: givebacks,
            blockedReentriesCount: blocked.length,
            lookaheadViolations,
            trades,
            blockedReentries: blocked
        };
    }

    // Run Experiment Matrix
    console.log('Running Calibration Experiment Matrix...');

    // Profile A: V2.3 Frozen Baseline (No Anti-Churn Guard)
    const profileA = simulateOrchestrator('Profile A: V2.3 Baseline (No Guard)', StrategyOrchestratorV2_3);

    // Profile B: Fixed Cooldown Only (60s fixed cooldown, no progressive, no thesis reset)
    const profileB = simulateOrchestrator('Profile B: Fixed Cooldown (60s)', StrategyOrchestratorV2_4, {
        enableReentryGuard: true,
        enableExposureManager: false,
        reentryConfig: {
            cooldownHardSafetySeconds: 60,
            cooldownFlowFailureSeconds: 60,
            cooldownBreakevenSeconds: 60,
            cooldownTrailingSeconds: 60,
            cooldownDefaultSeconds: 60,
            progressiveMultiplier: 1.0, // Fixed
            requireThesisReset: false,
            minExitDebounceSeconds: 5
        }
    });

    // Profile C: Progressive Cooldown Only (Exit-reason aware + progressive multiplier, no thesis reset)
    const profileC = simulateOrchestrator('Profile C: Progressive Cooldown', StrategyOrchestratorV2_4, {
        enableReentryGuard: true,
        enableExposureManager: false,
        reentryConfig: {
            cooldownHardSafetySeconds: 120,
            cooldownFlowFailureSeconds: 45,
            cooldownBreakevenSeconds: 15,
            cooldownTrailingSeconds: 10,
            cooldownDefaultSeconds: 30,
            progressiveMultiplier: 1.5,
            requireThesisReset: false,
            minExitDebounceSeconds: 5
        }
    });

    // Profile D: Cooldown + Thesis Reset
    const profileD = simulateOrchestrator('Profile D: Cooldown + Thesis Reset', StrategyOrchestratorV2_4, {
        enableReentryGuard: true,
        enableExposureManager: false,
        reentryConfig: {
            cooldownHardSafetySeconds: 120,
            cooldownFlowFailureSeconds: 45,
            cooldownBreakevenSeconds: 15,
            cooldownTrailingSeconds: 10,
            cooldownDefaultSeconds: 30,
            progressiveMultiplier: 1.5,
            requireThesisReset: true,
            minExitDebounceSeconds: 5
        }
    });

    // Profile E: Cooldown + Thesis Reset + Token Risk Budget (Complete V2.4 Candidate)
    const profileE = simulateOrchestrator('Profile E: Cooldown + Reset + Risk Budget (V2.4 Candidate)', StrategyOrchestratorV2_4, {
        enableReentryGuard: true,
        enableExposureManager: true,
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
        exposureConfig: {
            maxCumulativeExposureSol: 0.30,
            maxConsecutiveLosses: 2,
            maxLifetimeEntries: 3,
            maxCumulativeLossSol: 0.05
        }
    });

    // Verify Bit-for-Bit Determinism on Profile E
    console.log('Verifying Bit-for-Bit Determinism on Profile E...');
    const profileE_Run2 = simulateOrchestrator('Profile E Run 2', StrategyOrchestratorV2_4, {
        enableReentryGuard: true,
        enableExposureManager: true,
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
        exposureConfig: {
            maxCumulativeExposureSol: 0.30,
            maxConsecutiveLosses: 2,
            maxLifetimeEntries: 3,
            maxCumulativeLossSol: 0.05
        }
    });

    const isDeterministic = JSON.stringify(profileE.trades) === JSON.stringify(profileE_Run2.trades);
    console.log(`Determinism Validation: ${isDeterministic ? 'PASS' : 'FAIL'}\n`);

    // Output Table for Dev 35
    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log('V2.4 ANTI-CHURN CALIBRATION MATRIX (35-TOKEN DEV SET):');
    console.log('Configuration                         | Trades | Max Trades/Tok | Win Rate | Net PnL (SOL) | PF    | Exp (SOL) | Consec Loss');
    console.log('-----------------------------------------------------------------------------------------------------------------');
    const profiles = [profileA, profileB, profileC, profileD, profileE];
    profiles.forEach(p => {
        console.log(`${p.name.padEnd(38)} | ${p.totalTrades.toString().padEnd(6)} | ${p.maxTradesPerToken.toString().padEnd(14)} | ${(p.winRate.toFixed(1)+'%').padEnd(8)} | ${(p.netPnlSol >= 0 ? '+' : '') + p.netPnlSol.toFixed(4).padEnd(13)} | ${p.profitFactor.toFixed(2).padEnd(5)} | ${(p.expectancySol >= 0 ? '+' : '') + p.expectancySol.toFixed(4).padEnd(9)} | ${p.maxConsecutiveLossesPerToken}`);
    });
    console.log('-----------------------------------------------------------------------------------------------------------------\n');

    // 3. Shadow Mode Stream Evaluation
    console.log('Replaying Live Shadow Mode Stream through V2.4 Anti-Churn Policies...');
    const shadowTrades = JSON.parse(fs.readFileSync('validation/v2/shadow_mode_trades.json', 'utf8'));
    shadowTrades.sort((a, b) => a.entry_timestamp - b.entry_timestamp);

    function replayShadowPolicy(name, config) {
        const tokenState = {};
        const accepted = [];
        const rejected = [];

        for (const t of shadowTrades) {
            const m = t.token;
            if (!tokenState[m]) {
                tokenState[m] = {
                    entries: 0,
                    consecutiveLosses: 0,
                    lastExitTime: 0,
                    cooldownExpiry: 0,
                    locked: false,
                    lockReason: null
                };
            }
            const s = tokenState[m];
            let allow = true;
            let rejectReason = null;

            if (config.enableExposure) {
                if (s.locked) {
                    allow = false;
                    rejectReason = s.lockReason;
                } else if (s.consecutiveLosses >= config.maxConsecutiveLosses) {
                    s.locked = true;
                    s.lockReason = `CONSECUTIVE_LOSS_LIMIT (${s.consecutiveLosses})`;
                    allow = false;
                    rejectReason = s.lockReason;
                } else if (s.entries >= config.maxLifetimeEntries) {
                    s.locked = true;
                    s.lockReason = `MAX_LIFETIME_ENTRIES (${s.entries})`;
                    allow = false;
                    rejectReason = s.lockReason;
                }
            }

            if (allow && config.enableCooldown) {
                const elapsed = t.entry_timestamp - s.lastExitTime;
                const debounceReq = t.exit_reason === 'TRAILING_EXIT' ? 0 : (config.minDebounce || 2);
                if (s.lastExitTime > 0 && debounceReq > 0 && elapsed < debounceReq) {
                    allow = false;
                    rejectReason = `DEBOUNCE (${elapsed}s < ${debounceReq}s)`;
                } else if (t.entry_timestamp < s.cooldownExpiry) {
                    allow = false;
                    rejectReason = `IN_COOLDOWN (${s.cooldownExpiry - t.entry_timestamp}s remaining)`;
                }
            }

            if (allow) {
                accepted.push(t);
                s.entries++;
                const exitTime = t.exit_timestamp || (t.entry_timestamp + (t.hold_time_seconds || 5));
                const pnl = t.realized_pnl_execution_adjusted_sol !== undefined ? t.realized_pnl_execution_adjusted_sol : t.realized_pnl_market_sol;
                s.lastExitTime = exitTime;
                if (pnl > 0) s.consecutiveLosses = 0;
                else s.consecutiveLosses++;

                let baseCooldown = config.cooldownDefault || 30;
                if (t.exit_reason === 'HARD_SAFETY') baseCooldown = config.cooldownHardSafety || 60;
                else if (t.exit_reason === 'FLOW_FAILURE') baseCooldown = config.cooldownFlowFailure || 30;
                else if (t.exit_reason === 'BREAKEVEN_PROTECTION') baseCooldown = config.cooldownBreakeven || 10;
                else if (t.exit_reason === 'TRAILING_EXIT') baseCooldown = config.cooldownTrailing || 5;

                const mult = s.consecutiveLosses > 1 ? Math.pow(config.progMult || 1.5, s.consecutiveLosses - 1) : 1.0;
                s.cooldownExpiry = exitTime + Math.round(baseCooldown * mult);

                if (config.enableExposure) {
                    if (s.consecutiveLosses >= config.maxConsecutiveLosses) {
                        s.locked = true;
                        s.lockReason = `CONSECUTIVE_LOSS_LIMIT (${s.consecutiveLosses})`;
                    } else if (s.entries >= config.maxLifetimeEntries) {
                        s.locked = true;
                        s.lockReason = `MAX_LIFETIME_ENTRIES (${s.entries})`;
                    }
                }
            } else {
                rejected.push({ trade: t, reason: rejectReason });
            }
        }

        const closed = accepted.filter(t => t.status === 'CLOSED');
        const marketPnl = closed.reduce((s, t) => s + (t.realized_pnl_market_sol || 0), 0);
        const execPnl = closed.reduce((s, t) => s + (t.realized_pnl_execution_adjusted_sol || 0), 0);
        const wins = closed.filter(t => (t.realized_pnl_execution_adjusted_sol || 0) > 0);
        const losses = closed.filter(t => (t.realized_pnl_execution_adjusted_sol || 0) <= 0);
        const grossProfit = wins.reduce((s, t) => s + t.realized_pnl_execution_adjusted_sol, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realized_pnl_execution_adjusted_sol, 0));
        const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

        const tokCounts = {};
        accepted.forEach(t => { tokCounts[t.token] = (tokCounts[t.token] || 0) + 1; });
        const maxTradesPerTok = Math.max(0, ...Object.values(tokCounts));

        return {
            name,
            totalEntries: accepted.length,
            closedTrades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) + '%' : '0%',
            marketPnlSol: marketPnl,
            execPnlSol: execPnl,
            profitFactor: pf,
            maxTradesPerTok,
            rejectedTradesCount: rejected.length
        };
    }

    const shadowA = replayShadowPolicy('Shadow Profile A: V2.3 Baseline (No Guard)', { enableExposure: false, enableCooldown: false });
    const shadowB = replayShadowPolicy('Shadow Profile B: Fixed Cooldown (60s)', { enableExposure: false, enableCooldown: true, minDebounce: 5, cooldownDefault: 60, cooldownHardSafety: 60, cooldownFlowFailure: 60, cooldownBreakeven: 60, cooldownTrailing: 60, progMult: 1.0 });
    const shadowC = replayShadowPolicy('Shadow Profile C: Progressive Cooldown', { enableExposure: false, enableCooldown: true, minDebounce: 2, cooldownDefault: 30, cooldownHardSafety: 60, cooldownFlowFailure: 30, cooldownBreakeven: 10, cooldownTrailing: 5, progMult: 1.5 });
    const shadowE = replayShadowPolicy('Shadow Profile E: V2.4 Candidate (Reentry + Risk Budget)', { enableExposure: true, maxConsecutiveLosses: 2, maxLifetimeEntries: 3, enableCooldown: true, minDebounce: 2, cooldownDefault: 30, cooldownHardSafety: 60, cooldownFlowFailure: 30, cooldownBreakeven: 10, cooldownTrailing: 5, progMult: 1.5 });

    console.log('-----------------------------------------------------------------------------------------------------------------');
    console.log('LIVE SHADOW MODE REPLAY COMPARISON (186 LIVE TRADES):');
    console.log('Configuration                         | Entries | Closed | Win Rate | Market PnL   | Exec PnL     | PF   | Max/Tok');
    console.log('-----------------------------------------------------------------------------------------------------------------');
    const shadowProfiles = [shadowA, shadowB, shadowC, shadowE];
    shadowProfiles.forEach(s => {
        console.log(`${s.name.padEnd(38)} | ${s.totalEntries.toString().padEnd(7)} | ${s.closedTrades.toString().padEnd(6)} | ${s.winRate.padEnd(8)} | ${(s.marketPnlSol >= 0 ? '+' : '') + s.marketPnlSol.toFixed(4).padEnd(12)} | ${(s.execPnlSol >= 0 ? '+' : '') + s.execPnlSol.toFixed(4).padEnd(12)} | ${s.profitFactor.toFixed(2).padEnd(4)} | ${s.maxTradesPerTok}`);
    });
    console.log('-----------------------------------------------------------------------------------------------------------------\n');

    // Save Output JSON
    const calibrationOutput = {
        meta: {
            dataset: devFile,
            calibration_date: new Date().toISOString(),
            determinism: isDeterministic ? 'PASS' : 'FAIL'
        },
        profiles: {
            profileA_v2_3_baseline: profileA,
            profileB_fixed_cooldown: profileB,
            profileC_progressive_cooldown: profileC,
            profileD_cooldown_thesis_reset: profileD,
            profileE_v2_4_candidate: profileE
        },
        shadow_profiles: {
            shadowA_v2_3_baseline: shadowA,
            shadowB_fixed_cooldown: shadowB,
            shadowC_progressive_cooldown: shadowC,
            shadowE_v2_4_candidate: shadowE
        }
    };

    fs.writeFileSync('validation/v2/v2_4_antichurn_calibration.json', JSON.stringify(calibrationOutput, null, 2));
    console.log('Saved validation/v2/v2_4_antichurn_calibration.json successfully.');

    return calibrationOutput;
}

runAntichurnCalibration();
