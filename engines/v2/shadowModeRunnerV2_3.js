import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { StrategyOrchestratorV2_3 } from './strategyOrchestratorV2_3.js';
import { getBondingCurvePDA, getAssociatedBondingCurvePDA } from '../../pumpfun.js';

export class V2ShadowRunner {
    constructor(options = {}) {
        this.options = {
            configPath: options.configPath || 'validation/v2/shadow_mode_config.json',
            metricsPath: options.metricsPath || 'validation/v2/shadow_mode_metrics.json',
            eventsPath: options.eventsPath || 'validation/v2/shadow_mode_events.json',
            tradesPath: options.tradesPath || 'validation/v2/shadow_mode_trades.json',
            killSwitchPath: options.killSwitchPath || 'validation/v2/shadow_kill_switch.flag',
            heliusKey: process.env.HELIUS_API_KEY || '5512b207-b344-4c60-9b75-6f0dfc57b674',
            pollIntervalMs: options.pollIntervalMs || 1200,
            maxEventsToProcess: options.maxEventsToProcess || Infinity,
            ...options
        };

        // SAFETY ENFORCEMENT: Never allow real execution in shadow runner
        this.strategyMode = 'V2_SHADOW';
        this.executionMode = 'SHADOW';
        this.executionBlocked = true;

        // Frozen V2.3 Strategy Orchestrator instance
        this.orchestrator = new StrategyOrchestratorV2_3({
            standardSizeSol: 0.10,
            probeSizeSol: 0.025
        });

        // Tracking state
        this.seenSignatures = new Set();
        this.curveCache = new Map(); // mint -> { pda, ata }
        this.tokensObserved = new Set();
        this.allCandidatesEvaluated = [];
        this.hypotheticalTrades = [];
        this.shadowEventsLog = [];
        this.latencyMeasurements = [];
        this.dataIntegrityIssues = [];
        this.duplicateEventsCount = 0;
        this.droppedEventsCount = 0;

        this.isRunning = false;
        this.startTime = Date.now();
        this.lastPollTime = 0;
    }

    checkKillSwitch() {
        if (fs.existsSync(this.options.killSwitchPath)) {
            return true;
        }
        return false;
    }

    triggerKillSwitch(reason = 'MANUAL_TRIGGER') {
        fs.writeFileSync(this.options.killSwitchPath, JSON.stringify({
            triggered_at: new Date().toISOString(),
            reason,
            action: 'HALT_SHADOW_RUNNER'
        }, null, 2));
        console.log(`[SHADOW KILL SWITCH ACTIVATED]: ${reason}`);
    }

    clearKillSwitch() {
        if (fs.existsSync(this.options.killSwitchPath)) {
            fs.unlinkSync(this.options.killSwitchPath);
            console.log('[SHADOW KILL SWITCH CLEARED]');
        }
    }

    getCurveAddresses(mintStr) {
        if (this.curveCache.has(mintStr)) {
            return this.curveCache.get(mintStr);
        }
        try {
            const mintPub = new PublicKey(mintStr);
            const pda = getBondingCurvePDA(mintPub);
            const ata = getAssociatedBondingCurvePDA(mintPub, pda);
            const res = { pda: pda.toBase58(), ata: ata.toBase58() };
            this.curveCache.set(mintStr, res);
            return res;
        } catch (err) {
            this.dataIntegrityIssues.push({
                type: 'PDA_DERIVATION_ERROR',
                mint: mintStr,
                error: err.message,
                timestamp: Date.now()
            });
            return null;
        }
    }

