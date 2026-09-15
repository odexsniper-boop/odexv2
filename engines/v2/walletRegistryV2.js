export class WalletRegistry {
    constructor() {
        this.wallets = new Map();
    }
    
    processEvent(event, mintContext = 'unknown') {
        const w = event.initiator;
        if (!w) return;
        
        if (!this.wallets.has(w)) {
            this.wallets.set(w, {
                firstSeen: event.event_time,
                tokensTraded: new Set(),
                trades: 0,
                buyVolume: 0,
                sellVolume: 0,
                coOccurrences: new Map() // wallet -> count
            });
        }
        
        const data = this.wallets.get(w);
        data.tokensTraded.add(mintContext);
        data.trades++;
        
        if (event.side === 'BUY') data.buyVolume += event.cleanSOLVolume;
        if (event.side === 'SELL') data.sellVolume += event.cleanSOLVolume;
    }

    recordCoOccurrence(walletA, walletB) {
        if (walletA === walletB) return;
        const dataA = this.wallets.get(walletA);
        if (dataA) {
            dataA.coOccurrences.set(walletB, (dataA.coOccurrences.get(walletB) || 0) + 1);
        }
    }

    getWalletIntelligence(walletId) {
        const data = this.wallets.get(walletId);
        if (!data) return { score: 0, evidence: [], confidence: 0 };
        
        let score = 0;
        let confidence = 0.1;
        const evidence = [];
        
        if (data.trades > 5) {
            score += 10;
            evidence.push('active_participant');
            confidence += 0.2;
        }
        if (data.tokensTraded.size > 1) {
            score += 20;
            evidence.push('multi_token_history');
            confidence += 0.3;
        }
        if (data.buyVolume > 10.0) {
            score += 10;
            evidence.push('large_capital_deployer');
            confidence += 0.1;
        }
        // Basic naive proxy for smart money: survives to trade across tokens
        if (data.tokensTraded.size >= 3 && data.trades > 10) {
            score += 30;
            evidence.push('consistent_survivor');
            confidence += 0.2;
        }
        
        return { 
            score: Math.min(score, 100), 
            evidence, 
            confidence: Math.min(confidence, 1.0) 
        };
    }
}
