import { MoneyFlowEngine } from './moneyFlowV2.js';
import { ParticipationQualityEngine } from './participationQualityV2.js';
import { LiquidityEngine } from './liquidityEngineV2.js';
import { WalletIntelligenceEngine } from './walletIntelligenceV2.js';
import { CoordinationRiskEngine } from './coordinationRiskV2.js';
import { DistributionRiskEngine } from './distributionRiskV2.js';
import { PriceMomentumEngine } from './priceMomentumV2.js';
import { WalletRegistry } from './walletRegistryV2.js';
import { buildFeature } from './featureWrapperV2.js';

export class MarketStateBuilder {
    constructor(sharedWalletRegistry = null) {
        this.eventBuffer = [];
        this.moneyFlowEngine = new MoneyFlowEngine();
        this.participationEngine = new ParticipationQualityEngine();
        this.liquidityEngine = new LiquidityEngine();
        this.priceMomentumEngine = new PriceMomentumEngine();
        
        this.walletRegistry = sharedWalletRegistry || new WalletRegistry();
        this.walletIntelligenceEngine = new WalletIntelligenceEngine(this.walletRegistry);
        this.coordinationRiskEngine = new CoordinationRiskEngine(this.walletRegistry);
        this.distributionRiskEngine = new DistributionRiskEngine(this.walletRegistry);
        
        this.absoluteLiquiditySol = 30.0; 
        
        this.state = {
            dataQuality: 'AVAILABLE',
            lastUpdated: 0,
            price: buildFeature(0, 0, 'MarketStateBuilder', 'UNAVAILABLE', 0),
            liquidity: buildFeature(0, 0, 'MarketStateBuilder', 'UNAVAILABLE', 0),
            moneyFlow: {},
            participation: {},
            liquidityMetrics: {},
            walletIntelligence: {},
            coordinationRisk: {},
            distributionRisk: {},
            priceMomentum: {}
        };
    }

    processClassifiedEvent(event) {
        if (event.classification === 'VIRTUAL_LIQUIDITY_EVENT') {
            this.absoluteLiquiditySol = 30.0;
        } else if (event.classification === 'ECONOMIC_TRADE') {
            this.eventBuffer.push(event);
            if (event.effectivePrice) {
                this.state.price = buildFeature(event.effectivePrice, event.event_time, 'MarketStateBuilder', 'AVAILABLE', event.event_time);
            }
            if (event.side === 'BUY') this.absoluteLiquiditySol += event.cleanSOLVolume;
            if (event.side === 'SELL') this.absoluteLiquiditySol -= event.cleanSOLVolume;
            
            this.walletRegistry.processEvent(event, event.test_mint_context);
        }
        
        this.eventBuffer.sort((a, b) => a.event_time - b.event_time);
        
        const currentTime = event.event_time;
        this.eventBuffer = this.eventBuffer.filter(e => currentTime - e.event_time <= 60000);
        
        this.state.lastUpdated = currentTime;
        this.state.moneyFlow = this.moneyFlowEngine.processEvents(this.eventBuffer, currentTime);
        this.state.participation = this.participationEngine.processEvents(this.eventBuffer, currentTime);
        this.state.liquidityMetrics = this.liquidityEngine.processEvents(this.eventBuffer, this.absoluteLiquiditySol, currentTime);
        this.state.priceMomentum = this.priceMomentumEngine.processEvents(this.eventBuffer, this.state.price.value, currentTime);
        
        this.state.walletIntelligence = this.walletIntelligenceEngine.processEvents(this.eventBuffer, currentTime);
        this.state.coordinationRisk = this.coordinationRiskEngine.processEvents(this.eventBuffer, currentTime);
        this.state.distributionRisk = this.distributionRiskEngine.processEvents(this.eventBuffer, currentTime);
        
        return JSON.parse(JSON.stringify(this.state));
    }
}
