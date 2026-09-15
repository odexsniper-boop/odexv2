import { buildFeature } from './featureWrapperV2.js';

export class PriceMomentumEngine {
    constructor(windows = [5, 10, 15, 30]) {
        this.windows = windows;
        this.history = [];
    }

    processEvents(events, currentEffectivePrice, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime && e.effectivePrice > 0);
            
            let high = currentEffectivePrice;
            let low = currentEffectivePrice;
            let open = currentEffectivePrice;
            let close = currentEffectivePrice;
            
            if (windowEvents.length > 0) {
                open = windowEvents[0].effectivePrice;
                close = windowEvents[windowEvents.length - 1].effectivePrice;
                high = Math.max(...windowEvents.map(e => e.effectivePrice));
                low = Math.min(...windowEvents.map(e => e.effectivePrice));
            }
            
            const displacement = close - open;
            const trendPersistence = (high - low > 0) ? (displacement / (high - low)) : 0; 
            
            metrics[`${w}s`] = {
                price: buildFeature(close, currentTime, 'PriceMomentum', 'AVAILABLE', currentTime),
                displacement: buildFeature(displacement, currentTime, 'PriceMomentum', windowEvents.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime),
                trendPersistence: buildFeature(trendPersistence, currentTime, 'PriceMomentum', windowEvents.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE', currentTime)
            };
        }
        
        const snapshotMetrics = JSON.parse(JSON.stringify(metrics));
        this.history.push({ time: currentTime, metrics: snapshotMetrics });
        this.history = this.history.filter(h => h.time >= currentTime - 60000);

        for (const w of this.windows) {
            const pastTime = currentTime - (w * 1000);
            const pastSnapshot = this._getNearestSnapshot(pastTime);
            
            if (pastSnapshot) {
                const dt = (currentTime - pastSnapshot.time) / 1000 || w;
                const curM = metrics[`${w}s`];
                const pastM = pastSnapshot.metrics[`${w}s`];
                
                const vel = (curM.price.value - pastM.price.value) / dt;
                curM.priceVelocity = buildFeature(vel, currentTime, 'PriceMomentum', 'DERIVED', currentTime);
                
                if (pastM.priceVelocity) {
                    const acc = (vel - pastM.priceVelocity.value) / dt;
                    curM.priceAcceleration = buildFeature(acc, currentTime, 'PriceMomentum', 'DERIVED', currentTime);
                } else {
                    curM.priceAcceleration = buildFeature(0, currentTime, 'PriceMomentum', 'UNAVAILABLE', currentTime);
                }
            } else {
                const curM = metrics[`${w}s`];
                curM.priceVelocity = buildFeature(0, currentTime, 'PriceMomentum', 'UNAVAILABLE', currentTime);
                curM.priceAcceleration = buildFeature(0, currentTime, 'PriceMomentum', 'UNAVAILABLE', currentTime);
            }
        }
        
        return metrics;
    }

    _getNearestSnapshot(targetTime) {
        let best = null;
        let minDiff = Infinity;
        for (const h of this.history) {
            const diff = Math.abs(h.time - targetTime);
            if (diff < minDiff && diff <= 2500) { 
                best = h;
                minDiff = diff;
            }
        }
        return best;
    }
}
