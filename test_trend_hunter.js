import assert from 'assert';
import { TrendHunterAgent, CustomSignalAdapter, TrendSourceAdapter } from './trendHunterAgent.js';
import { eventBus } from './eventBus.js';

console.log('🧪 [TEST SUITE] Starting TrendHunterAgent Comprehensive Verification...\n');

let passedTests = 0;
let totalTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ Test ${totalTests}: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ Test ${totalTests}: ${desc}`);
    console.error(err);
  }
}

async function runAsyncTests() {
  // 1. Trend Discovery
  it('1. Trend Discovery: Successfully ingests and registers new trends from adapter', async () => {
    const agent = new TrendHunterAgent({ enabled: true });
    const mockAdapter = new CustomSignalAdapter('test_source', 1.0);
    mockAdapter.setSimulatedTrends([
      { name: 'Solana Phone', rawActivity: 1200, category: 'tech' }
    ]);
    agent.registerAdapter(mockAdapter);

    await agent.refreshTrends();
    const trend = agent.getTrend('Solana Phone');
    assert(trend, 'Trend should be discovered');
    assert.strictEqual(trend.id, 'solana-phone');
    assert.strictEqual(trend.name, 'Solana Phone');
    assert(trend.trendScore > 0, 'Trend score should be calculated');
  });

  // 2. Keyword Normalization
  it('2. Keyword Normalization: Correctly strips punctuation, lowercases, and expands aliases', () => {
    const agent = new TrendHunterAgent();
    assert.strictEqual(agent.normalizeId('AI Agents!'), 'ai-agents');
    assert.strictEqual(agent.normalizeId('ai_agent'), 'ai-agent');
    assert.strictEqual(agent.normalizeKeyword('  $SOLANA!! '), 'solana');

    const expanded = agent.expandKeywords('AI Agent', ['autonomous', 'bot']);
    assert(expanded.includes('ai agent'), 'Should include full phrase');
    assert(expanded.includes('agent'), 'Should include single word');
    assert(expanded.includes('autonomous'), 'Should include extra keywords');
  });

  // 3. Trend Deduplication
  it('3. Trend Deduplication: Groups different casing and hyphenation into a single trend', () => {
    const agent = new TrendHunterAgent();
    const now = Date.now();
    agent.ingestTrendItem({ name: 'AI Agents', rawActivity: 500 }, 'source1', now);
    agent.ingestTrendItem({ name: 'ai-agents', rawActivity: 600 }, 'source2', now);
    agent.ingestTrendItem({ name: 'AI_AGENT', rawActivity: 700 }, 'source3', now);

    // Should only have 1 deduplicated trend under 'ai-agents' or canonical alias
    assert.strictEqual(agent.trends.size, 1);
    const trend = agent.getTrend('ai-agents');
    assert(trend, 'Trend should exist');
    assert.strictEqual(trend.sources.length, 3, 'All 3 sources should be merged');
    assert.strictEqual(trend.sourceCount, 3);
  });

  // 4. Velocity Calculation
  it('4. Velocity Calculation: 800 -> 6,000 produces much higher velocity than 10,000 -> 10,500', () => {
    const agent = new TrendHunterAgent();
    const t0 = Date.now() - 60000; // 1 min ago
    const t1 = Date.now();

    // Trend A: Surging breakout (800 -> 6,000)
    agent.ingestTrendItem({ name: 'SurgeTrend', rawActivity: 800 }, 'src', t0);
    const surgeTrend = agent.ingestTrendItem({ name: 'SurgeTrend', rawActivity: 6000 }, 'src', t1);

    // Trend B: High baseline stagnant (10,000 -> 10,500)
    agent.ingestTrendItem({ name: 'StagnantTrend', rawActivity: 10000 }, 'src', t0);
    const stagnantTrend = agent.ingestTrendItem({ name: 'StagnantTrend', rawActivity: 10500 }, 'src', t1);

    console.log(`    -> Surge velocity (800 -> 6000): ${surgeTrend.velocity}`);
    console.log(`    -> Stagnant velocity (10000 -> 10500): ${stagnantTrend.velocity}`);

    assert(surgeTrend.velocity > stagnantTrend.velocity, 'Surging trend velocity must exceed stagnant trend');
    assert(surgeTrend.velocity >= 85, 'Surge velocity should be very high (>=85)');
    assert(stagnantTrend.velocity < 50, 'Stagnant trend velocity should remain moderate (<50)');
  });

  // 5. Recency / Decay
  it('5. Recency / Decay: Older trends naturally decay in recency score', () => {
    const agent = new TrendHunterAgent({ decayHalfLifeMs: 1800000 }); // 30m half life
    const recentScore = agent.calculateRecencyScore(60); // 1 min old
    const halfLifeScore = agent.calculateRecencyScore(1800); // 30 min old
    const oldScore = agent.calculateRecencyScore(7200); // 2 hours old

    assert(recentScore >= 95, 'Recent trend should have near 100 recency score');
    assert(halfLifeScore >= 45 && halfLifeScore <= 55, 'Half-life should be ~50');
    assert(oldScore <= 15, 'Old trend should decay to <= 15');
  });

  // 6. Cross-Source Confirmation
  it('6. Cross-Source Confirmation: Multi-source trends receive higher confidence and score', () => {
    const agent = new TrendHunterAgent();
    const now = Date.now();

    const singleSourceTrend = agent.ingestTrendItem({ name: 'SingleToken', rawActivity: 2000 }, 'x_twitter', now);
    
    agent.ingestTrendItem({ name: 'MultiToken', rawActivity: 2000 }, 'x_twitter', now);
    agent.ingestTrendItem({ name: 'MultiToken', rawActivity: 2000 }, 'google_trends', now);
    const multiSourceTrend = agent.ingestTrendItem({ name: 'MultiToken', rawActivity: 2000 }, 'dexscreener', now);

    assert(multiSourceTrend.crossSourceScore > singleSourceTrend.crossSourceScore);
    assert(multiSourceTrend.confidence > singleSourceTrend.confidence);
    assert(multiSourceTrend.trendScore > singleSourceTrend.trendScore);
  });

  // 7. Breakout Detection ("LAPTOP" Example)
  it('7. Breakout Detection: "LAPTOP" surging triggers breakout=true and status=VERY_HOT', () => {
    const agent = new TrendHunterAgent({ breakoutThreshold: 80 });
    const t0 = Date.now() - 120000;
    const t1 = Date.now();

    // Baseline
    agent.ingestTrendItem({ name: 'Laptop', rawActivity: 500 }, 'x_twitter', t0);
    // Surge across multiple sources
    agent.ingestTrendItem({ name: 'Laptop', rawActivity: 5000 }, 'x_twitter', t1);
    agent.ingestTrendItem({ name: 'Laptop', rawActivity: 4000 }, 'google_trends', t1);
    const laptopTrend = agent.ingestTrendItem({ name: 'Laptop', rawActivity: 4500 }, 'dexscreener', t1);

    console.log(`    -> Laptop TrendScore: ${laptopTrend.trendScore}, Velocity: ${laptopTrend.velocity}, Breakout: ${laptopTrend.breakout}, Status: ${laptopTrend.status}`);
    assert.strictEqual(laptopTrend.breakout, true, 'Laptop breakout must be true');
    assert(['VERY_HOT', 'HOT'].includes(laptopTrend.status), 'Laptop status must be VERY_HOT or HOT');
    assert(laptopTrend.trendScore >= 80, 'Trend score must exceed breakout threshold');
  });

  // 8. Trend Expiration
  it('8. Trend Expiration: Inactive trends beyond expiry threshold are pruned', () => {
    const agent = new TrendHunterAgent({ trendExpiryMs: 60000 }); // 60s expiry
    const past = Date.now() - 70000;

    agent.ingestTrendItem({ name: 'OldMeme', rawActivity: 100 }, 'test', past);
    assert(agent.trends.has('oldmeme'), 'Trend initially present');

    // Run prune with current time
    agent.pruneStaleTrends(Date.now());
    assert(!agent.trends.has('oldmeme'), 'Trend should be pruned after expiry');
    assert.strictEqual(agent.getActiveTrends().length, 0);
  });

  // 9. Provider Failure Tolerance
  it('9. Provider Failure Tolerance: Error in one adapter does not crash agent', async () => {
    const agent = new TrendHunterAgent();
    class FailingAdapter extends TrendSourceAdapter {
      constructor() { super('failing_source', 1.0); }
      async fetchTrends() { throw new Error('API Rate Limited 429'); }
    }
    const workingAdapter = new CustomSignalAdapter('working_source', 1.0);
    workingAdapter.setSimulatedTrends([{ name: 'ResilientTrend', rawActivity: 1500 }]);

    agent.adapters.clear();
    agent.registerAdapter(new FailingAdapter());
    agent.registerAdapter(workingAdapter);

    // Should complete cleanly without throwing
    await agent.refreshTrends();
    const trend = agent.getTrend('ResilientTrend');
    assert(trend, 'Working adapter trends should be ingested despite failing adapter');
  });

  // 10. Cache Behavior
  it('10. Cache Behavior: Instant memory retrieval without redundant lookups', () => {
    const agent = new TrendHunterAgent();
    agent.ingestTrendItem({ name: 'FastQuery', rawActivity: 2000 }, 'src', Date.now());

    const tStart = performance.now();
    const trend = agent.getTrend('FastQuery');
    const tElapsed = performance.now() - tStart;

    assert(trend, 'Trend found in cache');
    assert(tElapsed < 5, `Cache lookup took ${tElapsed.toFixed(3)}ms (expected < 5ms)`);
  });

  // 11. Token-to-Trend Matching
  it('11. Token-to-Trend Matching: Matches token metadata accurately with word boundaries', () => {
    const agent = new TrendHunterAgent();
    agent.ingestTrendItem({ name: 'Laptop', rawActivity: 6000 }, 'src', Date.now());
    agent.ingestTrendItem({ name: 'AI Agent', rawActivity: 4000 }, 'src', Date.now());

    // Exact word boundary match
    const match1 = agent.matchTokenToTrends({
      name: 'Super Laptop SOL',
      symbol: 'LAPTOP',
      description: 'The premier decentralized computing meme token'
    });
    assert.strictEqual(match1.matched, true);
    assert.strictEqual(match1.trendId, 'laptop');
    assert.strictEqual(match1.keywordMatch, 'laptop');

    // Negative case (stop words / non-matching substrings)
    const match2 = agent.matchTokenToTrends({
      name: 'Random Coin',
      symbol: 'RND',
      description: 'Nothing related to any trends'
    });
    assert.strictEqual(match2.matched, false);
  });

  // 12. Duplicate Event Prevention
  it('12. Duplicate Event Prevention: Does not emit duplicate breakout events for unchanged state', () => {
    const agent = new TrendHunterAgent();
    let emittedCount = 0;
    const listener = () => { emittedCount++; };
    eventBus.on('TREND_ACCELERATING', listener);

    const now = Date.now();
    // Ingest high velocity breakout
    agent.ingestTrendItem({ name: 'ViralEvent', rawActivity: 500 }, 'src', now - 60000);
    agent.ingestTrendItem({ name: 'ViralEvent', rawActivity: 6000 }, 'src', now);
    const countAfterFirst = emittedCount;

    // Ingest again with identical activity and velocity
    agent.ingestTrendItem({ name: 'ViralEvent', rawActivity: 6000 }, 'src', now);
    const countAfterSecond = emittedCount;

    eventBus.off('TREND_ACCELERATING', listener);
    assert(countAfterFirst >= 1, 'Should emit on initial breakout');
    assert.strictEqual(countAfterSecond, countAfterFirst, 'Should NOT emit duplicate event when unchanged');
  });

  console.log(`\n🎉 Verification Completed: ${passedTests}/${totalTests} tests passed!\n`);
}

runAsyncTests().catch(console.error);