    async processLiveTx(tx, receiptTimestamp = Date.now()) {
        const sig = tx.signature;
        if (!sig) return null;

        // Duplicate event check
        if (this.seenSignatures.has(sig)) {
            this.duplicateEventsCount++;
            return null;
        }
        this.seenSignatures.add(sig);

        // Limit signature cache size
        if (this.seenSignatures.size > 10000) {
            const first = this.seenSignatures.values().next().value;
            this.seenSignatures.delete(first);
        }

        // Measure blockchain -> provider -> receiver latency
        const blockTimestampMs = (tx.timestamp || 0) * 1000;
        const totalPipelineLatencyMs = blockTimestampMs > 0 ? (receiptTimestamp - blockTimestampMs) : 0;
        const processingStart = Date.now();

        // Find relevant pump tokens in transfers
        const transfers = (tx.tokenTransfers || []).filter(t => t.mint && t.mint.endsWith('pump'));
        if (transfers.length === 0) return null;

        const results = [];

        for (const t of transfers) {
            const mint = t.mint;
            this.tokensObserved.add(mint);

            const curves = this.getCurveAddresses(mint);
            if (!curves) continue;

            tx.test_mint_context = mint;

            // Run through exact canonical classifier and orchestrator
            const orchRes = this.orchestrator.processTransaction(tx, mint, curves.pda, curves.ata);
            const decisionEnd = Date.now();
            const decisionLatencyMs = decisionEnd - processingStart;

            this.latencyMeasurements.push({
                signature: sig,
                mint,
                blockTime: tx.timestamp,
                receiptTime: receiptTimestamp,
                pipelineLatencyMs: totalPipelineLatencyMs,
                decisionLatencyMs,
                timestamp: decisionEnd
            });

            // Log classified events
            if (orchRes && orchRes.classifiedEvents) {
                for (const ce of orchRes.classifiedEvents) {
                    this.shadowEventsLog.push({
                        event_type: ce.classification,
                        canonical_event_id: ce.canonical_event_id,
                        mint,
                        slot: ce.slot,
                        timestamp: ce.event_time,
                        side: ce.side,
                        solAmount: ce.cleanSOLVolume,
                        tokenAmount: ce.cleanTokenVolume,
                        effectivePrice: ce.effectivePrice,
                        initiator: ce.initiator,
                        pipelineLatencyMs: totalPipelineLatencyMs
                    });
                }
            }

            // Capture hypothetical entries/exits
            if (orchRes && orchRes.results) {
                for (const r of orchRes.results) {
                    if (r.type === 'ENTRY') {
                        const e = r.event;
                        const slippageFactor = 1.015; // +1.5% slippage estimation on entry buy
                        const expectedFillPrice = e.price * slippageFactor;
                        const executionLatencyMs = 200 + Math.floor(Math.random() * 80); // 200-280ms RPC turnaround

                        const hypoTrade = {
                            strategy_mode: this.strategyMode,
                            execution_mode: this.executionMode,
                            position_id: e.position_id,
                            token: e.token,
                            entry_timestamp: e.timestamp,
                            entry_price_market: e.price,
                            entry_price_expected_fill: expectedFillPrice,
                            estimated_entry_slippage_pct: 1.5,
                            estimated_execution_latency_ms: executionLatencyMs,
                            tier: e.tier,
                            size_sol: e.size,
                            opportunity_at_entry: e.opportunity,
                            confidence_at_entry: e.confidence,
                            hard_safety_status: e.hard_safety_status,
                            confluence: e.confluence,
                            reasons: e.reason_codes,
                            status: 'OPEN',
                            mfe_pct: 0,
                            mae_pct: 0,
                            realized_pnl_market_sol: 0,
                            realized_pnl_execution_adjusted_sol: 0,
                            exit_reason: null,
                            exit_price: null,
                            exit_timestamp: null,
                            hold_time_seconds: 0
                        };
                        this.hypotheticalTrades.push(hypoTrade);
                        console.log(`[SHADOW ENTRY] ${e.token.slice(0, 8)} | Tier ${e.tier} (${e.size} SOL) @ ${e.price.toFixed(9)} SOL | Opp: ${e.opportunity}, Conf: ${e.confidence}`);
                    } else if (r.type === 'EXIT') {
                        const x = r.event;
                        const matchedTrade = this.hypotheticalTrades.find(t => t.position_id === x.position_id);
                        if (matchedTrade) {
                            const exitSlippageFactor = 0.985; // -1.5% slippage estimation on sell exit
                            const expectedExitPrice = x.exit_price * exitSlippageFactor;
                            const totalFeesSol = 0.000005 + 0.001; // Base fee + priority tip

                            const rawSolDelta = (x.exit_price - matchedTrade.entry_price_market) / matchedTrade.entry_price_market * matchedTrade.size_sol;
                            const adjustedSolDelta = ((expectedExitPrice - matchedTrade.entry_price_expected_fill) / matchedTrade.entry_price_expected_fill * matchedTrade.size_sol) - totalFeesSol;

                            matchedTrade.status = 'CLOSED';
                            matchedTrade.exit_price_market = x.exit_price;
                            matchedTrade.exit_price_expected_fill = expectedExitPrice;
                            matchedTrade.exit_timestamp = x.exit_timestamp;
                            matchedTrade.exit_reason = x.exit_reason;
                            matchedTrade.hold_time_seconds = (x.exit_timestamp - matchedTrade.entry_timestamp);
                            matchedTrade.realized_pnl_market_sol = rawSolDelta;
                            matchedTrade.realized_pnl_execution_adjusted_sol = adjustedSolDelta;
                            matchedTrade.final_pnl_pct = x.final_pnl_pct * 100;

                            console.log(`[SHADOW EXIT] ${x.token.slice(0, 8)} | Reason: ${x.exit_reason} | Market PnL: ${rawSolDelta >= 0 ? '+' : ''}${rawSolDelta.toFixed(4)} SOL | Exec-Adj PnL: ${adjustedSolDelta >= 0 ? '+' : ''}${adjustedSolDelta.toFixed(4)} SOL`);
                        }
                    }
                }
            }
        }

        // Limit log arrays in memory
        if (this.shadowEventsLog.length > 5000) {
            this.shadowEventsLog = this.shadowEventsLog.slice(-5000);
        }
        if (this.latencyMeasurements.length > 5000) {
            this.latencyMeasurements = this.latencyMeasurements.slice(-5000);
        }

        return results;
    }

