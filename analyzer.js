import { CONFIG, log } from './config.js';

/**
 * Analyzes candle data to detect the Momentum Reclaim setup
 * @param {Array} ohlcvList - Raw candle array [[timestamp, open, high, low, close, volume], ...]
 * @returns {object|null} - Signal details if pattern is matched, null otherwise
 */
export function analyzeCandles(ohlcvList) {
  if (!ohlcvList || ohlcvList.length < 20) {
    return null;
  }

  // 1. Convert to chronological order (oldest first)
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

  // 2. Find the peak close price in the history (Launch Phase)
  let maxClose = 0;
  let maxCloseIdx = -1;

  for (let i = 0; i < L - 5; i++) { // Leave at least 5 candles at the end for pullback/reclaim
    if (candles[i].close > maxClose) {
      maxClose = candles[i].close;
      maxCloseIdx = i;
    }
  }

  if (maxCloseIdx === -1) {
    return null;
  }

  // 3. Calculate Pullback Depth
  const pullbackPercent = (maxClose - currentPrice) / maxClose;
  
  // Strategy: Pullback must be between 20% and 70% from the peak
  if (pullbackPercent < 0.20 || pullbackPercent > 0.70) {
    return null;
  }

  // 4. Find the support level (lowest low after the peak)
  let pullbackLow = Infinity;
  let pullbackLowIdx = -1;
  for (let i = maxCloseIdx + 1; i < L; i++) {
    if (candles[i].low < pullbackLow) {
      pullbackLow = candles[i].low;
      pullbackLowIdx = i;
    }
  }

  // If the low occurred on the very last candle, it's still dropping (falling knife)
  if (pullbackLowIdx === L - 1) {
    return null;
  }

  // 5. Check if the pullback low is holding (price is higher than support)
  // Ensure the support was established and isn't immediately breached
  if (currentPrice <= pullbackLow) {
    return null;
  }

  // 6. Check for Reclaim (Price moves above 9 SMA + Volume Expansion)
  // Calculate 9 SMA
  let sumCloses = 0;
  for (let i = L - 9; i < L; i++) {
    sumCloses += candles[i].close;
  }
  const sma9 = sumCloses / 9;

  // Reclaim Condition A: Current close is above the 9 SMA
  const isAboveSMA = currentPrice > sma9;

  // Reclaim Condition B: Price was below or near SMA in the previous candle (crossing up)
  const isCrossingUp = prevCandle.close <= sma9 || candles[L - 3].close <= sma9;

  // Reclaim Condition C: Current candle close is higher than previous close
  const isGreenCandle = currentPrice > prevCandle.close;

  // Reclaim Condition D: Volume Expansion (Current volume > 1.25x the average volume of preceding 4 candles)
  let sumPrevVolume = 0;
  for (let i = L - 5; i < L - 1; i++) {
    sumPrevVolume += candles[i].volume;
  }
  const avgPrevVolume = sumPrevVolume / 4;
  const isVolumeExpanded = currentCandle.volume > avgPrevVolume * 1.25 && currentCandle.volume > 0;

  const isReclaimed = isAboveSMA && isCrossingUp && isGreenCandle && isVolumeExpanded;

  if (!isReclaimed) {
    return null;
  }

  // 7. Risk and Position Sizing Calculations
  // Invalidation level is 1% below the pullback low
  const stopLossPrice = pullbackLow * 0.99;
  const stopLossPercent = (currentPrice - stopLossPrice) / currentPrice;

  // Skip if the stop loss required is wider than 25% (too volatile / high friction)
  if (stopLossPercent > 0.25 || stopLossPercent <= 0) {
    return null;
  }

  const riskAmount = CONFIG.RISK.BANKROLL * (CONFIG.RISK.RISK_PERCENT / 100);
  const positionSize = riskAmount / stopLossPercent;

  return {
    entryPrice: currentPrice,
    stopLossPrice,
    stopLossPercent,
    positionSize,
    pullbackLow,
    maxClose,
    pullbackPercent,
  };
}
