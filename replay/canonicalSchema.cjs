/**
 * KO V3 V2 - Canonical Event Schema
 */
class CanonicalEvent {
    constructor(data) {
        this.event_id = data.event_id || null;
        this.signature = data.signature || null;
        this.slot = data.slot || null;
        this.block_time = data.block_time || null;
        this.transaction_index = data.transaction_index || null;
        this.instruction_index = data.instruction_index || null;
        this.mint = data.mint || null;
        this.wallet = data.wallet || null;
        this.side = data.side || "OTHER";
        this.base_asset_amount = data.base_asset_amount || 0;
        this.token_amount = data.token_amount || 0;
        this.effective_price = data.effective_price || 0;
        this.liquidity_state = data.liquidity_state || null;
        this.source = data.source || "UNKNOWN";
        this.ingestion_timestamp = Date.now();
        this.historical_availability_timestamp = data.historical_availability_timestamp || null;
        this.completeness_status = data.completeness_status || {
            wallet: "NOT_AVAILABLE",
            liquidity: "NOT_AVAILABLE",
            price: "NOT_AVAILABLE"
        };
    }
    isValid() {
        if (!this.signature || !this.slot || !this.block_time) return false;
        if (!this.mint || !this.side) return false;
        return true;
    }
}
module.exports = CanonicalEvent;

