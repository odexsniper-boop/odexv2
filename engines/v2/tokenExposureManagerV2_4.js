/**
 * Token Exposure Manager V2.4
 * 
 * Tracks cumulative position risk, entries, exits, consecutive loss streaks,
 * cumulative exposure, and net P&L on a per-token basis.
 * Enforces strict risk budgets to prevent any single token from dominating strategy exposure.
 * 
 * Strict Zero-Lookahead Compliant: All metrics update incrementally on event time.
 */

export class TokenExposureManagerV2_4 {
    constructor(config = {}) {
        this.config = {
            maxCumulativeExposureSol: config.maxCumulativeExposureSol ?? 0.30, // Max total capital allocated across lifetime
            maxConsecutiveLosses: config.maxConsecutiveLosses ?? 2,           // Lock token after N consecutive losses
            maxLifetimeEntries: config.maxLifetimeEntries ?? 3,               // Max lifetime trades per token
            maxCumulativeLossSol: config.maxCumulativeLossSol ?? 0.05,        // Max aggregate realized loss before permanent lockout
            ...config
        };

        // mint -> tokenRecord
        this.records = new Map();
    }

    getRecord(mint) {
        if (!this.records.has(mint)) {
            this.records.set(mint, {
                mint,
                totalEntries: 0,
                totalExits: 0,
                activePositionsCount: 0,
                consecutiveLosses: 0,
                consecutiveWins: 0,
                cumulativeRealizedPnlSol: 0,
                cumulativeGrossLossSol: 0,
                cumulativeGrossProfitSol: 0,
                cumulativeAllocatedSol: 0,
                lastExitTimestamp: 0,
                lastExitReason: null,
                lastExitPnlSol: 0,
                lastExitPnlPct: 0,
                isLocked: false,
                lockReason: null
            });
        }
        return this.records.get(mint);
    }

    recordEntry(mint, sizeSol, timestamp) {
        const rec = this.getRecord(mint);
        rec.totalEntries++;
        rec.activePositionsCount++;
        rec.cumulativeAllocatedSol += sizeSol;
        return rec;
    }

    recordExit(mint, pnlSol, pnlPct, exitReason, timestamp) {
        const rec = this.getRecord(mint);
        rec.totalExits++;
        rec.activePositionsCount = Math.max(0, rec.activePositionsCount - 1);
        rec.cumulativeRealizedPnlSol += pnlSol;
        rec.lastExitTimestamp = timestamp;
        rec.lastExitReason = exitReason;
        rec.lastExitPnlSol = pnlSol;
        rec.lastExitPnlPct = pnlPct;

        if (pnlSol > 0) {
            rec.cumulativeGrossProfitSol += pnlSol;
            rec.consecutiveWins++;
            rec.consecutiveLosses = 0;
        } else {
            rec.cumulativeGrossLossSol += Math.abs(pnlSol);
            rec.consecutiveLosses++;
            rec.consecutiveWins = 0;
        }

        // Check if token breaches risk budget limits
        if (rec.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            rec.isLocked = true;
            rec.lockReason = `CONSECUTIVE_LOSS_LIMIT_REACHED (${rec.consecutiveLosses})`;
        } else if (rec.cumulativeGrossLossSol >= this.config.maxCumulativeLossSol) {
            rec.isLocked = true;
            rec.lockReason = `MAX_CUMULATIVE_LOSS_REACHED (${rec.cumulativeGrossLossSol.toFixed(4)} SOL)`;
        } else if (rec.totalEntries >= this.config.maxLifetimeEntries) {
            rec.isLocked = true;
            rec.lockReason = `MAX_LIFETIME_ENTRIES_REACHED (${rec.totalEntries})`;
        }

        return rec;
    }

    isEntryAllowed(mint, requestedSizeSol) {
        const rec = this.getRecord(mint);

        if (rec.isLocked) {
            return { allowed: false, reason: rec.lockReason };
        }

        if (rec.activePositionsCount > 0) {
            return { allowed: false, reason: 'TOKEN_ALREADY_OPEN' };
        }

        if (rec.totalEntries >= this.config.maxLifetimeEntries) {
            return { allowed: false, reason: 'MAX_ENTRIES_EXCEEDED' };
        }

        if ((rec.cumulativeAllocatedSol + requestedSizeSol) > this.config.maxCumulativeExposureSol) {
            return { allowed: false, reason: 'MAX_CUMULATIVE_EXPOSURE_EXCEEDED' };
        }

        return { allowed: true };
    }
}
