import assert from 'assert';
import { SmartAgent } from './engines/smartAgent.js';
import { DevWatcher, RAW_TOKEN_DUMP_THRESHOLD } from './engines/devWatcher.js';
import { PositionManager } from './engines/positionManager.js';
import { TradeStorage } from './storage/tradeStorage.js';
import { Keypair } from '@solana/web3.js';

class MockConnection {
  constructor() {
    this.listeners = new Map();
    this.subId = 1;
  }
  async getAccountInfo() {
    return null;
  }
  onAccountChange(pubkey, cb) {
    const id = this.subId++;
    this.listeners.set(id, cb);
    return id;
  }
  removeAccountChangeListener(id) {
    this.listeners.delete(id);
  }
}

class MockExecutionEngine {
  async executeSell() {
    return { actualNetSellProceeds: 0.1, spotPriceSol: 0.00000003, route: 'MOCK_SELL' };
  }
  async executeBuy({ mint, solAmount }) {
    return { mint, solSpent: solAmount, rawTokensReceived: '10000000000', spotPriceSol: 0.00000001 };
  }
}

async function runBlindspotTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING VERIFICATION FOR PIPELINE BLIND SPOT FIXES');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, condition, message = '') {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}: ${message}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // TEST 1: SmartAgent Organic / Clean Launch Buyer Count
  // -------------------------------------------------------------
  console.log('--- TEST 1: SmartAgent Organic Fair Launch Buyer Count ---');
  {
    const agent = new SmartAgent({ baseMinExternalBuyers: 2, baseMinCompositeScore: 60 });
    
    // 1.1: Fair launch with 0 bundled snipers but 15 organic buyers
    const fairLaunchVerdict = agent.evaluateEntry({
      devPercent: 1.5,
      bundledBuysCount: 0,
      uniqueBuyersCount: 15,
      buyVolumeSol: 5.0,
      devSoldAny: false
    });

    test('1.1: Clean launch with 0 bundled snipers and 15 organic buyers passes evaluateEntry',
      fairLaunchVerdict.shouldTrade === true,
      `Verdict shouldTrade: ${fairLaunchVerdict.shouldTrade}, score: ${fairLaunchVerdict.score}, reason: ${fairLaunchVerdict.reason}`);

    // 1.2: Token with 1 bundled sniper and 8 organic curve buyers (like pebble.click!)
    const pebbleVerdict = agent.evaluateEntry({
      devPercent: 2.0,
      bundledBuysCount: 1,
      uniqueBuyersCount: 8,
      buyVolumeSol: 26.65,
      devSoldAny: false
    });

    test('1.2: pebble.click scenario (1 bundle, 8 organic buyers) passes with high conviction',
      pebbleVerdict.shouldTrade === true && pebbleVerdict.score >= 70,
      `pebble.click shouldTrade: ${pebbleVerdict.shouldTrade}, score: ${pebbleVerdict.score}, reason: ${pebbleVerdict.reason}`);

    // 1.3: Token with 0 bundles and 1 organic buyer correctly rejected for low activity
    const lowActivityVerdict = agent.evaluateEntry({
      devPercent: 1.0,
      bundledBuysCount: 0,
      uniqueBuyersCount: 1,
      buyVolumeSol: 0.1,
      devSoldAny: false
    });

    test('1.3: Token with insufficient buyers (1 < 2) correctly rejected',
      lowActivityVerdict.shouldTrade === false && lowActivityVerdict.reason.includes('INSUFFICIENT_BUYERS'),
      `Got shouldTrade: ${lowActivityVerdict.shouldTrade}, reason: ${lowActivityVerdict.reason}`);
  }

  // -------------------------------------------------------------
  // TEST 2: DevWatcher Dust Transfer vs Real Dump Threshold
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: DevWatcher Dust Transfer Immunity ---');
  {
    const mockConn = new MockConnection();
    let emergencyFrontrunTriggered = false;
    let emergencyFrontrunReason = '';

    const mockPm = {
      triggerEmergencyFrontrun: (mint, reason) => {
        emergencyFrontrunTriggered = true;
        emergencyFrontrunReason = reason;
      }
    };

    const devWatcher = new DevWatcher(mockConn, mockPm);
    const mintStr = Keypair.generate().publicKey.toBase58();
    const creatorKp = Keypair.generate();
    const creatorStr = creatorKp.publicKey.toBase58();

    await devWatcher.watchDev(mintStr, creatorStr);
    const rec = devWatcher.monitoredDevs.get(mintStr);

    // Initial dev balance: 50,000,000 tokens (50m * 1e6 = 50_000_000_000_000n)
    const initialBalBuf = Buffer.alloc(72);
    initialBalBuf.writeBigUInt64LE(50_000_000_000_000n, 64);
    devWatcher._processAccountUpdate(mintStr, creatorStr, initialBalBuf);

    test('2.1: Initial baseline balance established at 50M tokens',
      rec.peakBalance === 50_000_000_000_000n,
      `Peak balance: ${rec.peakBalance}`);

    // Dust transfer: dev moves 100 tokens (100 * 1e6 = 100_000_000n).
    // Balance drops from 50,000,000 to 49,999,900 tokens (0.0002% drop)
    const dustBalBuf = Buffer.alloc(72);
    dustBalBuf.writeBigUInt64LE(49_999_900_000_000n, 64);
    devWatcher._processAccountUpdate(mintStr, creatorStr, dustBalBuf);

    test('2.2: 100 token dust transfer does NOT trigger panic emergency frontrun',
      emergencyFrontrunTriggered === false,
      `emergencyFrontrunTriggered: ${emergencyFrontrunTriggered}`);

    // Real dump: dev dumps 25,000,000 tokens (50% of holding = 25_000_000_000_000n)
    const realDumpBalBuf = Buffer.alloc(72);
    realDumpBalBuf.writeBigUInt64LE(24_999_900_000_000n, 64);
    devWatcher._processAccountUpdate(mintStr, creatorStr, realDumpBalBuf);

    test('2.3: Large 50% dump triggers emergency frontrun liquidation',
      emergencyFrontrunTriggered === true && emergencyFrontrunReason === 'DEV_RUG_FRONTRUN',
      `Triggered: ${emergencyFrontrunTriggered}, reason: ${emergencyFrontrunReason}`);
  }

  // -------------------------------------------------------------
  // TEST 3: PositionManager Daily Loss Rehydration on Restart
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: PositionManager Daily Loss Cap Persistence ---');
  {
    // Save trade state with today's loss: -0.75 SOL
    const mockTrades = [
      {
        mint: 'LostMint1',
        netProfitSol: -0.75,
        profitSol: -0.75,
        closedAt: new Date().toISOString(),
      }
    ];

    // Backup current storage
    const originalState = TradeStorage.loadState();
    TradeStorage.saveState([], mockTrades);

    // Boot a new PositionManager as if server just restarted
    const rebootedPm = new PositionManager(new MockExecutionEngine());

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    let expectedTodayLoss = 0;
    for (const th of rebootedPm.tradeHistory) {
      const tradeTime = th.closedAt ? new Date(th.closedAt).getTime() : (th.timestamp ? new Date(th.timestamp).getTime() : 0);
      const pnl = th.netProfitSol !== undefined ? th.netProfitSol : (th.profitSol !== undefined ? th.profitSol : (th.realizedPnlSol || 0));
      if (tradeTime >= todayStartMs && pnl < 0) {
        expectedTodayLoss += Math.abs(pnl);
      }
    }

    test('3.1: Rehydrated dailyRealizedLossSol matches sum of today\'s losses in trade history',
      Math.abs(rebootedPm.dailyRealizedLossSol - expectedTodayLoss) < 0.001,
      `rebootedPm.dailyRealizedLossSol: ${rebootedPm.dailyRealizedLossSol} vs expected: ${expectedTodayLoss}`);

    const baseLoss = rebootedPm.dailyRealizedLossSol;
    rebootedPm.setDailyLossCap(baseLoss + 0.50);

    test('3.2: Sub-cap loss is within cap (isDailyLossExceeded is false)',
      rebootedPm.isDailyLossExceeded() === false,
      `isDailyLossExceeded: ${rebootedPm.isDailyLossExceeded()}`);

    // Add another loss of +0.60 SOL to breach cap
    rebootedPm.dailyRealizedLossSol += 0.60;

    test('3.3: Total loss breaching cap triggers isDailyLossExceeded circuit breaker',
      rebootedPm.isDailyLossExceeded() === true,
      `isDailyLossExceeded: ${rebootedPm.isDailyLossExceeded()}, Loss: ${rebootedPm.dailyRealizedLossSol}`);

    // Restore original state
    TradeStorage.saveState(originalState.positions || [], originalState.tradeHistory || []);
  }

  console.log('\n================================================================');
  console.log(`🏁 BLIND SPOT FIX VERIFICATION: ${passed} PASSED, ${failed} FAILED (${passed + failed} total tests)`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runBlindspotTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
