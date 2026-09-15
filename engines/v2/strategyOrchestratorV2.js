import { EconomicEventClassifier } from './economicEventClassifierV2.js';
import { MarketStateBuilder } from './marketStateBuilderV2.js';
import { WalletRegistry } from './walletRegistryV2.js';
import { DecisionEngine } from './decisionEngineV2.js';
import { PositionManagerV2 } from './positionManagerV2.js';

/**
 * V2 Strategy Orchestrator
 * 
 * Complete end-to-end integration of the V2 deterministic trading pipeline:
 * RAW EVENT
 *   ↓
 * ECONOMIC EVENT CLASSIFIER
 *   ↓
 * MARKET STATE BUILDER
 *   ↓
 * HARD SAFETY -> CONFIDENCE -> OPPORTUNITY -> CONFLUENCE -> DECISION
 *   ↓
 * ENTRY CONTRACT
 *   ↓
 * THESIS STATE -> POSITION MANAGER -> EXIT CONTRACT
 */

export class StrategyOrchestratorV2 {
    constructor(config = {}) {
        this.config = {
            tradeSizeSol: config.tradeSizeSol ?? 0.1,
            ...config
        };

        this.classifier = new EconomicEventClassifier();
        this.walletRegistry = new WalletRegistry();
        this.marketStateBuilder = new MarketStateBuilder(this.walletRegistry);
        this.decisionEngine = new DecisionEngine();
        this.positionManager = new PositionManagerV2(config.positionManagerConfig || {});

        this.openPositions = new Map(); // token -> position_id
        this.entryEvents = [];
        this.positionEvents = [];
        this.exitEvents = [];
        this.decisionHistory = [];
    }

    /**
     * Process raw blockchain transaction event stream.
     * @param {Object} tx Raw Helius transaction
     * @param {string} mint Token mint address
     * @param {string} curvePda AMM Curve PDA
     * @param {string} curveTokenAccount AMM Curve Token Account
     * @returns {Object} Processing results including classified events and lifecycle updates
     */
    processTransaction(tx, mint, curvePda, curveTokenAccount) {
        const classifiedEvents = this.classifier.classifyTransaction(tx, mint, curvePda, curveTokenAccount);
        const results = [];

        for (const event of classifiedEvents) {
            // Process Virtual Liquidity and Economic Swaps
            if (event.classification === 'ECONOMIC_TRADE' || event.classification === 'VIRTUAL_LIQUIDITY_EVENT') {
                const marketState = this.marketStateBuilder.processClassifiedEvent(event);
                const currentTime = event.event_time;

                // 1. If we already hold an open position in this token, update position lifecycle
                if (this.openPositions.has(mint)) {
                    const posId = this.openPositions.get(mint);
                    const updateRes = this.positionManager.updatePosition(posId, marketState, currentTime);

                    if (updateRes) {
                        const pos = updateRes.position;
                        const action = updateRes.action;

                        // Emit POSITION_EVENT contract
                        const positionEvent = {
                            event_type: 'POSITION_EVENT',
                            position_id: pos.position_id,
                            strategy_owner: 'V2',
                            token: pos.token,
                            timestamp: currentTime,
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

                        // If position closed, emit EXIT_EVENT contract
                        if (action.type === 'FULL_EXIT') {
                            const exitEvent = {
                                event_type: 'EXIT_EVENT',
                                position_id: pos.position_id,
                                strategy_owner: 'V2',
                                token: pos.token,
                                exit_price: pos.exit_price,
                                exit_timestamp: pos.exit_timestamp,
                                realized_pnl: pos.realized_pnl,
                                final_pnl_pct: (pos.exit_price - pos.entry_price) / pos.entry_price,
                                exit_reason: pos.exit_reason,
                                thesis_state: pos.thesis_state,
                                remaining_size: pos.current_size,
                                fees: 0.000005, // Standard Solana tx fee
                                slippage: marketState.liquidityMetrics?.estimatedSlippage?.value ?? 0.005
                            };
                            this.exitEvents.push(exitEvent);
                            this.openPositions.delete(mint);
                            results.push({ type: 'EXIT', event: exitEvent });
                        } else if (action.type === 'PARTIAL_EXIT') {
                            results.push({ type: 'PARTIAL_EXIT', action, position: pos });
                        }
                    }
                } else if (event.classification === 'ECONOMIC_TRADE') {
                    // 2. Pre-Entry Decision Evaluation
                    const decision = this.decisionEngine.evaluate(marketState);
                    this.decisionHistory.push({
                        token: mint,
                        timestamp: currentTime,
                        decision
                    });

                    // Trigger entry if decision is BUY on qualifying tier (A+, A, B, C)
                    if (decision.DECISION === 'BUY' && ['A+', 'A', 'B'].includes(decision.TIER)) {
                        const positionId = `v2_${mint}_${currentTime}`;
                        const entryPrice = marketState.price?.value ?? event.effectivePrice;
                        const sizeSol = this.config.tradeSizeSol;

                        const pos = this.positionManager.openPosition({
                            positionId,
                            token: mint,
                            entryTimestamp: currentTime,
                            entryPrice,
                            entrySizeSol: sizeSol,
                            opportunityAtEntry: decision.OPPORTUNITY_SCORE,
                            confidenceAtEntry: decision.CONFIDENCE_SCORE
                        });

                        this.openPositions.set(mint, positionId);

                        // Emit ENTRY_EVENT contract
                        const entryEvent = {
                            event_type: 'ENTRY_EVENT',
                            position_id: positionId,
                            strategy_owner: 'V2',
                            token: mint,
                            timestamp: currentTime,
                            price: entryPrice,
                            size: sizeSol,
                            tier: decision.TIER,
                            opportunity: decision.OPPORTUNITY_SCORE,
                            confidence: decision.CONFIDENCE_SCORE,
                            hard_safety_status: decision.HARD_SAFETY_STATUS,
                            confluence: decision.CONFLUENCE,
                            reason_codes: decision.REASON_CODES,
                            evidence: {
                                positive: decision.POSITIVE_EVIDENCE,
                                negative: decision.NEGATIVE_EVIDENCE
                            }
                        };
                        this.entryEvents.push(entryEvent);
                        results.push({ type: 'ENTRY', event: entryEvent });
                    }
                }
            }
        }

        return {
            classifiedEvents,
            results
        };
    }
}
