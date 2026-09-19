import { EconomicEventClassifier } from './economicEventClassifierV2.js';
import { MarketStateBuilder } from './marketStateBuilderV2.js';
import { WalletRegistry } from './walletRegistryV2.js';
import { DecisionEngine } from './decisionEngineV2.js';
import { CoordinationRiskEngineV2_1 } from './coordinationRiskV2_1.js';
import { OpportunityScoreEngineV2_2 } from './opportunityScoreV2_2.js';
import { PositionManagerV2_3 } from './positionManagerV2_3.js';
import { ReentryGuardV2_4 } from './reentryGuardV2_4.js';
import { TokenExposureManagerV2_4 } from './tokenExposureManagerV2_4.js';

/**
 * Strategy Orchestrator V2.4 (Anti-Churn & Token Re-Entry Calibration)
 * 
 * Integrates:
 * - V2.2 Dynamic Relative Flow Opportunity Score Engine
 * - V2.1 Context-Aware Coordination Risk Engine
 * - V2.3 Adaptive Momentum Profit Ladder Position Manager
 * - V2.4 Re-Entry Guard (State-based, Exit-reason-aware, Progressive Cooldown, Thesis Reset)
 * - V2.4 Token Exposure Manager (Token Risk Budget & Cumulative Loss Protection)
 * - Hard Safety & Priority Inviolability
 * - Zero-Lookahead Compliant
 */

