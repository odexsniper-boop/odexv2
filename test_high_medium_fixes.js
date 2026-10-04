import { narrativeEngine } from './engines/narrativeEngine.js';
import { socialEngine } from './engines/socialEngine.js';
import { Orchestrator } from './engines/orchestrator.js';
import { TokenState, TokenRecord } from './engines/stateMachine.js';
import { fetchTokenMetadata } from './engines/metadataFetcher.js';
import { TokenProgramResolver, TOKEN_PROGRAM_ID } from './engines/tokenProgramResolver.js';

console.log('🧪 Starting High & Medium Fixes Verification Suite...\n');

let passed = 0;
let failed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name} -> ${details}`);
    failed++;
  }
}

async function runTests() {
  // -------------------------------------------------------------
  // Test 1: High Severity - Influencer Twitter Spoofing Rejected
  // -------------------------------------------------------------
  console.log('--- [FIX 1] Testing Influencer Twitter Spoofing Prevention ---');
  {
    const spoofedMetadata = {
      name: 'Elon Coin',
      symbol: 'ELON',
      description: 'Official token endorsed by Elon Musk on Solana.',
      twitter: 'https://x.com/elonmusk',
    };

    const sentiment = socialEngine.checkSentiment(spoofedMetadata);
    test('1.1: SocialEngine penalizes spoofed celebrity Twitter handle (-50 points)',
      sentiment.bonusScore < 0 && sentiment.reason.includes('Flagged Impersonated Celebrity Account'),
      `bonusScore: ${sentiment.bonusScore}, reason: ${sentiment.reason}`);

    const narrativeResult = narrativeEngine.evaluateNarrative(spoofedMetadata);
    test('1.2: NarrativeEngine rejects celebrity handle as valid token social (0 socialsFound)',
      narrativeResult.socialsFound === 0,
      `socialsFound: ${narrativeResult.socialsFound}, reasons: ${narrativeResult.reasons.join('; ')}`);
    test('1.3: Spoofed coin receives severe penalty and fails or receives low score',
      narrativeResult.narrativeScore <= 35,
      `score: ${narrativeResult.narrativeScore}`);
  }

  // -------------------------------------------------------------
  // Test 2: Medium Severity - Description-Only Tokens Receive Probation
  // -------------------------------------------------------------
  console.log('\n--- [FIX 2] Testing Description-Only Evidence Classification ---');
  {
    const descOnlyToken = narrativeEngine.evaluateNarrative({
      name: 'Autonomous AI Terminal',
      symbol: 'AITERM',
      description: 'Decentralized autonomous AI agent compute engine built on Solana utilizing deep learning models.',
      // No twitter, no telegram, no website, no replies
    });

    test('2.1: Description-only token without socials or replies is classified as PROBATION (not VERIFIED)',
      descOnlyToken.eligibilityState === 'PROBATION',
      `eligibilityState: ${descOnlyToken.eligibilityState}`);
    test('2.2: Description-only token flags requiresExceptionalMomentum = true',
      descOnlyToken.requiresExceptionalMomentum === true,
      `requiresExceptionalMomentum: ${descOnlyToken.requiresExceptionalMomentum}`);
    test('2.3: Genuine token with Twitter and Telegram achieves VERIFIED status',
      (() => {
        const fullToken = narrativeEngine.evaluateNarrative({
          name: 'Autonomous AI Terminal',
          symbol: 'AITERM',
          description: 'Decentralized autonomous AI agent compute engine built on Solana.',
          twitter: 'https://x.com/aiterm_protocol',
          telegram: 'https://t.me/aiterm_portal'
        });
        return fullToken.eligibilityState === 'VERIFIED' && !fullToken.requiresExceptionalMomentum;
      })(),
      'Failed to grant VERIFIED status to legitimate token with verified socials');
  }

  // -------------------------------------------------------------
  // Test 3: Medium Severity - Watchlist Clone Trap Fixed
  // -------------------------------------------------------------
  console.log('\n--- [FIX 3] Testing Watchlist Clone Protection ---');
  {
    const orch = new Orchestrator({ autoBuyEnabled: false });
    
    // Create an old dormant token in watchlist
    const oldMint = 'OldMint1111111111111111111111111111111111111';
    const oldRec = new TokenRecord(oldMint);
    oldRec.name = 'DeepSeek AI Agent';
    oldRec.state = TokenState.LIGHTWEIGHT_WATCHLIST;
    orch.tokens.set(oldMint, oldRec);

    // Now a brand new coin launches with the identical name
    const newMint = 'NewMint2222222222222222222222222222222222222';
    const newRecord = await orch.handleTokenLaunch({
      mint: newMint,
      name: 'DeepSeek AI Agent',
      symbol: 'DSAI',
      description: 'Autonomous deepseek artificial intelligence agent compute framework',
      twitter: 'https://x.com/deepseek_agent',
      telegram: 'https://t.me/deepseek_agent',
      creator: 'CreatorABC1111111111111111111111111111111111',
      devPercent: 2.0,
      bundledBuysCount: 1,
      bundlePercent: 5.0,
    });

    test('3.1: New launch with same name as dormant watchlist token is NOT rejected as CLONE_SPAM',
      newRecord.state !== TokenState.REJECTED && newRecord.state !== TokenState.DEAD,
      `State: ${newRecord.state}, rejectionReason: ${newRecord.rejectionReason}`);

    // However, if another token is actively in MONEY_FLOW_WATCH, it SHOULD block copycats
    const activeMint = 'ActiveMint3333333333333333333333333333333333';
    const activeRec = new TokenRecord(activeMint);
    activeRec.name = 'Claude AI Agent';
    activeRec.state = TokenState.MONEY_FLOW_WATCH;
    orch.tokens.set(activeMint, activeRec);

    const cloneMint = 'CloneMint4444444444444444444444444444444444';
    const cloneRecord = await orch.handleTokenLaunch({
      mint: cloneMint,
      name: 'Claude AI Agent',
      symbol: 'CLAUDE',
      description: 'Anthropic claude artificial intelligence agent compute framework',
      twitter: 'https://x.com/claude_agent',
      telegram: 'https://t.me/claude_agent',
      creator: 'CreatorXYZ1111111111111111111111111111111111',
      devPercent: 2.0,
      bundledBuysCount: 1,
      bundlePercent: 5.0,
    });

    test('3.2: Duplicate clone of actively tracked token (MONEY_FLOW_WATCH) IS rejected as CLONE_SPAM',
      cloneRecord.state === TokenState.REJECTED && cloneRecord.rejectionReason.includes('CLONE_SPAM'),
      `State: ${cloneRecord.state}, rejectionReason: ${cloneRecord.rejectionReason}`);
  }

  // -------------------------------------------------------------
  // Test 4: Medium Severity - Bounded Caching
  // -------------------------------------------------------------
  console.log('\n--- [FIX 4] Testing Bounded Caching in TokenProgramResolver ---');
  {
    const resolver = new TokenProgramResolver(null);
    test('4.1: TokenProgramResolver initialized with maxCacheSize of 5000',
      resolver.maxCacheSize === 5000,
      `maxCacheSize: ${resolver.maxCacheSize}`);

    // Fill cache with 5005 entries
    for (let i = 0; i < 5005; i++) {
      resolver._setCache(`mint_${i}`, TOKEN_PROGRAM_ID);
    }

    test('4.2: TokenProgramResolver cache capped at 5000 entries (LRU eviction verified)',
      resolver.cache.size === 5000 && !resolver.cache.has('mint_0') && resolver.cache.has('mint_5004'),
      `cache.size: ${resolver.cache.size}`);
  }

  console.log('\n================================================================');
  console.log(`🏁 HIGH & MEDIUM FIXES RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
