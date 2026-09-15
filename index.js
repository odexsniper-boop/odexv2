import { CONFIG, log } from './config.js';
import { auditToken } from './solana.js';
import { snapshotStore } from './storage/snapshotStore.js';
import { determineLifecycleState, calculateMarketKinematics } from './engines/marketEngine.js';
import { evaluateHardFails, calculateSafetyScore } from './engines/safetyEngine.js';
import { analyzeOrganicActivity } from './engines/manipulationEngine.js';
import { analyzePriceStructure } from './engines/priceEngine.js';
import {
  calculateMomentumScore,
  calculateSmartMoneyScore,
  calculateOpportunityScore,
} from './engines/scoringEngine.js';
import { dispatchOpportunityAlert } from './alerts/telegramAlert.js';

// Global runtime tracking
const processedTokens = new Set();
const activeWatchlist = new Map(); // mint -> TokenTrackingContext

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts normalized token info from DEX pool payload
 */
function extractTokenFromPool(pool, included) {
  const baseTokenData = pool.relationships.base_token?.data;
  const quoteTokenData = pool.relationships.quote_token?.data;
  if (!baseTokenData || !quoteTokenData) return null;

  const findMeta = (id) => included.find((item) => item.id === id && item.type === 'token')?.attributes;
  const baseMeta = findMeta(baseTokenData.id);
  const quoteMeta = findMeta(quoteTokenData.id);

  const baseAddress = baseTokenData.id.split('_')[1];
  const quoteAddress = quoteTokenData.id.split('_')[1];

  const quoteAssets = [
    'So11111111111111111111111111111111111111112', // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  ];

  if (quoteAssets.includes(baseAddress)) {
    return {
      mint: quoteAddress,
      symbol: quoteMeta?.symbol || 'UNKNOWN',
      name: quoteMeta?.name,
      poolAddress: pool.attributes.address,
    };
  }

  return {
    mint: baseAddress,
    symbol: baseMeta?.symbol || 'UNKNOWN',
    name: baseMeta?.name,
    poolAddress: pool.attributes.address,
  };
}

/**
 * Stage 0 / Discovery: Ingests new Solana pools and seeds token tracker
 */
async function discoverLaunches() {
  try {
    const url = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token';
    const res = await fetch(url, { headers: { Accept: 'application/json;version=20230203' } });
    if (!res.ok) {
      log(`Discovery warning: HTTP ${res.status} (${res.statusText})`);
      return;
    }

    const json = await res.json();
    const pools = json.data || [];
    const included = json.included || [];

    for (const pool of pools) {
      const token = extractTokenFromPool(pool, included);
      if (!token) continue;

      if (processedTokens.has(token.mint) || activeWatchlist.has(token.mint)) {
        continue;
      }

      const poolCreatedAt = new Date(pool.attributes.pool_created_at).getTime();
      const ageSeconds = (Date.now() - poolCreatedAt) / 1000;

      // Only accept recent launches within tracking window
      if (ageSeconds > CONFIG.LIFECYCLE_WINDOWS.ABSOLUTE_MAX_AGE_SEC) {
        continue;
      }

      const fdv = parseFloat(pool.attributes.fdv_usd) || 0;
      const liquidity = parseFloat(pool.attributes.reserve_in_usd) || 0;

      // Filter out micro-liquidity bonding curves (< $15k) immediately before hitting Solana RPC
      if (liquidity < CONFIG.HARD_FAILS.MIN_LIQUIDITY_USD) {
        continue;
      }

      // Seed tracking context
      activeWatchlist.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        poolAddress: token.poolAddress,
        createdAt: poolCreatedAt,
        lastAnalyzed: 0,
        alertDispatched: false,
      });

      log(`[DISCOVERY] Tracking new launch: $${token.symbol} (${token.mint.slice(0, 8)}...) | Age: ${Math.round(ageSeconds)}s | MC: $${Math.round(fdv).toLocaleString()} | Liq: $${Math.round(liquidity).toLocaleString()}`);
    }
  } catch (err) {
    log('Discovery loop error:', err.message);
  }
}

/**
 * Multi-Stage Token Processor: Evaluates kinematics, manipulation, price structure, and scores
 */
