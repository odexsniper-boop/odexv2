/**
 * V2 Thesis State Engine
 * 
 * Manages post-entry thesis transitions with hysteresis / debounce protection:
 * THESIS_STRONG <-> THESIS_WEAKENING -> THESIS_BROKEN -> EMERGENCY
 */

export class ThesisStateEngine {
    constructor(options = {}) {
        this.debounceTicksRequired = options.debounceTicksRequired || 2;
    }

    createTracker(initialState = 'THESIS_STRONG', initialTime = 0) {
        return {
            currentState: initialState,
            pendingState: null,
            pendingCount: 0,
            lastTransitionTime: initialTime,
            history: [{ state: initialState, timestamp: initialTime, reason: 'ENTRY' }]
        };
    }

    evaluate(tracker, state, position, currentTime) {
        const rawEvaluation = this._evaluateRaw(state, position, currentTime);
        const candidateState = rawEvaluation.candidateState;
        const reasons = rawEvaluation.reasons;

        // EMERGENCY overrides all hysteresis immediately
        if (candidateState === 'EMERGENCY') {
            if (tracker.currentState !== 'EMERGENCY') {
                tracker.currentState = 'EMERGENCY';
                tracker.lastTransitionTime = currentTime;
                tracker.history.push({ state: 'EMERGENCY', timestamp: currentTime, reasons });
            }
            return {
                thesisState: tracker.currentState,
                reasons,
                transitioned: true
            };
        }

        // If candidate matches current state, reset pending
        if (candidateState === tracker.currentState) {
            tracker.pendingState = null;
            tracker.pendingCount = 0;
            return {
                thesisState: tracker.currentState,
                reasons,
                transitioned: false
            };
        }

        // Hysteresis / Debounce logic for non-emergency transitions
        if (tracker.pendingState === candidateState) {
            tracker.pendingCount += 1;
        } else {
            tracker.pendingState = candidateState;
            tracker.pendingCount = 1;
        }

        let transitioned = false;
        if (tracker.pendingCount >= this.debounceTicksRequired) {
            // Once broken, cannot return to strong without exceptional confluence
            if (tracker.currentState === 'THESIS_BROKEN' && candidateState !== 'EMERGENCY') {
                // Keep broken
            } else {
                tracker.currentState = candidateState;
                tracker.lastTransitionTime = currentTime;
                tracker.history.push({ state: candidateState, timestamp: currentTime, reasons });
                transitioned = true;
            }
            tracker.pendingState = null;
            tracker.pendingCount = 0;
        }

        return {
            thesisState: tracker.currentState,
            pendingState: tracker.pendingState,
            reasons,
            transitioned
        };
    }

    _evaluateRaw(state, position, currentTime) {
        const reasons = [];

        // 1. EMERGENCY checks
        if (state.dataQuality !== 'AVAILABLE') {
            reasons.push('corrupted_market_state');
            return { candidateState: 'EMERGENCY', reasons };
        }

        const liq = state.liquidityMetrics?.currentLiquidity?.value ?? 0;
        if (liq < 5.0) {
            reasons.push('critical_liquidity_collapse');
            return { candidateState: 'EMERGENCY', reasons };
        }

        const distRisk = state.distributionRisk?.['10s']?.distributionRisk?.value ?? 0;
        if (distRisk >= 85) {
            reasons.push('catastrophic_distribution');
            return { candidateState: 'EMERGENCY', reasons };
        }

        // 2. THESIS_BROKEN checks
        const mf30 = state.moneyFlow?.['30s'];
        const pm30 = state.priceMomentum?.['30s'];
        const pm10 = state.priceMomentum?.['10s'];
        const liqDet = state.liquidityMetrics?.liquidityDeterioration?.value ?? 0;

        let brokenSignals = 0;
        if (mf30 && mf30.netFlow?.value < -0.5) {
            reasons.push('flow_collapse_negative_net_flow');
            brokenSignals++;
        }
        if (pm30 && pm30.priceVelocity?.value < 0 && pm10 && pm10.priceVelocity?.value < 0) {
            reasons.push('price_momentum_failure');
            brokenSignals++;
        }
        if (distRisk >= 60) {
            reasons.push('heavy_distribution_active');
            brokenSignals++;
        }
        if (liqDet > 2.0) {
            reasons.push('severe_liquidity_deterioration');
            brokenSignals++;
        }

        if (brokenSignals >= 2) {
            return { candidateState: 'THESIS_BROKEN', reasons };
        }

        // 3. THESIS_WEAKENING checks
        const mf15 = state.moneyFlow?.['15s'];
        let weakeningSignals = 0;

        if (mf15 && mf15.buyVolumeAcceleration?.value < 0) {
            reasons.push('buyer_acceleration_declining');
            weakeningSignals++;
        }
        if (mf15 && (mf15.sellVolume?.value ?? 0) > (mf15.buyVolume?.value ?? 0)) {
            reasons.push('seller_pressure_dominant');
            weakeningSignals++;
        }
        if (pm10 && pm10.priceAcceleration?.value < 0) {
            reasons.push('price_acceleration_negative');
            weakeningSignals++;
        }
        if (distRisk >= 40) {
            reasons.push('moderate_distribution_detected');
            weakeningSignals++;
        }

        if (weakeningSignals >= 2 || brokenSignals === 1) {
            return { candidateState: 'THESIS_WEAKENING', reasons };
        }

        // 4. THESIS_STRONG default
        reasons.push('healthy_flow_and_participation');
        return { candidateState: 'THESIS_STRONG', reasons };
    }
}
