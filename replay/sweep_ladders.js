import { testExitProfile } from './test_exit_profiles.js';

const targets = [
    { name: 'Ladder 1: 15% / 35%, trail 12%', slowTP: 0.15, fastTP: 0.35, trail: 0.12, beArm: 0.12 },
    { name: 'Ladder 2: 12% / 30%, trail 10%', slowTP: 0.12, fastTP: 0.30, trail: 0.10, beArm: 0.12 },
    { name: 'Ladder 3: 15% / 30%, trail 15%', slowTP: 0.15, fastTP: 0.30, trail: 0.15, beArm: 0.15 },
    { name: 'Ladder 4: 18% / 35%, trail 15%', slowTP: 0.18, fastTP: 0.35, trail: 0.15, beArm: 0.15 },
    { name: 'Ladder 5: 14% / 28%, trail 12%', slowTP: 0.14, fastTP: 0.28, trail: 0.12, beArm: 0.12 }
];

console.log('=== SWEEPING ADAPTIVE LADDER CONFIGURATIONS ===\n');

targets.forEach(cfg => {
    const res = testExitProfile(cfg.name, (pm) => {
        const origExit = pm._evaluateExitPriority.bind(pm);
        pm.config.runnerTrailingPctStrong = cfg.trail;
        pm.config.runnerTrailingPctWeak = cfg.trail * 0.7;

        pm._evaluateExitPriority = function (pos, marketState, elapsedSeconds, currentTime) {
            const pm10 = marketState.priceMomentum?.['10s'];
            const isSlowing = pos.thesis_state === 'THESIS_WEAKENING' || (pm10 && pm10.priceVelocity?.value < 0);
            
            if (pos.stage === 'INITIAL_POSITION') {
                const targetPct = isSlowing ? cfg.slowTP : cfg.fastTP;
                if (pos.unrealized_pnl_pct >= targetPct) {
                    return {
                        type: 'PARTIAL_EXIT',
                        fraction: 0.50,
                        reason: isSlowing ? 'ADAPTIVE_DEFENSIVE_HARVEST' : 'ADAPTIVE_MOMENTUM_HARVEST'
                    };
                }
            }

            if (pos.mfe.maxFavorablePercent >= cfg.beArm && pos.unrealized_pnl_pct <= -0.01) {
                return { type: 'FULL_EXIT', reason: 'BREAKEVEN_PROTECTION' };
            }

            return origExit(pos, marketState, elapsedSeconds, currentTime);
        };
    });

    console.log(`${res.profileName.padEnd(38)} | Win: ${res.winRate}% | Net: ${res.netPnlSol >= 0 ? '+' : ''}${res.netPnlSol.toFixed(4)} SOL | PF: ${res.profitFactor} | Exp: ${res.expectancySol >= 0 ? '+' : ''}${res.expectancySol.toFixed(4)} | MFE Cap: ${res.mfeCaptureRatioPct}% | Givebacks: ${res.givebackCount}`);
});
