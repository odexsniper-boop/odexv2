import { log } from '../config.js';

/**
 * Analyzes price structure, identifying:
 * 1. Initial Expansion / Pump
 * 2. Pullback / Shakeout
 * 3. Support Hold / Higher Low
 * 4. Reclaim / Breakout Stage
 *
 * @param {Array} ohlcvList - Raw candle array [[timestamp, open, high, low, close, volume], ...]
 */
export function analyzePriceStructure(ohlcvList) {
  if (!ohlcvList || ohlcvList.length < 8) {
    return {
      priceScore: 50,
      stage: 'EARLY_DISCOVERY',
      isHigherLow: false,
      isReclaim: false,
      pullbackDepth: 0,
      description: 'Insufficient candle history (launch in progress)',
    };
  }

  // Convert to chronological order (oldest first)
  const candles = ohlcvList
    .map(c => ({
      timestamp: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .reverse();

  const L = candles.length;
  const currentCandle = candles[L - 1];
  const prevCandle = candles[L - 2];
  const currentPrice = currentCandle.close;

  // 1. Peak Close
  let maxClose = 0;
  let maxCloseIdx = 0;
  for (let i = 0; i < L; i++) {
    if (candles[i].close > maxClose) {
      maxClose = candles[i].close;
      maxCloseIdx = i;
    }
  }

  const pullbackDepth = maxClose > 0 ? (maxClose - currentPrice) / maxClose : 0;

  // 2. Find lowest point after peak (pullback bottom)
  let pullbackLow = Infinity;
  let pullbackLowIdx = -1;
  for (let i = maxCloseIdx + 1; i < L; i++) {
    if (candles[i].low < pullbackLow) {
      pullbackLow = candles[i].low;
      pullbackLowIdx = i;
    }
  }

  // 3. Evaluate Higher Low and Consolidation
  const isHoldingSupport = pullbackLowIdx !== -1 && pullbackLowIdx < L - 1 && currentPrice > pullbackLow;
  const isHealthyPullback = pullbackDepth >= 0.15 && pullbackDepth <= 0.65;
  const isCrashing = pullbackDepth > 0.75;

  // 4. Moving Average Reclaim
  const smaPeriod = Math.min(9, L);
  let sumCloses = 0;
  for (let i = L - smaPeriod; i < L; i++) {
    sumCloses += candles[i].close;
  }
  const sma = sumCloses / smaPeriod;
  const isAboveSMA = currentPrice > sma;

  // 5. Volume Expansion
  const lookbackVol = Math.min(4, L - 1);
  let sumVol = 0;
  for (let i = L - 1 - lookbackVol; i < L - 1; i++) {
    sumVol += candles[i].volume;
  }
  const avgVol = lookbackVol > 0 ? sumVol / lookbackVol : 0;
  const isVolumeExpanding = currentCandle.volume > avgVol * 1.15;

  // Stage classification
  let stage = 'CONSOLIDATION';
  let priceScore = 65;

  if (isCrashing) {
    stage = 'EXHAUSTION_DUMP';
    priceScore = 20;
  } else if (maxCloseIdx === L - 1) {
    stage = 'INITIAL_EXPANSION';
    priceScore = 75;
  } else if (isHoldingSupport && isAboveSMA && isVolumeExpanding) {
    stage = 'HIGHER_LOW_RECLAIM';
    priceScore = 92;
  } else if (isHoldingSupport) {
    stage = 'CONSOLIDATION_BASE';
    priceScore = 78;
  } else if (pullbackDepth > 0) {
    stage = 'PULLBACK_ABSORPTION';
    priceScore = 60;
  }

  return {
    priceScore,
    stage,
    isHigherLow: isHoldingSupport,
    isReclaim: isAboveSMA && isVolumeExpanding,
    pullbackDepth: parseFloat((pullbackDepth * 100).toFixed(1)),
    supportLevel: pullbackLow !== Infinity ? pullbackLow : candles[0].low,
    currentPrice,
    maxClose,
  };
}

/**
 * Stage 3: Deterministic 3-Candle Pattern Trigger
 * Candle 1: Breakout / strong buying
 * Candle 2: Pullback but holds above breakout level (higher low / healthy absorption)
 * Candle 3: Buyers return + breaks Candle 2 high -> ENTRY TRIGGER
 * 
 * @param {Array<{open: number, high: number, low: number, close: number, volume: number, timestamp: number}>} candles
 */
export function evaluateThreeCandlePattern(candles) {
  if (!candles || candles.length < 3) {
    return {
      patternTriggered: false,
      stage: 'INSUFFICIENT_CANDLES',
      score: 30,
      reason: `Building candle history (${candles ? candles.length : 0}/3 candles)`,
    };
  }

  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];

  // 1. Candle 1: Breakout / Strong Buying
  const isC1Bullish = c1.close > c1.open;
  const c1GainPercent = c1.open > 0 ? ((c1.close - c1.open) / c1.open) * 100 : 0;
  const isC1Breakout = isC1Bullish && c1GainPercent >= 2.0;

  if (!isC1Breakout) {
    return {
      patternTriggered: false,
      stage: 'WAITING_C1_BREAKOUT',
      score: 40,
      reason: `Candle 1 lacks breakout momentum (+${c1GainPercent.toFixed(1)}% < 2%)`,
    };
  }

  // Common C3 checks
  const isC3Bullish = c3.close > c3.open;

  // ============================================
  // SETUP B: MOMENTUM (God Candles / Acceleration)
  // ============================================
  const isC2Bullish = c2.close > c2.open;
  const c2GainPercent = c2.open > 0 ? ((c2.close - c2.open) / c2.open) * 100 : 0;
  
  if (isC2Bullish && c2GainPercent >= 0.5) {
    // If it's a straight momentum setup, we just need C3 to push higher
    if (isC3Bullish && (c3.close >= c2.high || c3.high > c2.high)) {
      return {
        patternTriggered: true,
        stage: 'C3_ENTRY_TRIGGERED',
        score: 98,
        reason: `Setup B (Momentum): 3 consecutive green candles! (C1: +${c1GainPercent.toFixed(1)}%, C2: +${c2GainPercent.toFixed(1)}%) -> C3 accelerating!`,
        c1, c2, c3,
      };
    }
  }

  // ============================================
  // SETUP A: PULLBACK (Healthy Consolidation)
  // ============================================
  const c1BreakoutBase = c1.open;
  const c1MidPoint = c1.open + (c1.close - c1.open) * 0.35;
  const isC2Pullback = c2.close <= c1.close || c2.open >= c2.close;
  const c2HeldSupport = c2.low >= (c1BreakoutBase * 0.98) && c2.close >= c1MidPoint;

  if (isC2Pullback) {
    if (!c2HeldSupport) {
      return {
        patternTriggered: false,
        stage: 'C2_SUPPORT_FAILED',
        score: 20,
        reason: `Setup A Failed: Candle 2 dumped through breakout baseline.`,
      };
    }

    const breaksC2High = c3.close >= c2.high || c3.high > c2.high;
    if (isC3Bullish && breaksC2High) {
      return {
        patternTriggered: true,
        stage: 'C3_ENTRY_TRIGGERED',
        score: 95,
        reason: `Setup A (Pullback): C1 breakout (+${c1GainPercent.toFixed(1)}%) -> C2 held support -> C3 broke C2 high!`,
        c1, c2, c3,
      };
    }
  }

  // Pending States
  if (isC3Bullish) {
    return {
      patternTriggered: false,
      stage: 'C3_TESTING_HIGH',
      score: 75,
      reason: `Candle 3 green, pushing toward highs (${c3.close.toFixed(8)})`,
      c1, c2, c3,
    };
  } else {
    return {
      patternTriggered: false,
      stage: 'AWAITING_C3_CONFIRMATION',
      score: 65,
      reason: `Candle 2 formed, awaiting Candle 3 buyer return`,
      c1, c2,
    };
  }
}

/**
 * Real-time Candle Builder: Aggregates high-frequency ticks into 15s or 30s candles
 */
export class CandleBuilder {
  constructor(timeframeSeconds = 15) {
    this.timeframeMs = timeframeSeconds * 1000;
    this.candles = [];
    this.currentCandle = null;
  }

  addTick(price, volume = 0, timestamp = Date.now()) {
    if (!price || price <= 0) return;
    const bucket = Math.floor(timestamp / this.timeframeMs) * this.timeframeMs;

    if (!this.currentCandle || this.currentCandle.timestamp !== bucket) {
      if (this.currentCandle) {
        this.candles.push({ ...this.currentCandle });
        if (this.candles.length > 50) this.candles.shift();
      }
      this.currentCandle = {
        timestamp: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume || 0.1,
      };
    } else {
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
      this.currentCandle.volume += (volume || 0.1);
    }
  }

  getCandles() {
    const list = [...this.candles];
    if (this.currentCandle) {
      list.push({ ...this.currentCandle });
    }
    return list;
  }

  getClosedCandles() {
    return [...this.candles];
  }

  getCurrentCandle() {
    return this.currentCandle ? { ...this.currentCandle } : null;
  }
}
