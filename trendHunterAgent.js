import { eventBus } from './eventBus.js';
import { log } from './config.js';

/**
 * Default Configuration for Trend Intelligence
 */
export const DEFAULT_TREND_CONFIG = {
  enabled: true,
  refreshIntervalMs: 30000,
  trendExpiryMs: 7200000, // 2 hours
  minTrendScore: 50,
  breakoutThreshold: 85,
  decayHalfLifeMs: 1800000, // 30 minutes half-life
  cacheTtlMs: 60000,
  weights: {
    velocity: 0.30,
    recency: 0.25,
    crossSource: 0.20,
    sourceQuality: 0.15,
    activity: 0.10,
  },
  sourceWeights: {
    x_twitter: 1.0,
    google_trends: 0.9,
    dexscreener: 0.85,
    pumpfun: 0.80,
    rss_news: 0.70,
    default: 0.50,
  },
  stopWords: new Set([
    'the', 'and', 'for', 'with', 'sol', 'solana', 'pump', 'coin', 'token',
    'meme', 'crypto', 'presale', 'launch', 'dev', 'free', 'airdrop', 'official',
    'buy', 'sell', 'new', 'moon', 'real', 'best', 'super', 'meta'
  ]),
  minKeywordLength: 3,
};

/**
 * Base Adapter for Trend Sources
 */
export class TrendSourceAdapter {
  constructor(name, weight = 0.5) {
    this.name = name;
    this.weight = weight;
    this.lastRun = 0;
    this.errorCount = 0;
  }

  async fetchTrends() {
    throw new Error(`fetchTrends() must be implemented by adapter ${this.name}`);
  }
}

/**
 * Built-in DexScreener Trending Adapter
 */
export class DexScreenerTrendingAdapter extends TrendSourceAdapter {
  constructor(weight = 0.85) {
    super('dexscreener', weight);
  }

  async fetchTrends() {
    try {
      // In production/live node environment, query public DexScreener token-boosts or search
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];

      return items.slice(0, 15).map((item) => ({
        name: item.tokenAddress ? item.tokenAddress.slice(0, 8) : 'DexTrending',
        keywords: [item.tokenAddress || '', item.description || ''].filter(Boolean),
        category: 'crypto_dex',
        rawActivity: (item.totalAmount || 1) * 100,
        timestamp: Date.now(),
        metadata: { chainId: item.chainId, icon: item.icon }
      }));
    } catch (err) {
      log(`[TREND HUNTER] DexScreener adapter notice: ${err.message}. Using cache/fallback.`);
      return [];
    }
  }
}

/**
 * Built-in Pump.fun Trend Adapter
 */
export class PumpFunTrendingAdapter extends TrendSourceAdapter {
  constructor(weight = 0.80) {
    super('pumpfun', weight);
  }

  async fetchTrends() {
    try {
      const res = await fetch('https://frontend-api.pump.fun/coins/currently-live?limit=10', {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];

      return list.map((c) => ({
        name: c.name || c.symbol || 'PumpCoin',
        keywords: [c.name, c.symbol, ...(c.description ? c.description.split(/\s+/) : [])].filter(Boolean),
        category: 'animal_meme',
        rawActivity: (c.market_cap || c.reply_count || 10) * 10,
        timestamp: Date.now(),
        metadata: { mint: c.mint, replies: c.reply_count }
      }));
    } catch (err) {
      log(`[TREND HUNTER] PumpFun adapter notice: ${err.message}. Using cache/fallback.`);
      return [];
    }
  }
}

/**
 * Built-in Google Trends / RSS Adapter
 */
export class GoogleTrendsAdapter extends TrendSourceAdapter {
  constructor(weight = 0.90) {
    super('google_trends', weight);
  }