    async pollHeliusRecentTxs() {
        const url = `https://api.helius.xyz/v0/addresses/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P/transactions?api-key=${this.options.heliusKey}&limit=25`;
        try {
            const receiptTime = Date.now();
            const res = await fetch(url);
            if (res.status === 429) {
                this.dataIntegrityIssues.push({
                    type: 'RATE_LIMIT_429',
                    timestamp: receiptTime
                });
                return;
            }
            const txs = await res.json();
            if (Array.isArray(txs)) {
                // Process in chronological order (oldest to newest)
                txs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                for (const tx of txs) {
                    await this.processLiveTx(tx, receiptTime);
                }
            }
        } catch (err) {
            this.dataIntegrityIssues.push({
                type: 'POLL_FETCH_ERROR',
                error: err.message,
                timestamp: Date.now()
            });
        }
    }

    computeMetrics() {
        const now = Date.now();
        const durationSec = Math.floor((now - this.startTime) / 1000);

        // Latency percentiles
        const pLatencies = this.latencyMeasurements.map(m => m.pipelineLatencyMs).filter(l => l > 0).sort((a,b)=>a-b);
        const meanLatency = pLatencies.length > 0 ? (pLatencies.reduce((s,l)=>s+l, 0) / pLatencies.length) : 0;
        const medianLatency = pLatencies.length > 0 ? pLatencies[Math.floor(pLatencies.length * 0.50)] : 0;
        const p95Latency = pLatencies.length > 0 ? pLatencies[Math.floor(pLatencies.length * 0.95)] : 0;
        const p99Latency = pLatencies.length > 0 ? pLatencies[Math.floor(pLatencies.length * 0.99)] : 0;
        const worstLatency = pLatencies.length > 0 ? pLatencies[pLatencies.length - 1] : 0;

        // Trade performance
        const closedTrades = this.hypotheticalTrades.filter(t => t.status === 'CLOSED');
        const openTrades = this.hypotheticalTrades.filter(t => t.status === 'OPEN');
        const wins = closedTrades.filter(t => t.realized_pnl_market_sol > 0);
        const losses = closedTrades.filter(t => t.realized_pnl_market_sol <= 0);

        const marketGrossProfit = wins.reduce((s, t) => s + t.realized_pnl_market_sol, 0);
        const marketGrossLoss = Math.abs(losses.reduce((s, t) => s + t.realized_pnl_market_sol, 0));
        const marketNetPnl = marketGrossProfit - marketGrossLoss;
        const marketPf = marketGrossLoss > 0 ? (marketGrossProfit / marketGrossLoss) : (marketGrossProfit > 0 ? 999 : 0);
        const marketExp = closedTrades.length > 0 ? (marketNetPnl / closedTrades.length) : 0;

        // Execution-adjusted P&L
        const execGrossProfit = wins.reduce((s, t) => s + Math.max(0, t.realized_pnl_execution_adjusted_sol), 0);
        const execGrossLoss = Math.abs(losses.reduce((s, t) => s + Math.min(0, t.realized_pnl_execution_adjusted_sol), 0));
        const execNetPnl = closedTrades.reduce((s, t) => s + t.realized_pnl_execution_adjusted_sol, 0);
        const execPf = execGrossLoss > 0 ? (execGrossProfit / execGrossLoss) : (execGrossProfit > 0 ? 999 : 0);
        const execExp = closedTrades.length > 0 ? (execNetPnl / closedTrades.length) : 0;

        // Decision history analysis
        const decHist = this.orchestrator.decisionHistory;
        const candidatesEvaluated = decHist.length;
        const hardSafetyRejections = decHist.filter(d => d.decision?.HARD_SAFETY_STATUS === 'REJECT').length;
        const coordinationRejections = decHist.filter(d => d.decision?.REASON_CODES?.includes('extreme_coordination_cluster')).length;
        const buysGenerated = decHist.filter(d => d.decision?.DECISION === 'BUY').length;

        return {
            shadow_status: this.isRunning ? 'RUNNING' : 'HALTED',
            strategy_mode: this.strategyMode,
            execution_mode: this.executionMode,
            session_duration_seconds: durationSec,
            tokens_observed_count: this.tokensObserved.size,
            candidates_evaluated_count: candidatesEvaluated,
            buys_generated_count: buysGenerated,
            hypothetical_entries_count: this.hypotheticalTrades.length,
            hypothetical_exits_count: closedTrades.length,
            open_positions_count: openTrades.length,
            hard_safety_rejections: hardSafetyRejections,
            coordination_rejections: coordinationRejections,
            latency: {
                samples_count: pLatencies.length,
                mean_ms: Math.round(meanLatency),
                median_ms: Math.round(medianLatency),
                p95_ms: Math.round(p95Latency),
                p99_ms: Math.round(p99Latency),
                worst_ms: Math.round(worstLatency)
            },
            data_integrity: {
                duplicate_events_count: this.duplicateEventsCount,
                dropped_events_count: this.droppedEventsCount,
                integrity_incidents_count: this.dataIntegrityIssues.length,
                incidents: this.dataIntegrityIssues.slice(-20)
            },
            market_signal_performance: {
                closed_trades: closedTrades.length,
                wins: wins.length,
                losses: losses.length,
                win_rate_pct: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
                gross_profit_sol: marketGrossProfit,
                gross_loss_sol: marketGrossLoss,
                net_pnl_sol: marketNetPnl,
                profit_factor: marketPf,
                expectancy_sol: marketExp
            },
            execution_adjusted_performance: {
                gross_profit_sol: execGrossProfit,
                gross_loss_sol: execGrossLoss,
                net_pnl_sol: execNetPnl,
                profit_factor: execPf,
                expectancy_sol: execExp
            },
            kill_switch_active: this.checkKillSwitch(),
            last_updated: new Date().toISOString()
        };
    }

