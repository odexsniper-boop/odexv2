import { buildFeature } from './featureWrapperV2.js';

export class MoneyFlowEngine {
    constructor(windows = [5, 10, 15, 30]) {
        this.windows = windows;
        this.history = []; 
    }

    processEvents(events, currentTime) {
        const metrics = {};
        
        for (const w of this.windows) {
            const threshold = currentTime - (w * 1000);
            const windowEvents = events.filter(e => e.event_time >= threshold && e.event_time <= currentTime);
            
            let buyVol = 0;
            let sellVol = 0;
            let buyers = new Set();
            let sellers = new Set();
            
            for (const e of windowEvents) {
                if (e.side === 'BUY') {
                    buyVol += e.cleanSOLVolume;
                    buyers.add(e.initiator);
                } else if (e.side === 'SELL') {
                    sellVol += e.cleanSOLVolume;
                    sellers.add(e.initiator);
                }
            }
            
            const netFlow = buyVol - sellVol;
            const buySellRatio = buyVol / Math.max(sellVol, 0.0001);
            
            metrics[`${w}s`] = {
                buyVolume: buildFeature(buyVol, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime),
                sellVolume: buildFeature(sellVol, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime),
                netFlow: buildFeature(netFlow, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime),
                buySellRatio: buildFeature(buySellRatio, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime),
                buyerCount: buildFeature(buyers.size, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime),
                sellerCount: buildFeature(sellers.size, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime)
            };
        }
        
        const snapshotMetrics = JSON.parse(JSON.stringify(metrics));
        this.history.push({ time: currentTime, metrics: snapshotMetrics });
        
        this.history = this.history.filter(h => h.time >= currentTime - (60 * 1000));

        for (const w of this.windows) {
            const pastTime = currentTime - (w * 1000);
            const pastSnapshot = this._getNearestSnapshot(pastTime);
            
            if (pastSnapshot) {
                const dt = (currentTime - pastSnapshot.time) / 1000 || w;
                const curM = metrics[`${w}s`];
                const pastM = pastSnapshot.metrics[`${w}s`];
                
                const buyVolVel = (curM.buyVolume.value - pastM.buyVolume.value) / dt;
                curM.buyVolumeVelocity = buildFeature(buyVolVel, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime);

                const buyerVel = (curM.buyerCount.value - pastM.buyerCount.value) / dt;
                curM.buyerVelocity = buildFeature(buyerVel, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime);
                
                if (pastM.buyVolumeVelocity) {
                    const buyVolAcc = (buyVolVel - pastM.buyVolumeVelocity.value) / dt;
                    curM.buyVolumeAcceleration = buildFeature(buyVolAcc, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime);
                } else {
                    curM.buyVolumeAcceleration = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
                }

                if (pastM.buyerVelocity) {
                    const buyerAcc = (buyerVel - pastM.buyerVelocity.value) / dt;
                    curM.buyerAcceleration = buildFeature(buyerAcc, currentTime, 'MoneyFlowV2', 'AVAILABLE', currentTime);
                } else {
                    curM.buyerAcceleration = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
                }

            } else {
                const curM = metrics[`${w}s`];
                curM.buyVolumeVelocity = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
                curM.buyVolumeAcceleration = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
                curM.buyerVelocity = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
                curM.buyerAcceleration = buildFeature(0, currentTime, 'MoneyFlowV2', 'UNAVAILABLE', currentTime);
            }
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
