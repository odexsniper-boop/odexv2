import { BuyerQualityEngine } from './engines/buyerQualityEngine.js';
import { validateMoneyFlow } from './engines/manipulationEngine.js';

console.log('🧪 Starting BuyerQualityEngine & Sybil Defense Test Suite...\n');

let testsPassed = 0;
let testsTotal = 0;

function assert(condition, message) {
  testsTotal++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    testsPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------------------------------------------
// Test 1: Organic Independent Buyers (Clean Launch)
// -------------------------------------------------------------------------------------------------
console.log('Test 1: Pure Organic Buyer Distribution (10 independent buyers)');
const engine = new BuyerQualityEngine();
const mintClean = 'CleanTokenMint111111111111111111111111111111';

for (let i = 0; i < 10; i++) {
  const wallet = `Wallet_Indep_${i}_${'x'.repeat(20)}`;
  const solAmount = 0.05 + (i * 0.08); // Varying sizes: 0.05 to 0.77 SOL
  const slot = 1000 + (i * 5);        // Distinct slots
  const timestamp = 1700000000000 + (i * 2000); // 2 seconds apart
  engine.recordBuy(mintClean, wallet, solAmount, timestamp, slot);
}

const cleanEval = engine.evaluateBuyerQuality(mintClean);
assert(cleanEval.rawBuyerCount === 10, `Raw buyer count is 10 (got ${cleanEval.rawBuyerCount})`);
assert(cleanEval.organicBuyerCount === 10, `Organic buyer count is 10 (got ${cleanEval.organicBuyerCount})`);
assert(cleanEval.clusterCount === 0, `No clusters detected (got ${cleanEval.clusterCount})`);
assert(cleanEval.coordinationRisk === 'LOW', `Coordination risk is LOW (got ${cleanEval.coordinationRisk})`);
assert(!cleanEval.isHardVeto, 'No hard veto triggered');

const cleanFlow = validateMoneyFlow({
  buyVolumeSol: cleanEval.organicBuyVolumeSol,
  sellVolumeSol: 0.1,
  uniqueBuyersCount: cleanEval.organicBuyerCount,
  organicBuyersCount: cleanEval.organicBuyerCount,
  rawBuyersCount: cleanEval.rawBuyerCount,
  clusterRisk: cleanEval.coordinationRisk,
  txCount: 15,
});
assert(cleanFlow.passed === true, `Clean launch passes Stage 2 Money Flow (score: ${cleanFlow.score})`);

// -------------------------------------------------------------------------------------------------
// Test 2: User's Scenario - 10 Wallets, 6 Clustered Sybils, 4 Organic -> WAIT / FAIL
// -------------------------------------------------------------------------------------------------
console.log('\nTest 2: User Scenario - 10 Unique Wallets (6 Clustered Sybils + 4 Organic Independent)');
const mintSybil = 'SybilAttackMint222222222222222222222222222';

// 6 Synchronized Sybil Wallets (same slot 5555, identical 0.10 SOL buy)
const now = Date.now();
for (let i = 0; i < 6; i++) {
  const sybilWallet = `Sybil_Bot_${i}_${'s'.repeat(25)}`;
  engine.recordBuy(mintSybil, sybilWallet, 0.10, now + (i * 10), 5555); // Same slot, within 50ms
}

// 4 Genuine Independent Buyers (different slots, different sizes, spaced out)
for (let i = 0; i < 4; i++) {
  const retailWallet = `Retail_Buyer_${i}_${'r'.repeat(24)}`;
  const retailAmount = 0.25 + (i * 0.15);
  engine.recordBuy(mintSybil, retailWallet, retailAmount, now + 5000 + (i * 3000), 5600 + (i * 10));
}

const sybilEval = engine.evaluateBuyerQuality(mintSybil);
assert(sybilEval.rawBuyerCount === 10, `Raw buyer count is 10 (got ${sybilEval.rawBuyerCount})`);
assert(sybilEval.largestClusterSize === 6, `Detected 6-wallet synchronized cluster (got ${sybilEval.largestClusterSize})`);
// 6 wallets collapsed into 1 entity + 4 independent buyers = 5 entities
assert(sybilEval.organicBuyerCount === 5, `6 sybils collapsed: organic entities count is 5 (got ${sybilEval.organicBuyerCount})`);
assert(sybilEval.coordinationRisk === 'CRITICAL' || sybilEval.coordinationRisk === 'HIGH', `High/Critical coordination risk detected (got ${sybilEval.coordinationRisk})`);

// Now test Money Flow: With 6 sybils clustered, test with 4 organic buyers
const sybilFlowCritical = validateMoneyFlow({
  buyVolumeSol: sybilEval.organicBuyVolumeSol,
  sellVolumeSol: 0.2,
  uniqueBuyersCount: 4,
  organicBuyersCount: 4,
  rawBuyersCount: 10,
  clusterRisk: sybilEval.coordinationRisk, // 'CRITICAL'
  txCount: 12,
});
assert(sybilFlowCritical.passed === false, `Stage 2 Money Flow FAILS on critical cluster risk (passed: ${sybilFlowCritical.passed})`);
assert(sybilFlowCritical.reason === 'CRITICAL_CLUSTER_RISK', `Failure reason is CRITICAL_CLUSTER_RISK (got: ${sybilFlowCritical.reason})`);

// Now test Money Flow when cluster risk is HIGH with 4 organic buyers
const sybilFlowWait = validateMoneyFlow({
  buyVolumeSol: sybilEval.organicBuyVolumeSol,
  sellVolumeSol: 0.2,
  uniqueBuyersCount: 4,
  organicBuyersCount: 4,
  rawBuyersCount: 10,
  clusterRisk: 'HIGH',
  txCount: 12,
});
assert(sybilFlowWait.passed === false, `Stage 2 Money Flow WAITS on 4 organic buyers (passed: ${sybilFlowWait.passed})`);
assert(sybilFlowWait.reason.includes('INSUFFICIENT_ORGANIC_BUYERS'), `Failure reason is INSUFFICIENT_ORGANIC_BUYERS (got: ${sybilFlowWait.reason})`);

// -------------------------------------------------------------------------------------------------
// Test 3: Common Funder Detection
// -------------------------------------------------------------------------------------------------
console.log('\nTest 3: Common Funder Detection (Parent Wallet Clustering)');
const mintFunder = 'CommonFunderMint333333333333333333333333';
const parentFunder = 'ParentDispenserWallet11111111111111111111';

const fundedWallet1 = 'Funded_Child_A_111111111111111111111111';
const fundedWallet2 = 'Funded_Child_B_222222222222222222222222';
const fundedWallet3 = 'Funded_Child_C_333333333333333333333333';

engine.funderCache.set(fundedWallet1, parentFunder);
engine.funderCache.set(fundedWallet2, parentFunder);
engine.funderCache.set(fundedWallet3, parentFunder);

// Buys in different slots, but sharing parent funder
engine.recordBuy(mintFunder, fundedWallet1, 0.4, now + 1000, 7001);
engine.recordBuy(mintFunder, fundedWallet2, 0.3, now + 4000, 7010);
engine.recordBuy(mintFunder, fundedWallet3, 0.5, now + 8000, 7025);

const funderEval = engine.evaluateBuyerQuality(mintFunder);
assert(funderEval.rawBuyerCount === 3, `Raw buyer count is 3 (got ${funderEval.rawBuyerCount})`);
assert(funderEval.organicBuyerCount === 1, `All 3 wallets collapsed to 1 entity via common funder (got ${funderEval.organicBuyerCount})`);
assert(funderEval.clusterCount === 1, '1 cluster detected');

// -------------------------------------------------------------------------------------------------
// Test 4: Extreme Coordinated Cartel Hard Veto
// -------------------------------------------------------------------------------------------------
console.log('\nTest 4: Extreme Sybil Cartel (>60% Volume in 1 Cluster -> Hard Veto)');
const mintCartel = 'ExtremeCartelMint4444444444444444444444';

// 6 wallets buy 1.0 SOL each in same slot (6.0 SOL total out of 7.0 SOL = 85.7% volume)
for (let i = 0; i < 6; i++) {
  engine.recordBuy(mintCartel, `Cartel_Member_${i}_${'c'.repeat(25)}`, 1.0, now + (i * 20), 9999);
}
// 1 retail buys 0.5 SOL
engine.recordBuy(mintCartel, 'InnocentRetailWallet_111111111111111111', 0.5, now + 3000, 10010);

const cartelEval = engine.evaluateBuyerQuality(mintCartel);
assert(cartelEval.isHardVeto === true, `Extreme cluster triggers isHardVeto === true (got ${cartelEval.isHardVeto})`);
assert(cartelEval.coordinationRisk === 'CRITICAL', `Coordination risk is CRITICAL (got ${cartelEval.coordinationRisk})`);
assert(cartelEval.largestClusterVolumeShare > 0.60, `Cluster volume share > 60% (got ${(cartelEval.largestClusterVolumeShare * 100).toFixed(1)}%)`);

// -------------------------------------------------------------------------------------------------
// Test 5: Sybil Volume Discounting (Stripping Wash Volume)
// -------------------------------------------------------------------------------------------------
console.log('\nTest 5: Sybil Wash Volume Discounting');
assert(cartelEval.organicBuyVolumeSol < cartelEval.totalBuyVolumeSol, 
  `Wash volume discounted: total=${cartelEval.totalBuyVolumeSol} SOL, organic=${cartelEval.organicBuyVolumeSol} SOL`);

console.log(`\n========================================`);
console.log(`🎉 Test Results: ${testsPassed}/${testsTotal} assertions passed successfully!`);
console.log(`========================================\n`);
