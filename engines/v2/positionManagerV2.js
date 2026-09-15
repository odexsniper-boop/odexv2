import { ThesisStateEngine } from './thesisStateEngineV2.js';

/**
 * V2 Position Manager
 * 
 * Adaptive post-entry position management governed by:
 * - Dynamic Thesis State (Strong, Weakening, Broken, Emergency)
 * - Flow-aware risk & hard maximum stop
 * - Continuous MAE / MFE tracking
 * - Staged partial profit & dynamic runner trailing
 * - Strict deterministic exit priority
 */

export class PositionManagerV2 {
    constructor(config = {}) {
        this.config = {
            maxHardLossPct: config.maxHardLossPct ?? -0.20, // -20% hard stop
            flowLossThresholdPct: config.flowLossThresholdPct ?? -0.08, // -8% if flow breaks
            initialProfitTargetPct: config.initialProfitTargetPct ?? 0.40, // +40% triggers partial
            partialExitFraction: config.partialExitFraction ?? 0.50, // sell 50%
            runnerTrailingPctStrong: config.runnerTrailingPctStrong ?? 0.20, // 20% giveback allowed if strong
            runnerTrailingPctWeak: config.runnerTrailingPctWeak ?? 0.10, // 10% giveback if weakening
            timeDecayGraceSeconds: config.timeDecayGraceSeconds ?? 60,
            timeDecayMaxSeconds: config.timeDecayMaxSeconds ?? 180,
            ...config
        };
        this.thesisEngine = new ThesisStateEngine();
        this.positions = new Map(); // position_id -> position
    }

    openPosition({
        positionId,
        token,
        entryTimestamp,
        entryPrice,
        entrySizeSol,
        opportunityAtEntry = 0,
        confidenceAtEntry = 0
    }) {
        const tracker = this.thesisEngine.createTracker('THESIS_STRONG', entryTimestamp);
        const position = {
            position_id: positionId,
            strategy_owner: 'V2',
            token,
            entry_timestamp: entryTimestamp,
            entry_price: entryPrice,
            entry_size: entrySizeSol,
            current_size: entrySizeSol,
            realized_pnl: 0,
            unrealized_pnl: 0,
            unrealized_pnl_pct: 0,
            mae: {
                maxAdversePercent: 0,
                maxAdverseSol: 0,
                timestamp: entryTimestamp
            },
            mfe: {
                maxFavorablePercent: 0,
                maxFavorableSol: 0,
                timestamp: entryTimestamp
            },
            peakPrice: entryPrice,
            troughPrice: entryPrice,
            stage: 'INITIAL_POSITION', // INITIAL_POSITION -> PARTIAL_EXIT -> RUNNER -> CLOSED
            thesis_state: 'THESIS_STRONG',
            opportunity_at_entry: opportunityAtEntry,
            confidence_at_entry: confidenceAtEntry,
            current_opportunity: opportunityAtEntry,
            current_confidence: confidenceAtEntry,
            flow_state: 'NEUTRAL',
            liquidity_state: 'AVAILABLE',
            wallet_state: 'NEUTRAL',
            coordination_risk: 0,
            distribution_risk: 0,
            exit_reason: null,
            exit_timestamp: null,
            exit_price: null,
            _tracker: tracker
        };

        this.positions.set(positionId, position);
        return position;
    }

    updatePosition(positionId, marketState, currentTime) {
        const pos = this.positions.get(positionId);
        if (!pos || pos.stage === 'CLOSED') return null;

        const currentPrice = marketState.price?.value ?? pos.entry_price;
        if (currentPrice <= 0) return null;

        // 1. Update PnL metrics
        const pnlPct = (currentPrice - pos.entry_price) / pos.entry_price;
        pos.unrealized_pnl_pct = pnlPct;
        pos.unrealized_pnl = pos.current_size * pnlPct;

        // Update Peak / Trough
        if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
        if (currentPrice < pos.troughPrice) pos.troughPrice = currentPrice;

        // 2. Update MAE / MFE
        if (pnlPct < pos.mae.maxAdversePercent) {
            pos.mae.maxAdversePercent = pnlPct;
            pos.mae.maxAdverseSol = pos.entry_size * pnlPct;
            pos.mae.timestamp = currentTime;
        }
        if (pnlPct > pos.mfe.maxFavorablePercent) {
            pos.mfe.maxFavorablePercent = pnlPct;
            pos.mfe.maxFavorableSol = pos.entry_size * pnlPct;
            pos.mfe.timestamp = currentTime;
        }

        // 3. Update Intelligence Snapshot fields
        pos.flow_state = marketState.moneyFlow?.['30s']?.netFlow?.value > 0 ? 'POSITIVE' : 'NEGATIVE';
        pos.liquidity_state = marketState.liquidityMetrics?.currentLiquidity?.status ?? 'AVAILABLE';
        pos.wallet_state = (marketState.walletIntelligence?.['30s']?.smartMoneyScore?.value ?? 0) > 40 ? 'SMART_ACTIVE' : 'NEUTRAL';
        pos.coordination_risk = marketState.coordinationRisk?.['10s']?.coordinationRisk?.value ?? 0;
        pos.distribution_risk = marketState.distributionRisk?.['10s']?.distributionRisk?.value ?? 0;

        // 4. Update Thesis State
        const thesisResult = this.thesisEngine.evaluate(pos._tracker, marketState, pos, currentTime);
        pos.thesis_state = thesisResult.thesisState;

        // 5. Evaluate Exit Rules based on strict deterministic priority:
        const elapsedSeconds = (currentTime - pos.entry_timestamp) / 1000;
        const exitAction = this._evaluateExitPriority(pos, marketState, elapsedSeconds, currentTime);

        if (exitAction.type === 'FULL_EXIT') {
            pos.stage = 'CLOSED';
            pos.exit_reason = exitAction.reason;
            pos.exit_timestamp = currentTime;
            pos.exit_price = currentPrice;
            pos.realized_pnl += pos.unrealized_pnl;
            pos.unrealized_pnl = 0;
            pos.current_size = 0;
        } else if (exitAction.type === 'PARTIAL_EXIT') {
            const soldSize = pos.current_size * exitAction.fraction;
            const realizedChunk = soldSize * pnlPct;
            pos.realized_pnl += realizedChunk;
            pos.current_size -= soldSize;
            pos.unrealized_pnl = pos.current_size * pnlPct;
            pos.stage = 'RUNNER';
            pos.exit_reason = exitAction.reason;
        }

        return {
            position: pos,
            action: exitAction
        };
    }

