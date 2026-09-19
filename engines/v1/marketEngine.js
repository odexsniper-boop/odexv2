import { CONFIG, log } from '../config.js';
import { snapshotStore } from '../storage/snapshotStore.js';

/**
 * Determines current lifecycle state based on token launch age
 * State 0: 0-30s
 * State 1: 30s-3m
 * State 2: 3m-10m
 * State 3: 10m-30m
 */
export function determineLifecycleState(ageSeconds) {
  const { LIFECYCLE_WINDOWS } = CONFIG;
  if (ageSeconds <= LIFECYCLE_WINDOWS.STATE_0_MAX_AGE_SEC) {
    return { state: 0, label: 'STATE 0 (JUST CREATED)', code: 'STATE_0' };
  }
  if (ageSeconds <= LIFECYCLE_WINDOWS.STATE_1_MAX_AGE_SEC) {
    return { state: 1, label: 'STATE 1 (DISCOVERY & VELOCITY)', code: 'STATE_1' };
  }
  if (ageSeconds <= LIFECYCLE_WINDOWS.STATE_2_MAX_AGE_SEC) {
    return { state: 2, label: 'STATE 2 (VALIDATION & PERSISTENCE)', code: 'STATE_2' };
  }
  return { state: 3, label: 'STATE 3 (CONFIRMATION & STRUCTURE)', code: 'STATE_3' };
}

/**
 * Calculates market kinematics (acceleration, velocity, liquidity trends)
 * @param {string} mint - Token mint
 * @param {object} current - Current metrics (price, volume, liquidity, buyers, txs)
 */
export function calculateMarketKinematics(mint, current) {
  // Retrieve snapshots from 30s ago, 60s ago, and 3m ago
  const snap30s = snapshotStore.getSnapshotAgo(mint, 30000);
  const snap60s = snapshotStore.getSnapshotAgo(mint, 60000);
  const snap3m = snapshotStore.getSnapshotAgo(mint, 180000);

  // 1. Volume Acceleration (V1 last 30s vs V2 previous 30s)
  let volumeAcceleration = 1.0;
  if (snap30s && snap60s) {
    const v1 = Math.max(0, current.volume - snap30s.volume);
    const v2 = Math.max(0, snap30s.volume - snap60s.volume);
    if (v2 > 0) {
      volumeAcceleration = parseFloat((v1 / v2).toFixed(2));
    } else if (v1 > 0) {
      volumeAcceleration = 2.0; // Acceleration occurred from low base
    }
  }

  // 2. Holder Velocity (Holders delta per minute)
  let holderVelocity = 0;
  if (snap60s && current.holders) {
    holderVelocity = current.holders - (snap60s.holders || current.holders);
  } else if (snap30s && current.holders) {
    holderVelocity = (current.holders - (snap30s.holders || current.holders)) * 2;
  }

  // 3. Liquidity Trend & Shock Detection
  // Alert if price pumps but liquidity deteriorates
  let liquidityChangePercent = 0;
  if (snap60s && snap60s.liquidity > 0) {
    liquidityChangePercent = parseFloat((((current.liquidity - snap60s.liquidity) / snap60s.liquidity) * 100).toFixed(1));
  } else if (snap30s && snap30s.liquidity > 0) {
    liquidityChangePercent = parseFloat((((current.liquidity - snap30s.liquidity) / snap30s.liquidity) * 100).toFixed(1));
  }

  // 4. Net Buy Ratio / Buy Pressure
  let buyPressurePercent = 50;
  const totalTrades = (current.buys || 0) + (current.sells || 0);
  if (totalTrades > 0) {
    buyPressurePercent = Math.round(((current.buys || 0) / totalTrades) * 100);
  }

  // 5. Liquidity to Market Cap Ratio
  const liqRatio = current.marketCap > 0 ? current.liquidity / current.marketCap : 0;

  return {
    volumeAcceleration,
    holderVelocity,
    liquidityChangePercent,
    buyPressurePercent,
    liqRatio,
    hasLiquidityShock: liquidityChangePercent < -15 && current.priceChange > 10,
  };
}