  async fetchTrends() {
    try {
      const res = await fetch('https://trends.google.com/trending/rss?geo=US', {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/xml, text/xml' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.json ? await res.text() : '';
      
      const titles = [];
      const titleMatches = text.matchAll(/<title>([^<]+)<\/title>/g);
      for (const m of titleMatches) {
        const title = m[1].replace('<![CDATA[', '').replace(']]>', '').trim();
        if (title && title !== 'Daily Search Trends' && !titles.includes(title)) {
          titles.push(title);
        }
      }

      return titles.slice(0, 10).map((title, idx) => ({
        name: title,
        keywords: [title, ...title.split(/\s+/)],
        category: 'pop_culture',
        rawActivity: Math.max(1000, 10000 - idx * 750),
        timestamp: Date.now(),
        metadata: { source: 'google_daily_rss' }
      }));
    } catch (err) {
      log(`[TREND HUNTER] Google Trends adapter notice: ${err.message}. Using cache/fallback.`);
      return [];
    }
  }
}

/**
 * Mock / Custom Test Adapter for predictable unit testing & external signals
 */
export class CustomSignalAdapter extends TrendSourceAdapter {
  constructor(name = 'custom_signal', weight = 1.0) {
    super(name, weight);
    this.simulatedTrends = [];
  }

  setSimulatedTrends(trends) {
    this.simulatedTrends = trends;
  }

  async fetchTrends() {
    return this.simulatedTrends.map(t => ({
      ...t,
      timestamp: t.timestamp || Date.now()
    }));
  }
}

/**
 * Main Trend Intelligence / TrendHunter Agent
 */
export class TrendHunterAgent {
  constructor(config = {}) {
    this.config = {
      ...DEFAULT_TREND_CONFIG,
      ...config,
      weights: { ...DEFAULT_TREND_CONFIG.weights, ...(config.weights || {}) },
      sourceWeights: { ...DEFAULT_TREND_CONFIG.sourceWeights, ...(config.sourceWeights || {}) }
    };

    this.adapters = new Map();
    this.trends = new Map(); // trendId -> TrendObject
    this.keywordIndex = new Map(); // keyword -> Set<trendId>
    this.historySnapshots = new Map(); // trendId -> [{ timestamp, rawActivity }]
    this.lastEmittedEvents = new Map(); // trendId -> { type, score, velocity, timestamp }
    this.cacheTimestamp = 0;
    this.pollingTimer = null;
    this.isRunning = false;

    // Register default adapters
    this.registerAdapter(new DexScreenerTrendingAdapter(this.config.sourceWeights.dexscreener));
    this.registerAdapter(new PumpFunTrendingAdapter(this.config.sourceWeights.pumpfun));
    this.registerAdapter(new GoogleTrendsAdapter(this.config.sourceWeights.google_trends));
  }

  /**
   * Register a trend source adapter
   */
  registerAdapter(adapter) {
    if (!adapter || !adapter.name) {
      log('[TREND HUNTER] Cannot register invalid adapter');
      return;
    }
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Remove a trend source adapter
   */
  removeAdapter(adapterName) {
    this.adapters.delete(adapterName);
  }

  /**
   * Normalize an identifier (e.g. "AI Agents", "ai-agents", "AI_AGENT" -> "ai-agents")
   */
  normalizeId(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Normalize a keyword string (strip punctuation, lowercase, trim)
   */
  normalizeKeyword(keyword) {
    if (!keyword || typeof keyword !== 'string') return '';
    return keyword
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Expand keyword variants for search matching
   */
  expandKeywords(name, extraKeywords = []) {
    const pool = new Set();
    const addClean = (str) => {
      if (!str || typeof str !== 'string') return;
      const clean = str.trim().toLowerCase();
      if (clean.length >= this.config.minKeywordLength && !this.config.stopWords.has(clean)) {
        pool.add(clean);
      }
      const rawNormalized = this.normalizeKeyword(clean);
      if (rawNormalized.length >= this.config.minKeywordLength && !this.config.stopWords.has(rawNormalized)) {
        pool.add(rawNormalized);
      }
    };

    addClean(name);
    // Add individual words
    name.split(/[\s_\-]+/).forEach(addClean);

    // Add extra keywords
    for (const kw of extraKeywords) {
      addClean(kw);
      kw.split(/[\s_\-]+/).forEach(addClean);
    }

    // Common synonym / plural variants
    const currentList = Array.from(pool);
    for (const kw of currentList) {
      if (kw.endsWith('s') && kw.length > 4) {
        addClean(kw.slice(0, -1)); // singular
      } else if (!kw.endsWith('s') && kw.length >= 3) {
        addClean(kw + 's'); // plural
      }
    }

    return Array.from(pool);
  }

  /**
   * Calculate velocity comparing recent activity to historical baseline
   */
  calculateVelocity(trendId, currentActivity, now = Date.now()) {
    const history = this.historySnapshots.get(trendId) || [];
    if (history.length === 0) {
      // First observation: moderate initial velocity baseline
      return Math.min(100, Math.round(Math.log10(Math.max(10, currentActivity)) * 15));
    }

    // Find oldest observation within history window (up to 1 hour)
    const cutoff = now - 3600000;
    const validHistory = history.filter(h => h.timestamp >= cutoff);
    const baseline = validHistory.length > 0 ? validHistory[0] : history[0];

    const prevActivity = baseline.rawActivity;
    const timeDeltaMin = Math.max(0.5, (now - baseline.timestamp) / 60000);

    // Delta and relative surge
    const delta = currentActivity - prevActivity;
    if (delta <= 0) {
      // Decelerating or stagnant
      const decayRatio = Math.max(0, currentActivity / Math.max(1, prevActivity));
      return Math.round(Math.max(0, 30 * decayRatio));
    }

    // Example: 800 -> 6,000 (delta 5200, ratio 6.5x)
    // vs 10,000 -> 10,500 (delta 500, ratio 0.05x)
    const surgeRatio = delta / Math.max(prevActivity, 50);
    const ratePerMinute = delta / timeDeltaMin;

    // Relative breakout multiplier
    const breakoutFactor = surgeRatio * Math.log10(Math.max(10, ratePerMinute));
    
    // Normalize into 0-100 sigmoidal score
    // 0 ratio -> ~15, 2x surge -> ~65, 5x+ surge -> 90-100
    const score = Math.round(100 / (1 + Math.exp(-0.8 * (surgeRatio - 1.5))) * Math.min(1.2, Math.log10(currentActivity + 10) / 3));

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate recency score with exponential decay
   */
  calculateRecencyScore(ageSeconds) {
    const ageMs = ageSeconds * 1000;
    const halfLife = this.config.decayHalfLifeMs;
    const decayFactor = Math.pow(0.5, ageMs / halfLife);
    return Math.max(0, Math.min(100, Math.round(100 * decayFactor)));
  }

  /**
   * Determine Trend Lifecycle State
   */
  determineLifecycleState(ageSeconds, trendScore, velocity) {
    if (ageSeconds * 1000 > this.config.trendExpiryMs || trendScore < 20) {
      return { status: 'EXPIRED', lifecycleState: 'EXPIRED' };
    }
    if (trendScore >= this.config.breakoutThreshold && velocity >= 80) {
      return { status: 'VERY_HOT', lifecycleState: 'ACCELERATING' };
    }
    if (trendScore >= 70 || velocity >= 75) {
      return { status: 'HOT', lifecycleState: 'HOT' };
    }
    if (trendScore >= this.config.minTrendScore) {
      return { status: 'ACTIVE', lifecycleState: 'TRACKING' };
    }
    if (velocity < 35 || ageSeconds > 1800) {
      return { status: 'WEAK', lifecycleState: 'COOLING' };
    }
    return { status: 'ACTIVE', lifecycleState: 'DISCOVERED' };
  }

  /**
   * Ingest raw trend items from an adapter
   */
  ingestTrendItem(rawItem, sourceName, now = Date.now()) {
    if (!rawItem || !rawItem.name) return null;

    let id = this.normalizeId(rawItem.name);
    if (!id) return null;

    // Smart deduplication & alias resolution
    let existing = this.trends.get(id);
    if (!existing) {
      if (id.endsWith('s') && this.trends.has(id.slice(0, -1))) {
        id = id.slice(0, -1);
        existing = this.trends.get(id);
      } else if (this.trends.has(id + 's')) {
        id = id + 's';
        existing = this.trends.get(id);
      } else {
        const cleanKw = this.normalizeKeyword(rawItem.name);
        const mappedIds = this.keywordIndex.get(cleanKw);
        if (mappedIds && mappedIds.size > 0) {
          const matchId = mappedIds.values().next().value;
          if (this.trends.has(matchId)) {
            id = matchId;
            existing = this.trends.get(id);
          }
        }
      }
    }

    const firstSeen = existing ? existing.firstSeen : now;
    const lastUpdated = now;
    const ageSeconds = Math.max(0, Math.round((now - firstSeen) / 1000));

    // Aggregate sources and activity
    const sourcesSet = new Set(existing ? existing.sources : []);
    sourcesSet.add(sourceName);
    const sources = Array.from(sourcesSet);
    const sourceCount = sources.length;

    // Combine raw activity
    const newActivity = Number(rawItem.rawActivity) || 100;
    const rawActivity = existing ? Math.max(existing.rawActivity, newActivity) + Math.round(newActivity * 0.2) : newActivity;

    // Update history snapshot for velocity
    let history = this.historySnapshots.get(id) || [];
    history.push({ timestamp: now, rawActivity });
    if (history.length > 20) history = history.slice(-20);
    this.historySnapshots.set(id, history);

    // Calculate metrics
    const velocity = this.calculateVelocity(id, rawActivity, now);
    const recencyScore = this.calculateRecencyScore(ageSeconds);

    // Cross-source score: 1 source = 40, 2 sources = 75, 3+ sources = 100
    const crossSourceScore = Math.min(100, sourceCount === 1 ? 40 : sourceCount === 2 ? 75 : 100);

    // Source quality score based on configured source weights
    let sourceWeightSum = 0;
    for (const src of sources) {
      sourceWeightSum += this.config.sourceWeights[src] || this.config.sourceWeights.default || 0.5;
    }
    const avgSourceWeight = sourceWeightSum / sourceCount;
    const sourceScore = Math.min(100, Math.round(avgSourceWeight * 100));

    // Activity score (logarithmic 0-100)
    const activityScore = Math.min(100, Math.round(Math.min(100, Math.log10(Math.max(10, rawActivity)) * 25)));

    // Composite trend score
    const w = this.config.weights;
    const trendScore = Math.max(0, Math.min(100, Math.round(
      velocity * w.velocity +
      recencyScore * w.recency +
      crossSourceScore * w.crossSource +
      sourceScore * w.sourceQuality +
      activityScore * w.activity
    )));

    // Confidence: combination of crossSource, source quality, and observation frequency
    const confidence = Math.max(0, Math.min(100, Math.round(
      crossSourceScore * 0.55 + sourceScore * 0.35 + Math.min(10, history.length) * 1.0
    )));

    // Lifecycle and breakout status
    const { status, lifecycleState } = this.determineLifecycleState(ageSeconds, trendScore, velocity);
    const breakout = (trendScore >= this.config.breakoutThreshold && velocity >= 80) || velocity >= 92;

    // Expand keywords
    const keywords = this.expandKeywords(rawItem.name, [
      ...(existing ? existing.keywords : []),
      ...(rawItem.keywords || [])
    ]);

    const category = rawItem.category || (existing ? existing.category : 'emerging_narrative');

    const trendObject = {
      id,
      name: rawItem.name,
      keywords,
      category,
      sources,
      sourceCount,
      firstSeen,
      lastUpdated,
      ageSeconds,
      rawActivity,
      velocity,
      recencyScore,
      sourceScore,
      crossSourceScore,
      trendScore,
      confidence,
      status,
      lifecycleState,
      breakout,
    };

    this.trends.set(id, trendObject);

    // Update keyword inverted index for sub-millisecond lookups
    for (const kw of keywords) {
      if (!this.keywordIndex.has(kw)) {
        this.keywordIndex.set(kw, new Set());
      }
      this.keywordIndex.get(kw).add(id);
    }

    // Emit events if meaningful state change occurred
    this.handleEventEmission(trendObject, existing);

    return trendObject;
  }

  /**
   * Handle clean event emission without spamming duplicate events
   */
  handleEventEmission(trend, existing) {
    const lastEmitted = this.lastEmittedEvents.get(trend.id);
    const now = Date.now();

    if (!existing) {
      eventBus.emit('TREND_DETECTED', {
        trendId: trend.id,
        name: trend.name,
        trendScore: trend.trendScore,
        velocity: trend.velocity,
        confidence: trend.confidence,
        category: trend.category,
        sources: trend.sources,
        timestamp: now,
      });
      this.lastEmittedEvents.set(trend.id, {
        type: 'TREND_DETECTED',
        score: trend.trendScore,
        velocity: trend.velocity,
        timestamp: now,
      });
      return;
    }

    // Check breakout / accelerating event
    if (trend.breakout || trend.velocity >= 85) {
      if (!lastEmitted || lastEmitted.type !== 'TREND_ACCELERATING' || Math.abs(trend.velocity - lastEmitted.velocity) >= 5) {
        eventBus.emit('TREND_ACCELERATING', {
          trendId: trend.id,
          name: trend.name,
          trendScore: trend.trendScore,
          velocity: trend.velocity,
          confidence: trend.confidence,
          breakout: trend.breakout,
          timestamp: now,
        });
        this.lastEmittedEvents.set(trend.id, {
          type: 'TREND_ACCELERATING',
          score: trend.trendScore,
          velocity: trend.velocity,
          timestamp: now,
        });
        return;
      }
    }

    // Meaningful update event (score change >= 6 or new source added)
    if (lastEmitted && Math.abs(trend.trendScore - lastEmitted.score) >= 6) {
      eventBus.emit('TREND_UPDATED', {
        trendId: trend.id,
        name: trend.name,
        trendScore: trend.trendScore,
        velocity: trend.velocity,
        confidence: trend.confidence,
        status: trend.status,
        timestamp: now,
      });
      this.lastEmittedEvents.set(trend.id, {
        type: 'TREND_UPDATED',
        score: trend.trendScore,
        velocity: trend.velocity,
        timestamp: now,
      });
    }
  }

  /**
   * Refresh trends across all registered adapters asynchronously
   */
  async refreshTrends() {
    const now = Date.now();

    // 1. Run all adapters in parallel with fault tolerance
    const adapterPromises = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        const items = await adapter.fetchTrends();
        adapter.lastRun = now;
        adapter.errorCount = 0;
        return { source: adapter.name, items: Array.isArray(items) ? items : [] };
      } catch (err) {
        adapter.errorCount++;
        log(`[TREND HUNTER] Adapter [${adapter.name}] error: ${err.message}. Continues safely.`);
        return { source: adapter.name, items: [] };
      }
    });

    const results = await Promise.allSettled(adapterPromises);

    // 2. Ingest valid findings
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value && res.value.items) {
        for (const item of res.value.items) {
          try {
            this.ingestTrendItem(item, res.value.source, now);
          } catch (itemErr) {
            log(`[TREND HUNTER] Ingest error for ${item?.name}: ${itemErr.message}`);
          }
        }
      }
    }

    // 3. Apply aging and expire stale trends
    this.pruneStaleTrends(now);
    this.cacheTimestamp = now;
  }

  /**
   * Prune expired trends and re-calculate decay for inactive ones
   */
  pruneStaleTrends(now = Date.now()) {
    for (const [id, trend] of this.trends.entries()) {
      const ageSeconds = Math.max(0, Math.round((now - trend.firstSeen) / 1000));
      const idleSeconds = Math.max(0, Math.round((now - trend.lastUpdated) / 1000));

      trend.ageSeconds = ageSeconds;
      trend.recencyScore = this.calculateRecencyScore(ageSeconds);

      // Re-evaluate lifecycle
      const { status, lifecycleState } = this.determineLifecycleState(ageSeconds, trend.trendScore, trend.velocity);
      trend.status = status;
      trend.lifecycleState = lifecycleState;

      // If expired, clean up index and emit event
      if (status === 'EXPIRED' || (idleSeconds * 1000 > this.config.trendExpiryMs)) {
        eventBus.emit('TREND_EXPIRED', {
          trendId: id,
          name: trend.name,
          timestamp: now
        });

        // Remove from keyword index
        for (const kw of trend.keywords) {
          const ids = this.keywordIndex.get(kw);
          if (ids) {
            ids.delete(id);
            if (ids.size === 0) this.keywordIndex.delete(kw);
          }
        }

        this.trends.delete(id);
        this.historySnapshots.delete(id);
        this.lastEmittedEvents.delete(id);
      }
    }
  }

  /**
   * Start background asynchronous intelligence loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    log(`[TREND HUNTER] Starting Trend Intelligence Agent (Refresh: ${this.config.refreshIntervalMs}ms)`);

    // Initial immediate background fetch
    this.refreshTrends().catch((err) => {
      log(`[TREND HUNTER] Initial background refresh error: ${err.message}`);
    });

    this.pollingTimer = setInterval(() => {
      this.refreshTrends().catch((err) => {
        log(`[TREND HUNTER] Background refresh cycle error: ${err.message}`);
      });
    }, this.config.refreshIntervalMs);
  }

  /**
   * Stop background polling
   */
  stop() {
    this.isRunning = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    log('[TREND HUNTER] Stopped Trend Intelligence Agent');
  }

  /**
   * Get active non-expired trends sorted by trendScore
   */
  getActiveTrends() {
    return Array.from(this.trends.values())
      .filter((t) => t.status !== 'EXPIRED' && t.trendScore >= (this.config.minTrendScore || 0))
      .sort((a, b) => b.trendScore - a.trendScore);
  }

  /**
   * Get trend by name or keyword
   */
  getTrend(nameOrKeyword) {
    if (!nameOrKeyword) return null;
    const id = this.normalizeId(nameOrKeyword);
    if (this.trends.has(id)) {
      return this.trends.get(id);
    }

    const cleanKw = this.normalizeKeyword(nameOrKeyword);
    const trendIds = this.keywordIndex.get(cleanKw);
    if (trendIds && trendIds.size > 0) {
      const firstId = trendIds.values().next().value;
      return this.trends.get(firstId) || null;
    }

    return null;
  }

  /**
   * Fast In-Memory Token-to-Trend Matcher
   * Sub-millisecond execution for zero latency on fast token streams
   * @param {Object} token - { name, symbol, description }
   * @returns {Object} matchResult
   */
  matchTokenToTrends({ name = '', symbol = '', description = '' } = {}) {
    const defaultRes = {
      matched: false,
      trendId: null,
      trendName: null,
      trendScore: 0,
      confidence: 0,
      keywordMatch: null,
      breakout: false,
    };

    if (!name && !symbol && !description) {
      return defaultRes;
    }

    // Build word list from token fields with boundary awareness
    const corpus = `${name} ${symbol} ${description}`.toLowerCase();
    const tokenTokens = new Set([
      ...name.toLowerCase().split(/[\s_\-]+/),
      ...symbol.toLowerCase().split(/[\s_\-]+/),
      ...description.toLowerCase().split(/[\s_\-]+/),
    ]);

    let bestMatch = null;

    // Search against active keyword index
    for (const [kw, trendIds] of this.keywordIndex.entries()) {
      if (kw.length < this.config.minKeywordLength || this.config.stopWords.has(kw)) continue;

      // Word-boundary check: exact token word match or regex word boundary in corpus
      const isWordMatch = tokenTokens.has(kw);
      let matched = isWordMatch;

      if (!matched && kw.length >= 4) {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        matched = regex.test(corpus);
      }

      if (matched) {
        for (const tid of trendIds) {
          const trend = this.trends.get(tid);
          if (!trend || trend.status === 'EXPIRED') continue;

          if (!bestMatch || trend.trendScore > bestMatch.trendScore) {
            bestMatch = {
              matched: true,
              trendId: trend.id,
              trendName: trend.name,
              trendScore: trend.trendScore,
              confidence: trend.confidence,
              keywordMatch: kw,
              breakout: Boolean(trend.breakout),
            };
          }
        }
      }
    }

    return bestMatch || defaultRes;
  }
}

// Global Singleton Instance
export const trendHunterAgent = new TrendHunterAgent();