    saveState() {
        const metrics = this.computeMetrics();
        fs.writeFileSync(this.options.metricsPath, JSON.stringify(metrics, null, 2));
        fs.writeFileSync(this.options.tradesPath, JSON.stringify(this.hypotheticalTrades, null, 2));
        fs.writeFileSync(this.options.eventsPath, JSON.stringify(this.shadowEventsLog.slice(-500), null, 2));
    }

    async runSession(durationMs = 60000) {
        console.log('===============================================================');
        console.log('KO V3: LIVE SHADOW MODE ENGINE ACTIVATED');
        console.log(`STRATEGY: V2.3 (Adaptive Momentum Harvest) | MODE: ${this.strategyMode}`);
        console.log('SAFETY: REAL EXECUTION STRICTLY DISABLED (NO FUNDS / NO SIGNING)');
        console.log('===============================================================\n');

        this.isRunning = true;
        this.startTime = Date.now();
        const endTime = this.startTime + durationMs;

        while (this.isRunning && Date.now() < endTime) {
            if (this.checkKillSwitch()) {
                console.log('[SHADOW RUNNER] Kill switch detected! Halting immediately...');
                this.isRunning = false;
                break;
            }

            await this.pollHeliusRecentTxs();
            this.saveState();
            await new Promise(r => setTimeout(r, this.options.pollIntervalMs));
        }

        this.isRunning = false;
        this.saveState();
        console.log('\n[SHADOW RUNNER] Session completed successfully.');
        return this.computeMetrics();
    }
}
