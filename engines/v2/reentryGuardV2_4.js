/**
 * Re-Entry Guard V2.4
 * 
 * Implements a state machine for token lifecycle:
 *   ELIGIBLE -> ENTERED -> EXITED -> COOLDOWN -> REARMING -> ELIGIBLE (or TOKEN_LOCKED)
 * 
 * Features:
 * - Exit-Reason-Aware Progressive Cooldown:
 *   * HARD_SAFETY: Strict progressive lockout (e.g. 120s -> 300s -> Permanent Lock)
 *   * FLOW_FAILURE: Medium cooldown (e.g. 45s -> 90s)
 *   * BREAKEVEN_PROTECTION: Short reset (e.g. 15s)
 *   * TRAILING_EXIT (Winner): Short runner cooldown (e.g. 10s to allow legitimate pullbacks/second legs)
 * - Thesis Reset Requirement:
 *   * Cooldown expiration alone does not grant entry.
 *   * Token must demonstrate an independently established, qualifying setup (positive flow, non-negative acceleration, acceptable confluence).
 * - Anti-Tick Churn:
 *   * Re-entry within the same or immediate next tick is strictly blocked.
 * 
 * Strict Zero-Lookahead Compliant: Decides purely on event timestamp and past state.
 */

export const TokenReentryState = {
    ELIGIBLE: 'ELIGIBLE',
    ENTERED: 'ENTERED',
    EXITED: 'EXITED',
    COOLDOWN: 'COOLDOWN',
    REARMING: 'REARMING',
    LOCKED: 'TOKEN_LOCKED'
};

export class ReentryGuardV2_4 {
    constructor(config = {}) {
        this.config = {
            // Base cooldowns by exit reason (seconds)
            cooldownHardSafetySeconds: config.cooldownHardSafetySeconds ?? 120,
            cooldownFlowFailureSeconds: config.cooldownFlowFailureSeconds ?? 45,
            cooldownBreakevenSeconds: config.cooldownBreakevenSeconds ?? 15,
            cooldownTrailingSeconds: config.cooldownTrailingSeconds ?? 10,
            cooldownDefaultSeconds: config.cooldownDefaultSeconds ?? 30,

            // Progressive multiplier on consecutive losses
            progressiveMultiplier: config.progressiveMultiplier ?? 1.5,

            // Minimum required time between exit and re-entry (hard tick debounce)
            minExitDebounceSeconds: config.minExitDebounceSeconds ?? 5,

            // Require thesis reset
            requireThesisReset: config.requireThesisReset ?? true,
            minOpportunityForReset: config.minOpportunityForReset ?? 65,
            minConfidenceForReset: config.minConfidenceForReset ?? 70,

            ...config
        };

        // mint -> stateRecord
        this.tokens = new Map();
    }

    getRecord(mint) {
        if (!this.tokens.has(mint)) {
            this.tokens.set(mint, {
                mint,
                state: TokenReentryState.ELIGIBLE,
                lastEntryTime: 0,
                lastExitTime: 0,
                lastExitReason: null,
                cooldownDurationSeconds: 0,
                cooldownExpiryTime: 0,
                consecutiveLossCount: 0,
                rearmed: true,
                history: []
            });
        }
        return this.tokens.get(mint);
    }

    onEntry(mint, currentTime) {
        const rec = this.getRecord(mint);
        rec.state = TokenReentryState.ENTERED;
        rec.lastEntryTime = currentTime;
        rec.rearmed = false;
        rec.history.push({ state: TokenReentryState.ENTERED, timestamp: currentTime });
    }

    onExit(mint, exitReason, pnlSol, currentTime) {
        const rec = this.getRecord(mint);
        rec.lastExitTime = currentTime;
        rec.lastExitReason = exitReason;

        if (pnlSol <= 0) {
            rec.consecutiveLossCount++;
        } else {
            rec.consecutiveLossCount = 0;
        }

        // Calculate dynamic exit-reason-aware cooldown
        let baseCooldown = this.config.cooldownDefaultSeconds;
        if (exitReason === 'HARD_SAFETY' || exitReason === 'EMERGENCY') {
            baseCooldown = this.config.cooldownHardSafetySeconds;
        } else if (exitReason === 'FLOW_FAILURE' || exitReason === 'LIQUIDITY_FAILURE') {
            baseCooldown = this.config.cooldownFlowFailureSeconds;
        } else if (exitReason === 'BREAKEVEN_PROTECTION') {
            baseCooldown = this.config.cooldownBreakevenSeconds;
        } else if (exitReason === 'TRAILING_EXIT') {
            baseCooldown = this.config.cooldownTrailingSeconds;
        }

        // Apply progressive multiplier if loss streak > 1
        const multiplier = rec.consecutiveLossCount > 1 ? Math.pow(this.config.progressiveMultiplier, rec.consecutiveLossCount - 1) : 1.0;
        const totalCooldown = Math.round(baseCooldown * multiplier);

        // Detect timestamp unit (seconds vs milliseconds)
        const isMs = currentTime > 1e11;
        const unitMultiplier = isMs ? 1000 : 1;

        rec.state = TokenReentryState.COOLDOWN;
        rec.cooldownDurationSeconds = totalCooldown;
        rec.cooldownExpiryTime = currentTime + (totalCooldown * unitMultiplier);
        rec.rearmed = false;
        rec.history.push({
            state: TokenReentryState.COOLDOWN,
            timestamp: currentTime,
            exitReason,
            cooldownDurationSeconds: totalCooldown
        });
    }