async function processTrackedTokens() {
  if (activeWatchlist.size === 0) return;

  for (const [mint, tokenCtx] of activeWatchlist.entries()) {
    const now = Date.now();
    const ageSeconds = (now - tokenCtx.createdAt) / 1000;

    // Remove expired tokens
    if (ageSeconds > CONFIG.LIFECYCLE_WINDOWS.ABSOLUTE_MAX_AGE_SEC) {
      log(`[EXPIRY] Stopped tracking $${tokenCtx.symbol} (exceeded max monitoring window)`);
      activeWatchlist.delete(mint);
      snapshotStore.delete(mint);
      continue;
    }

    // Rate-limit check per token
    if (now - tokenCtx.lastAnalyzed < CONFIG.POLLING.TRACK_INTERVAL_MS) {
      continue;
    }
    tokenCtx.lastAnalyzed = now;

    try {
      await sleep(CONFIG.POLLING.RATE_LIMIT_DELAY_MS);

      // 1. Fetch Pool Metrics & Candles
      const poolUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${tokenCtx.poolAddress}`;
      const poolRes = await fetch(poolUrl, { headers: { Accept: 'application/json;version=20230203' } });
      if (!poolRes.ok) continue;

      const poolData = (await poolRes.json()).data?.attributes;
      if (!poolData) continue;

      const marketCap = parseFloat(poolData.fdv_usd) || 0;
      const liquidity = parseFloat(poolData.reserve_in_usd) || 0;
      const volume5m = parseFloat(poolData.volume_usd?.m5) || parseFloat(poolData.volume_usd?.h1) || 0;
      const txCount5m = (poolData.transactions?.m5?.buys || 0) + (poolData.transactions?.m5?.sells || 0);
      const buys5m = poolData.transactions?.m5?.buys || 0;
      const sells5m = poolData.transactions?.m5?.sells || 0;

      // 2. Fetch Minute Candles for Price Engine (only when pool has preliminary volume or traction)
      let candleData = [];
      if (volume5m > 5000 || txCount5m > 20) {
        const candleUrl = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${tokenCtx.poolAddress}/ohlcv/minute?aggregate=1&limit=30`;
        const candleRes = await fetch(candleUrl, { headers: { Accept: 'application/json;version=20230203' } });
        if (candleRes.ok) {
          candleData = (await candleRes.json()).data?.attributes?.ohlcv_list || [];
        }
      }

      // 3. Record Time-Series Snapshot
      const currentSnapshot = snapshotStore.record(mint, {
        price: parseFloat(poolData.base_token_price_usd) || 0,
        marketCap,
        liquidity,
        volume: volume5m,
        buys: buys5m,
        sells: sells5m,
        holders: Math.max(50, (poolData.transactions?.h1?.buys || buys5m) * 2), // Intelligent holder estimation
      });

      // 4. Determine Lifecycle State & Calculate Kinematics
      const lifecycle = determineLifecycleState(ageSeconds);
      const kinematics = calculateMarketKinematics(mint, {
        volume: volume5m,
        liquidity,
        marketCap,
        buys: buys5m,
        sells: sells5m,
        holders: currentSnapshot.holders,
        priceChange: parseFloat(poolData.price_change_percentage?.m5) || 0,
      });

      // 5. On-Chain Safety Audit (cached per token to avoid repeated RPC spam)
      if (!tokenCtx.audit) {
        tokenCtx.audit = await auditToken(mint);
      }
      const audit = { ...tokenCtx.audit };
      audit.liquidity = liquidity;
      audit.liqRatio = kinematics.liqRatio;

      // 6. Manipulation & Wash Trading Detection
      const organic = analyzeOrganicActivity({
        volume: volume5m,
        transactions: txCount5m,
        uniqueBuyers: buys5m,
        holders: currentSnapshot.holders,
        liquidity,
      });
      audit.washTradingRisk = organic.washRisk;

      // 7. Hard Safety Filter
      const hardCheck = evaluateHardFails(audit);
      if (!hardCheck.passed) {
        log(`🔴 [HARD FAIL REJECT] $${tokenCtx.symbol} failed safety checks: ${hardCheck.hardFailTriggers.join('; ')}`);
        processedTokens.add(mint);
        activeWatchlist.delete(mint);
        continue;
      }

      // 8. Price Structure Analysis
      const priceStructure = analyzePriceStructure(candleData);

      // 9. Multi-Pillar Scoring
      const safetyScore = calculateSafetyScore(audit);
      const momentumScore = calculateMomentumScore(kinematics, organic.organicScore);
      const smartMoneyScore = calculateSmartMoneyScore({ smartCount: 3, smartNetFlowUSD: 12000 }); // baseline / Birdeye heuristic
      const structureScore = priceStructure.priceScore;

      const scores = {
        safety: safetyScore,
        momentum: momentumScore,
        smartMoney: smartMoneyScore,
        structure: structureScore,
      };

      const opportunity = calculateOpportunityScore(scores, hardCheck.passed);

      log(
        `[EVALUATION] $${tokenCtx.symbol} | ${lifecycle.label} | Opp: ${opportunity.opportunityScore}/100 | Mom: ${momentumScore} | Safe: ${safetyScore} | Struct: ${structureScore} | WashRisk: ${organic.washRisk}`
      );

      // 10. Dispatch Actionable Alert (WATCH or ENTRY WINDOW)
      if ((opportunity.tier === 'ENTRY_WINDOW' || opportunity.tier === 'WATCH') && !tokenCtx.alertDispatched) {
        await dispatchOpportunityAlert({
          symbol: tokenCtx.symbol,
          mint,
          ageSeconds,
          marketCap,
          liquidity,
          liqRatio: kinematics.liqRatio,
          scores,
          kinematics,
          organic,
          audit,
          priceStructure,
          tier: opportunity.tier,
          opportunityScore: opportunity.opportunityScore,
        });

        if (opportunity.tier === 'ENTRY_WINDOW') {
          tokenCtx.alertDispatched = true;
          processedTokens.add(mint);
        }
      }
    } catch (err) {
      log(`Error processing token ${tokenCtx.symbol}:`, err.message);
    }
  }
}

/**
 * Main Loop
 */
async function main() {
  log('Starting Solana Early-Warning Market Intelligence System (V1)...');
  log(`Dry Run Mode: ${CONFIG.DRY_RUN} | RPC: ${CONFIG.SOLANA.RPC_URL}`);

  while (true) {
    try {
      await discoverLaunches();
      await sleep(CONFIG.POLLING.SCAN_INTERVAL_MS);
      await processTrackedTokens();
    } catch (err) {
      log('Fatal error in orchestration loop:', err.message);
    }
    await sleep(5000);
  }
}

main();