export class StrategyOrchestratorV2_4 {
    constructor(config = {}) {
        this.config = {
            standardSizeSol: config.standardSizeSol ?? 0.10,
            probeSizeSol: config.probeSizeSol ?? 0.025,
            
            // Anti-churn options
            enableReentryGuard: config.enableReentryGuard ?? true,
            enableExposureManager: config.enableExposureManager ?? true,
            reentryConfig: config.reentryConfig || {},
            exposureConfig: config.exposureConfig || {},
            ...config
        };

        this.classifier = new EconomicEventClassifier();
        this.walletRegistry = new WalletRegistry();
        this.marketStateBuilder = new MarketStateBuilder(this.walletRegistry);
        this.marketStateBuilder.coordinationRiskEngine = new CoordinationRiskEngineV2_1(this.walletRegistry);

        this.decisionEngine = new DecisionEngine();
        this.decisionEngine.opportunity = new OpportunityScoreEngineV2_2();

        this.positionManager = new PositionManagerV2_3({
            adaptiveFastProfitTargetPct: config.adaptiveFastProfitTargetPct ?? 0.30,
            adaptiveDefensiveProfitTargetPct: config.adaptiveDefensiveProfitTargetPct ?? 0.12,
            partialExitFraction: config.partialExitFraction ?? 0.50,
            breakevenArmMfePct: config.breakevenArmMfePct ?? 0.12,
            breakevenStopLossPct: config.breakevenStopLossPct ?? -0.01,
            maxHardLossPct: config.maxHardLossPct ?? -0.20,
            runnerTrailingPctStrong: config.runnerTrailingPctStrong ?? 0.12,
            runnerTrailingPctWeak: config.runnerTrailingPctWeak ?? 0.08
        });

        // Decision logic with Tier C Probing & dynamic flow awareness (Preserved from V2.3)
        const originalDecision = this.decisionEngine.evaluate.bind(this.decisionEngine);
        this.decisionEngine.evaluate = function (state) {
            const dec = originalDecision(state);
            const crObj = state.coordinationRisk?.['10s'];
            const level = crObj?.level ?? 'LOW';

            if (level === 'EXTREME') {
                dec.DECISION = 'REJECT';
                dec.TIER = 'REJECT';
                dec.REASON_CODES.push('extreme_coordination_cluster');
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

        // V2.4 Anti-Churn Modules
        this.reentryGuard = new ReentryGuardV2_4(this.config.reentryConfig);
        this.exposureManager = new TokenExposureManagerV2_4(this.config.exposureConfig);

        this.openPositions = new Map();
        this.entryEvents = [];
        this.positionEvents = [];
        this.exitEvents = [];
        this.decisionHistory = [];
        this.blockedReentries = [];
    }

    processTransaction(tx, mint, curvePda, curveTokenAccount) {
        const classifiedEvents = this.classifier.classifyTransaction(tx, mint, curvePda, curveTokenAccount);
        const results = [];

        for (const event of classifiedEvents) {
            if (event.classification === 'ECONOMIC_TRADE' || event.classification === 'VIRTUAL_LIQUIDITY_EVENT') {
                const marketState = this.marketStateBuilder.processClassifiedEvent(event);
                const currentTime = event.event_time;

                // 1. Position Management for existing active trades
                if (this.openPositions.has(mint)) {
                    const posId = this.openPositions.get(mint);
                    const updateRes = this.positionManager.updatePosition(posId, marketState, currentTime);

                    if (updateRes) {
                        const pos = updateRes.position;
                        const action = updateRes.action;

                        const positionEvent = {
                            event_type: 'POSITION_EVENT',
                            position_id: pos.position_id,
                            strategy_owner: 'V2.4',
                            token: pos.token,
                            timestamp: currentTime,
                            tier: pos.tier || 'B',
                            entry_state: {
                                entry_price: pos.entry_price,
                                entry_timestamp: pos.entry_timestamp,
                                entry_size: pos.entry_size,
                                opportunity_at_entry: pos.opportunity_at_entry,
                                confidence_at_entry: pos.confidence_at_entry
                            },
                            thesis_state: pos.thesis_state,
                            flow_state: pos.flow_state,
                            liquidity_state: pos.liquidity_state,
                            wallet_state: pos.wallet_state,
                            coordination_risk: pos.coordination_risk,
                            distribution_risk: pos.distribution_risk,
                            mae: { ...pos.mae },
                            mfe: { ...pos.mfe },
                            unrealized_pnl: pos.unrealized_pnl,
                            unrealized_pnl_pct: pos.unrealized_pnl_pct
                        };
                        this.positionEvents.push(positionEvent);

                        if (action.type === 'FULL_EXIT') {
                            const pnlPct = pos.entry_size > 0 ? (pos.realized_pnl / pos.entry_size) : ((pos.exit_price - pos.entry_price) / pos.entry_price);
                            const exitEvent = {
                                event_type: 'EXIT_EVENT',
                                position_id: pos.position_id,
                                strategy_owner: 'V2.4',
                                token: pos.token,
                                tier: pos.tier || 'B',
                                entry_size: pos.entry_size,
                                exit_price: pos.exit_price,
                                exit_timestamp: pos.exit_timestamp,
                                realized_pnl: pos.realized_pnl,
                                final_pnl_pct: pnlPct,
                                exit_reason: pos.exit_reason,
                                thesis_state: pos.thesis_state,
                                remaining_size: pos.current_size,
                                fees: 0.000005,
                                slippage: marketState.liquidityMetrics?.estimatedSlippage?.value ?? 0.005
                            };
                            this.exitEvents.push(exitEvent);
                            this.openPositions.delete(mint);

                            // Notify V2.4 Anti-Churn Modules of Exit
                            if (this.config.enableReentryGuard) {
                                this.reentryGuard.onExit(mint, pos.exit_reason, pos.realized_pnl, currentTime);
                            }
                            if (this.config.enableExposureManager) {
                                this.exposureManager.recordExit(mint, pos.realized_pnl, pnlPct, pos.exit_reason, currentTime);
                            }

                            results.push({ type: 'EXIT', event: exitEvent });
                        }
                    }
                } else if (event.classification === 'ECONOMIC_TRADE') {
                    // 2. Candidate Evaluation for potential entries
                    const decision = this.decisionEngine.evaluate(marketState);
                    this.decisionHistory.push({
                        token: mint,
                        timestamp: currentTime,
                        decision
                    });

                    if (decision.DECISION === 'BUY' && ['A+', 'A', 'B', 'C'].includes(decision.TIER)) {
                        const sizeSol = (decision.TIER === 'C') ? this.config.probeSizeSol : this.config.standardSizeSol;

                        // Check V2.4 Re-Entry Guard & Exposure Gates
                        let reentryAllowed = true;
                        let blockedReason = null;

                        if (this.config.enableReentryGuard) {
                            const guardRes = this.reentryGuard.evaluateReentry(
                                mint,
                                marketState,
                                currentTime,
                                this.config.enableExposureManager ? this.exposureManager : null
                            );
                            if (!guardRes.allowed) {
                                reentryAllowed = false;
                                blockedReason = guardRes.reason;
                            }
                        } else if (this.config.enableExposureManager) {
                            const expRes = this.exposureManager.isEntryAllowed(mint, sizeSol);
                            if (!expRes.allowed) {
                                reentryAllowed = false;
                                blockedReason = expRes.reason;
                            }
                        }

                        if (!reentryAllowed) {
                            this.blockedReentries.push({
                                token: mint,
                                timestamp: currentTime,
                                tier: decision.TIER,
                                opportunity: decision.OPPORTUNITY_SCORE,
                                confidence: decision.CONFIDENCE_SCORE,
                                price: marketState.price?.value ?? event.effectivePrice,
                                reason: blockedReason
                            });
                            // Skip entry
                            continue;
                        }

                        // Open New Position
                        const positionId = `v2_4_${mint}_${currentTime}`;
                        const entryPrice = marketState.price?.value ?? event.effectivePrice;

                        const pos = this.positionManager.openPosition({
                            positionId,
                            token: mint,
                            entryTimestamp: currentTime,
                            entryPrice,
                            entrySizeSol: sizeSol,
                            opportunityAtEntry: decision.OPPORTUNITY_SCORE,
                            confidenceAtEntry: decision.CONFIDENCE_SCORE
                        });
                        pos.tier = decision.TIER;

                        this.openPositions.set(mint, positionId);

                        // Notify V2.4 Anti-Churn Modules of Entry
                        if (this.config.enableReentryGuard) {
                            this.reentryGuard.onEntry(mint, currentTime);
                        }
                        if (this.config.enableExposureManager) {
                            this.exposureManager.recordEntry(mint, sizeSol, currentTime);
                        }

                        const entryEvent = {
                            event_type: 'ENTRY_EVENT',
                            position_id: positionId,
                            strategy_owner: 'V2.4',
                            token: mint,
                            timestamp: currentTime,
                            price: entryPrice,
                            size: sizeSol,
                            tier: decision.TIER,
                            opportunity: decision.OPPORTUNITY_SCORE,
                            confidence: decision.CONFIDENCE_SCORE,
                            hard_safety_status: decision.HARD_SAFETY_STATUS,
                            confluence: decision.CONFLUENCE,
                            reason_codes: decision.REASON_CODES
                        };
                        this.entryEvents.push(entryEvent);
                        results.push({ type: 'ENTRY', event: entryEvent });
                    }
                }
            }
        }

        return { classifiedEvents, results };
    }
}