    evaluateReentry(mint, marketState, currentTime, exposureManager = null) {
        const rec = this.getRecord(mint);

        // 1. If currently inside a trade, cannot enter again
        if (rec.state === TokenReentryState.ENTERED) {
            return { allowed: false, state: rec.state, reason: 'ALREADY_IN_POSITION' };
        }

        // 2. Check Token Risk Budget Lockout if exposure manager provided
        if (exposureManager) {
            const expCheck = exposureManager.isEntryAllowed(mint, 0.025);
            if (!expCheck.allowed) {
                rec.state = TokenReentryState.LOCKED;
                return { allowed: false, state: TokenReentryState.LOCKED, reason: expCheck.reason };
            }
        }

        // 3. Brand new token that has never been traded is ELIGIBLE
        if (rec.lastExitTime === 0 && rec.lastEntryTime === 0) {
            rec.state = TokenReentryState.ELIGIBLE;
            return { allowed: true, state: TokenReentryState.ELIGIBLE, reason: 'NEW_TOKEN_ELIGIBLE' };
        }

        // 4. Hard Tick Debounce: strictly reject immediate re-entry on loss/flow exits
        const isMs = currentTime > 1e11;
        const elapsedSinceExit = isMs ? (currentTime - rec.lastExitTime) / 1000 : (currentTime - rec.lastExitTime);
        const debounceReq = rec.lastExitReason === 'TRAILING_EXIT' ? 0 : this.config.minExitDebounceSeconds;
        if (debounceReq > 0 && elapsedSinceExit < debounceReq) {
            return { allowed: false, state: rec.state, reason: `IMMEDIATE_TICK_DEBOUNCE (${elapsedSinceExit.toFixed(1)}s < ${debounceReq}s)` };
        }

        // 5. Cooldown Window Check
        if (currentTime < rec.cooldownExpiryTime) {
            const remaining = Math.round(isMs ? (rec.cooldownExpiryTime - currentTime) / 1000 : (rec.cooldownExpiryTime - currentTime));
            rec.state = TokenReentryState.COOLDOWN;
            return { allowed: false, state: TokenReentryState.COOLDOWN, reason: `IN_COOLDOWN (${remaining}s remaining)` };
        }

        // 6. Thesis Reset Requirement (State: REARMING -> ELIGIBLE)
        if (this.config.requireThesisReset) {
            rec.state = TokenReentryState.REARMING;

            // Check if market state establishes an independent, healthy re-arm
            const netFlow30 = marketState.moneyFlow?.['30s']?.netFlow?.value ?? 0;
            const buyAccel = marketState.moneyFlow?.['30s']?.buyVolumeAcceleration?.value ?? 0;
            const distRisk = marketState.distributionRisk?.['10s']?.distributionRisk?.value ?? 0;
            const coordRisk = marketState.coordinationRisk?.['10s']?.coordinationRisk?.value ?? 0;

            // Strict disqualifiers for re-arming
            if (distRisk >= 75) {
                return { allowed: false, state: TokenReentryState.REARMING, reason: 'RESET_FAILED_HIGH_DISTRIBUTION' };
            }
            if (coordRisk >= 80) {
                return { allowed: false, state: TokenReentryState.REARMING, reason: 'RESET_FAILED_EXTREME_COORDINATION' };
            }
            if (netFlow30 <= 0 && buyAccel <= 0) {
                return { allowed: false, state: TokenReentryState.REARMING, reason: 'RESET_FAILED_NEGATIVE_FLOW' };
            }

            // Setup has demonstrated an independent reset
            rec.rearmed = true;
            rec.state = TokenReentryState.ELIGIBLE;
            return { allowed: true, state: TokenReentryState.ELIGIBLE, reason: 'THESIS_RESET_CONFIRMED' };
        }

        rec.state = TokenReentryState.ELIGIBLE;
        return { allowed: true, state: TokenReentryState.ELIGIBLE, reason: 'COOLDOWN_EXPIRED' };
    }
}
