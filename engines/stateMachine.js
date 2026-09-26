/**
 * Strict 3-Stage Token Lifecycle State Machine:
 * 1. NARRATIVE_AUDIT: Viral meme, event, influencer, AI meta, social footprint
 * 2. MONEY_FLOW_WATCH: Buy/sell volume delta, unique buyers, tx acceleration, dev holding
 * 3. PATTERN_FORMING: 3-candle breakout -> pullback hold -> breakout of C2 high
 * 4. ENTRY_READY -> BUY_PENDING -> POSITION_OPEN -> CLOSED
 */
export const TokenState = {
  DETECTED: 'DETECTED',
  NARRATIVE_AUDIT: 'NARRATIVE_AUDIT',
  MONEY_FLOW_WATCH: 'MONEY_FLOW_WATCH',
  PATTERN_FORMING: 'PATTERN_FORMING',
  ENTRY_READY: 'ENTRY_READY',
  BUY_PENDING: 'BUY_PENDING',
  POSITION_OPEN: 'POSITION_OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  REJECTED: 'REJECTED',
  LIGHTWEIGHT_WATCHLIST: 'LIGHTWEIGHT_WATCHLIST',
};

export class TokenRecord {
  constructor(mint) {
    this.mint = mint;
    this.name = 'Pending...';
    this.symbol = '...';
    this.imageUrl = null;
    this.metadataUri = null;
    this.creator = 'UNKNOWN';
    this.state = TokenState.DETECTED;
    this.detectedAt = Date.now();
    this.updatedAt = Date.now();
    
    // 3-Stage Strategy Verdicts
    this.stage1_narrative = { pass: false, score: 0, theme: 'GENERIC', reasons: [], socialsFound: 0 };
    this.stage2_moneyFlow = { pass: false, score: 0, buySellRatio: 1.0, netVolumeDeltaSol: 0, uniqueBuyers: 0, reasons: [] };
    this.stage3_pattern = { pass: false, stage: 'NONE', score: 0, reason: 'Awaiting candles' };

    // Order Flow Tracking
    this.buyVolumeSol = 0;
    this.sellVolumeSol = 0;
    this.uniqueBuyers = new Set();
    this.txCount = 0;
    this.devSoldAny = false;
    this.topHoldersPercent = 0;

    // Scores
    this.narrativeScore = 0;  // 0-100
    this.moneyFlowScore = 0;  // 0-100
    this.patternScore = 0;    // 0-100
    this.entryScore = 0;      // 0-100 (composite)
    this.riskScore = 0;       // 0-100 (lower is safer)
    this.rejectionReason = null;
    
    // Execution link
    this.buyTxHash = null;
    this.sellTxHash = null;
    this.position = null;
  }

  transitionTo(newState, reason = null) {
    this.state = newState;
    this.updatedAt = Date.now();
    if (reason) {
      this.rejectionReason = reason;
    }
  }
}

