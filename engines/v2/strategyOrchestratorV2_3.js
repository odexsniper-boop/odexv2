import { EconomicEventClassifier } from './economicEventClassifierV2.js';
import { MarketStateBuilder } from './marketStateBuilderV2.js';
import { WalletRegistry } from './walletRegistryV2.js';
import { DecisionEngine } from './decisionEngineV2.js';
import { CoordinationRiskEngineV2_1 } from './coordinationRiskV2_1.js';
import { OpportunityScoreEngineV2_2 } from './opportunityScoreV2_2.js';
import { PositionManagerV2_3 } from './positionManagerV2_3.js';

/**
 * Strategy Orchestrator V2.3 (Exit Monetization Calibration)
 * 
 * Includes:
 * - V2.2 Dynamic Relative Flow Opportunity Score Engine
 * - V2.1 Context-Aware Coordination Risk Engine
 * - V2.3 Adaptive Momentum Profit Ladder Position Manager
 * - Tier C fractional probing (0.025 SOL)
 * - Tier B/A standard execution (0.10 SOL)
 * - Strict Hard Safety gate (Extreme coordination >= 75 only)
 * - Unified canonical MarketState snapshotting
 */

export class StrategyOrchestratorV2_3 {
    constructor(config = {}) {
        this.config = {
            standardSizeSol: config.standardSizeSol ?? 0.10,
            probeSizeSol: config.probeSizeSol ?? 0.025,
            ...config
        };

        this.classifier = new EconomicEventClassifier();
        this.walletRegistry = new WalletRegistry();
        this.marketStateBuilder = new MarketStateBuilder(this.walletRegistry);
        
        // Permanent swap to V2.1 Coordination Engine
        this.marketStateBuilder.coordinationRiskEngine = new CoordinationRiskEngineV2_1(this.walletRegistry);

        this.decisionEngine = new DecisionEngine();
        // V2.2 Dynamic Flow Opportunity Engine
        this.decisionEngine.opportunity = new OpportunityScoreEngineV2_2();

        // V2.3 Adaptive Profit Ladder Position Manager
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

        // Decision logic with Tier C Probing & dynamic flow awareness
        const originalDecision = this.decisionEngine.evaluate.bind(this.decisionEngine);
        this.decisionEngine.evaluate = function (state) {
            const dec = originalDecision(state);
            const crObj = state.coordinationRisk?.['10s'];
            const level = crObj?.level ?? 'LOW';

            // Extreme coordination triggers Hard Safety REJECT
            if (level === 'EXTREME') {
                dec.DECISION = 'REJECT';
                dec.TIER = 'REJECT';
                dec.REASON_CODES.push('extreme_coordination_cluster');
                return dec;
            }

            // High coordination downgrades to Tier C probe if opportunity is solid
            if (level === 'HIGH' && dec.DECISION === 'BUY') {
                dec.TIER = 'C';
            } else if (dec.DECISION === 'REJECT' && dec.HARD_SAFETY_STATUS !== 'REJECT') {
                // Tier C probe criteria: Opp >= 55 & Conf >= 65
                if (dec.OPPORTUNITY_SCORE >= 55 && dec.CONFIDENCE_SCORE >= 65) {
                    dec.DECISION = 'BUY';
                    dec.TIER = 'C';
                }
            }

            return dec;
        };

        this.openPositions = new Map();
        this.entryEvents = [];
        this.positionEvents = [];
        this.exitEvents = [];
        this.decisionHistory = [];
    }

    processTransaction(tx, mint, curvePda, curveTokenAccount) {
        const classifiedEvents = this.classifier.classifyTransaction(tx, mint, curvePda, curveTokenAccount);
        const results = [];

        for (const event of classifiedEvents) {
            if (event.classification === 'ECONOMIC_TRADE' || event.classification === 'VIRTUAL_LIQUIDITY_EVENT') {
                const marketState = this.marketStateBuilder.processClassifiedEvent(event);
                const currentTime = event.event_time;

                if (this.openPositions.has(mint)) {
                    const posId = this.openPositions.get(mint);
                    const updateRes = this.positionManager.updatePosition(posId, marketState, currentTime);

                    if (updateRes) {
                        const pos = updateRes.position;
                        const action = updateRes.action;

                        const positionEvent = {
                            event_type: 'POSITION_EVENT',
                            position_id: pos.position_id,
                            strategy_owner: 'V2.3',
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
                            const exitEvent = {
                                event_type: 'EXIT_EVENT',
                                position_id: pos.position_id,
                                strategy_owner: 'V2.3',
                                token: pos.token,
                                tier: pos.tier || 'B',
                                entry_size: pos.entry_size,
                                exit_price: pos.exit_price,
                                exit_timestamp: pos.exit_timestamp,
                                realized_pnl: pos.realized_pnl,
                                final_pnl_pct: (pos.exit_price - pos.entry_price) / pos.entry_price,
                                exit_reason: pos.exit_reason,
                                thesis_state: pos.thesis_state,
                                remaining_size: pos.current_size,
                                fees: 0.000005,
                                slippage: marketState.liquidityMetrics?.estimatedSlippage?.value ?? 0.005
                            };
                            this.exitEvents.push(exitEvent);
                            this.openPositions.delete(mint);
                            results.push({ type: 'EXIT', event: exitEvent });
                        }
                    }
                } else if (event.classification === 'ECONOMIC_TRADE') {
                    const decision = this.decisionEngine.evaluate(marketState);
                    this.decisionHistory.push({
                        token: mint,
                        timestamp: currentTime,
                        decision
                    });

                    if (decision.DECISION === 'BUY' && ['A+', 'A', 'B', 'C'].includes(decision.TIER)) {
                        const positionId = `v2_3_${mint}_${currentTime}`;
                        const entryPrice = marketState.price?.value ?? event.effectivePrice;
                        // Probe size for Tier C, standard size for Tier A/B
                        const sizeSol = (decision.TIER === 'C') ? this.config.probeSizeSol : this.config.standardSizeSol;

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

                        const entryEvent = {
                            event_type: 'ENTRY_EVENT',
                            position_id: positionId,
                            strategy_owner: 'V2.3',
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