    _evaluateExitPriority(pos, marketState, elapsedSeconds, currentTime) {
        // Priority 1: EMERGENCY
        if (pos.thesis_state === 'EMERGENCY') {
            return { type: 'FULL_EXIT', reason: 'EMERGENCY' };
        }

        // Priority 2: HARD_SAFETY (Max loss hard stop)
        if (pos.unrealized_pnl_pct <= this.config.maxHardLossPct) {
            return { type: 'FULL_EXIT', reason: 'HARD_SAFETY' };
        }

        // Priority 3: THESIS_BROKEN
        if (pos.thesis_state === 'THESIS_BROKEN') {
            return { type: 'FULL_EXIT', reason: 'THESIS_BROKEN' };
        }

        // Priority 4: FLOW / LIQUIDITY / DISTRIBUTION FAILURE
        const netFlow30 = marketState.moneyFlow?.['30s']?.netFlow?.value ?? 0;
        const liqDet = marketState.liquidityMetrics?.liquidityDeterioration?.value ?? 0;
        const distRisk = marketState.distributionRisk?.['10s']?.distributionRisk?.value ?? 0;

        if (pos.unrealized_pnl_pct < 0) {
            if (distRisk >= 75) {
                return { type: 'FULL_EXIT', reason: 'COORDINATED_DISTRIBUTION' };
            }
            if (liqDet > 3.0) {
                return { type: 'FULL_EXIT', reason: 'LIQUIDITY_FAILURE' };
            }
            if (netFlow30 < -1.0 || (pos.unrealized_pnl_pct <= this.config.flowLossThresholdPct && netFlow30 <= 0)) {
                return { type: 'FULL_EXIT', reason: 'FLOW_FAILURE' };
            }
        }

        // Priority 5: TIME DECAY
        if (elapsedSeconds > this.config.timeDecayMaxSeconds) {
            if (pos.thesis_state === 'THESIS_WEAKENING' || pos.unrealized_pnl_pct <= 0.05) {
                return { type: 'FULL_EXIT', reason: 'TIME_DECAY' };
            }
        } else if (elapsedSeconds > 90 && pos.thesis_state === 'THESIS_WEAKENING' && pos.unrealized_pnl_pct <= 0) {
            return { type: 'FULL_EXIT', reason: 'TIME_DECAY' };
        } else if (elapsedSeconds > this.config.timeDecayGraceSeconds && pos.thesis_state === 'THESIS_WEAKENING' && pos.unrealized_pnl_pct < -0.05) {
            return { type: 'FULL_EXIT', reason: 'TIME_DECAY' };
        }

        // Priority 6: PARTIAL PROFIT
        if (pos.stage === 'INITIAL_POSITION' && pos.unrealized_pnl_pct >= this.config.initialProfitTargetPct) {
            return {
                type: 'PARTIAL_EXIT',
                fraction: this.config.partialExitFraction,
                reason: 'PARTIAL_PROFIT'
            };
        }

        // Priority 7: RUNNER / TRAILING
        if (pos.stage === 'RUNNER' || (pos.stage === 'INITIAL_POSITION' && pos.unrealized_pnl_pct >= 0.50)) {
            const currentPrice = marketState.price?.value ?? pos.entry_price;
            const pullbackFromPeak = (pos.peakPrice - currentPrice) / pos.peakPrice;
            const allowedPullback = pos.thesis_state === 'THESIS_STRONG'
                ? this.config.runnerTrailingPctStrong
                : this.config.runnerTrailingPctWeak;

            if (pullbackFromPeak >= allowedPullback && pos.unrealized_pnl_pct > 0.05) {
                return { type: 'FULL_EXIT', reason: 'TRAILING_EXIT' };
            }

            // Momentum failure on runner
            const pm10 = marketState.priceMomentum?.['10s'];
            if (pos.stage === 'RUNNER' && pm10 && pm10.priceVelocity?.value < 0 && pullbackFromPeak > 0.08) {
                return { type: 'FULL_EXIT', reason: 'MOMENTUM_FAILURE' };
            }
        }

        // Priority 8: NORMAL_HOLD
        return { type: 'HOLD', reason: 'NORMAL_HOLD' };
    }
}
