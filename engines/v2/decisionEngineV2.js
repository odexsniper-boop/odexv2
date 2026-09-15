import { HardSafetyEngine } from './hardSafetyV2.js';
import { ConfidenceScoreEngine } from './confidenceScoreV2.js';
import { OpportunityScoreEngine } from './opportunityScoreV2.js';
import { ConfluenceEngine } from './confluenceEngineV2.js';

export class DecisionEngine {
    constructor() {
        this.hardSafety = new HardSafetyEngine();
        this.confidence = new ConfidenceScoreEngine();
        this.opportunity = new OpportunityScoreEngine();
        this.confluence = new ConfluenceEngine();
    }

    evaluate(state) {
        // 1. Hard Safety
        const safetyResult = this.hardSafety.evaluate(state);
        
        // 2. Confidence & Opportunity
        const confResult = this.confidence.evaluate(state);
        const oppResult = this.opportunity.evaluate(state);
        
        // 3. Confluence
        const confluenceLevel = this.confluence.evaluate(state);
        
        // Anti-FOMO Checks
        const pm = state.priceMomentum && state.priceMomentum['10s'] ? state.priceMomentum['10s'] : null;
        let isFomo = false;
        if (pm && pm.priceAcceleration.value < 0 && pm.priceVelocity.value > 0) {
            // Price is still going up but slowing down rapidly
            if (oppResult.opportunityScore > 60) oppResult.opportunityScore -= 10;
            oppResult.negativeEvidence.push('momentum_peaking_anti_fomo');
            isFomo = true;
        }

        // Tiers Evaluation
        let tier = 'REJECT';
        let decision = 'NO_ACTION';
        
        if (safetyResult.status === 'REJECT') {
            tier = 'REJECT';
            decision = 'REJECT';
        } else if (confResult.confidenceScore < 50 || oppResult.opportunityScore < 50) {
            tier = 'REJECT';
            decision = 'REJECT';
            if (confResult.confidenceScore < 50) safetyResult.reasonCodes.push('insufficient_confidence');
            if (oppResult.opportunityScore < 50) safetyResult.reasonCodes.push('insufficient_opportunity');
        } else {
            // Valid Setup
            decision = 'BUY';
            if (oppResult.opportunityScore >= 85 && confResult.confidenceScore >= 85 && confluenceLevel === 'HIGH' && safetyResult.status === 'PASS' && !isFomo) {
                tier = 'A+';
            } else if (oppResult.opportunityScore >= 75 && confResult.confidenceScore >= 80 && (confluenceLevel === 'HIGH' || confluenceLevel === 'MEDIUM')) {
                tier = 'A';
            } else if (oppResult.opportunityScore >= 65 && confResult.confidenceScore >= 70 && confluenceLevel !== 'CONFLICTING') {
                tier = 'B';
            } else {
                tier = 'C';
            }
        }
        
        return {
            DECISION: decision,
            TIER: tier,
            OPPORTUNITY_SCORE: oppResult.opportunityScore,
            CONFIDENCE_SCORE: confResult.confidenceScore,
            HARD_SAFETY_STATUS: safetyResult.status,
            CONFLUENCE: confluenceLevel,
            POSITIVE_EVIDENCE: oppResult.positiveEvidence,
            NEGATIVE_EVIDENCE: oppResult.negativeEvidence,
            REASON_CODES: safetyResult.reasonCodes,
            _timestamp: state.lastUpdated
        };
    }
}
