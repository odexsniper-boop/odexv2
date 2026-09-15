import { buildFeature } from './featureWrapperV2.js';

export class LiquidityEngine {
    constructor() {
        this.history = []; // Snapshot tracking
    }

    processEvents(events, currentCurveSolBalance, currentTime) {
        // currentCurveSolBalance must be the absolute SOL balance of the bonding curve PDA, 
        // derived from the latest event's instruction state if possible, or an aggregator.
        
        // We evaluate on 15s window for deterioration/velocity
        const w = 15; 
        
        let estimatedSlippage = 0;
        let estimatedExitImpact = 0;
        let status = 'AVAILABLE';
        
        // Typical Pump.fun curve size is ~30-100 SOL. 
        // k = x * y. If x is SOL, and we sell S SOL, slippage is ~ S / (x + S).
        // Let's standardise the exit impact metric on a 1.0 SOL exit.
        if (currentCurveSolBalance > 0) {
            estimatedSlippage = 1.0 / (currentCurveSolBalance + 1.0);
            estimatedExitImpact = estimatedSlippage; // Proxy
            status = 'ESTIMATED'; // As requested by prompt: "Do not present estimated liquidity as exact"
        } else {
            status = 'UNAVAILABLE';
        }

        const metrics = {
            currentLiquidity: buildFeature(currentCurveSolBalance, currentTime, 'LiquidityEngine', 'AVAILABLE', currentTime),
            estimatedExitImpact: buildFeature(estimatedExitImpact, currentTime, 'LiquidityEngine', status, currentTime),
            estimatedSlippage: buildFeature(estimatedSlippage, currentTime, 'LiquidityEngine', status, currentTime),
            liquidityVelocity: buildFeature(0, currentTime, 'LiquidityEngine', 'UNAVAILABLE', currentTime),
            liquidityDeterioration: buildFeature(0, currentTime, 'LiquidityEngine', 'UNAVAILABLE', currentTime)
        };
        
        // Snapshot historical state
        const snapshotMetrics = JSON.parse(JSON.stringify(metrics));
        this.history.push({ time: currentTime, metrics: snapshotMetrics });
        this.history = this.history.filter(h => h.time >= currentTime - 60000); // keep 60s
        
        const pastTime = currentTime - (w * 1000);
        const pastSnapshot = this._getNearestSnapshot(pastTime);
        
        if (pastSnapshot) {
            const dt = (currentTime - pastSnapshot.time) / 1000 || w;
            const pastLiq = pastSnapshot.metrics.currentLiquidity.value;
            
            const vel = (currentCurveSolBalance - pastLiq) / dt;
            metrics.liquidityVelocity = buildFeature(vel, currentTime, 'LiquidityEngine', 'DERIVED', currentTime);
            
            // Deterioration is negative velocity (losing liquidity)
            const deterioration = vel < 0 ? Math.abs(vel) : 0;
            metrics.liquidityDeterioration = buildFeature(deterioration, currentTime, 'LiquidityEngine', 'DERIVED', currentTime);
            metrics.liquidityChange = buildFeature(currentCurveSolBalance - pastLiq, currentTime, 'LiquidityEngine', 'DERIVED', currentTime);
        } else {
            metrics.liquidityChange = buildFeature(0, currentTime, 'LiquidityEngine', 'UNAVAILABLE', currentTime);
        }
        
        return metrics;
    }
    
    _getNearestSnapshot(targetTime) {
        let best = null;
        let minDiff = Infinity;
        for (const h of this.history) {
            const MathDiff = Math.abs(h.time - targetTime);
            if (MathDiff < minDiff && MathDiff <= 2500) { 
                best = h;
                minDiff = MathDiff;
            }
        }
        return best;
    }
}
