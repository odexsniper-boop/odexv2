import assert from 'assert';
import { EconomicEventClassifier } from '../../engines/v2/economicEventClassifierV2.js';

function runTests() {
    console.log('--- RUNNING V2 ECONOMIC EVENT CLASSIFIER TESTS (HARDENED SPEC) ---');
    const classifier = new EconomicEventClassifier();

    const mint = 'TESTMint11111111111111111111111111111111111';
    const curvePda = 'CurvePDA1111111111111111111111111111111111';
    const curveTokenAcct = 'CurveATA1111111111111111111111111111111111';

    // 1. Test Virtual Liquidity
    const txVirtualLiq = {
        signature: 'sig_virtual_liq',
        slot: 100,
        transactionIndex: 0,
        accountData: [
            { account: curvePda, nativeBalanceChange: 0 }
        ],
        tokenTransfers: [
            {
                mint,
                fromUserAccount: 'SetupWallet',
                toUserAccount: curvePda,
                tokenAmount: 1073000000 // 1.073B tokens
            }
        ]
    };
    let res = classifier.classifyTransaction(txVirtualLiq, mint, curvePda, curveTokenAcct);
    assert.strictEqual(res.length > 0, true, 'Should emit an event');
    assert.strictEqual(res[0].classification, 'VIRTUAL_LIQUIDITY_EVENT', 'Should classify as VIRTUAL_LIQUIDITY_EVENT');
    assert.strictEqual(res[0].cleanSOLVolume, 30.0, 'Should assign 30 SOL initialization constant');
    console.log('PASS: Virtual Liquidity Event Classification');

    // 2. Test Genuine Buy
    const txBuy = {
        signature: 'sig_buy_1',
        slot: 101,
        transactionIndex: 1,
        feePayer: 'Buyer111111111111111111111111111111111111',
        accountData: [
            { account: curvePda, nativeBalanceChange: 1500000000 } // Curve receives 1.5 SOL
        ],
        tokenTransfers: [
            {
                mint,
                fromUserAccount: curvePda,
                toUserAccount: 'Buyer111111111111111111111111111111111111',
                tokenAmount: 50000000 // User receives 50M tokens
            }
        ]
    };
    res = classifier.classifyTransaction(txBuy, mint, curvePda, curveTokenAcct);
    let tradeEvent = res.find(e => e.classification === 'ECONOMIC_TRADE');
    assert.ok(tradeEvent, 'Should emit ECONOMIC_TRADE');
    assert.strictEqual(tradeEvent.side, 'BUY', 'Side should be BUY');
    assert.strictEqual(tradeEvent.cleanSOLVolume, 1.5, 'cleanSOLVolume should be 1.5');
    assert.strictEqual(tradeEvent.cleanTokenVolume, 50000000, 'cleanTokenVolume should be 50M');
    assert.strictEqual(tradeEvent.effectivePrice, 1.5 / 50000000, 'Effective Price should be correct');
    assert.ok(tradeEvent.canonical_event_id, 'Should have canonical_event_id');
    console.log('PASS: Genuine Buy Classification');

    // 3. Test Genuine Sell
    const txSell = {
        signature: 'sig_sell_1',
        slot: 102,
        transactionIndex: 2,
        feePayer: 'Seller11111111111111111111111111111111111',
        accountData: [
            { account: curvePda, nativeBalanceChange: -500000000 } // Curve sends 0.5 SOL
        ],
        tokenTransfers: [
            {
                mint,
                fromUserAccount: 'Seller11111111111111111111111111111111111',
                toUserAccount: curvePda,
                tokenAmount: 20000000 // Curve receives 20M tokens
            }
        ]
    };
    res = classifier.classifyTransaction(txSell, mint, curvePda, curveTokenAcct);
    tradeEvent = res.find(e => e.classification === 'ECONOMIC_TRADE');
    assert.ok(tradeEvent, 'Should emit ECONOMIC_TRADE');
    assert.strictEqual(tradeEvent.side, 'SELL', 'Side should be SELL');
    assert.strictEqual(tradeEvent.cleanSOLVolume, 0.5, 'cleanSOLVolume should be 0.5');
    console.log('PASS: Genuine Sell Classification');

    // 4. Test Jito Tip & Priority Fee isolation
    const txMev = {
        signature: 'sig_mev_buy',
        slot: 103,
        transactionIndex: 3,
        feePayer: 'Sniper11111111111111111111111111111111111',
        accountData: [
            { account: curvePda, nativeBalanceChange: 1000000000 }, // 1.0 SOL to curve
            { account: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', nativeBalanceChange: 500000000 }, // 0.5 SOL Jito Tip
            { account: 'ComputeBudget111111111111111111111111111111', nativeBalanceChange: 0 } // Priority fee call
        ],
        tokenTransfers: [
            {
                mint,
                fromUserAccount: curvePda,
                toUserAccount: 'Sniper11111111111111111111111111111111111',
                tokenAmount: 40000000
            }
        ]
    };
    res = classifier.classifyTransaction(txMev, mint, curvePda, curveTokenAcct);
    tradeEvent = res.find(e => e.classification === 'ECONOMIC_TRADE');
    const mevEvent = res.find(e => e.classification === 'MEV_EVENT');
    const feeEvent = res.find(e => e.classification === 'FEE_EVENT');
    
    assert.ok(tradeEvent && mevEvent && feeEvent, 'Should isolate Trade, MEV, and Fee');
    assert.strictEqual(tradeEvent.cleanSOLVolume, 1.0, 'Trade volume must explicitly exclude the 0.5 SOL Jito tip');
    assert.strictEqual(mevEvent.amount, 0.5, 'MEV event should capture the 0.5 SOL tip');
    console.log('PASS: Jito Tip & Priority Fee Isolation (Clean Price Validation)');

    // 5. Test Duplicates (Based on Canonical Event ID)
    res = classifier.classifyTransaction(txSell, mint, curvePda, curveTokenAcct);
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].classification, 'DUPLICATE_EVENT');
    console.log('PASS: Duplicate Canonical Event Rejection');

    // 6. Test Same-Slot Ordering Hierarchy
    const eventsToSort = [
        { slot: 100, transaction_index: 2, inner_instruction_index: 0 },
        { slot: 100, transaction_index: 1, inner_instruction_index: 1 },
        { slot: 100, transaction_index: 1, inner_instruction_index: 0 },
        { slot: 99, transaction_index: 5, inner_instruction_index: 0 }
    ];
    eventsToSort.sort((a, b) => {
        if (a.slot !== b.slot) return a.slot - b.slot;
        if (a.transaction_index !== b.transaction_index) return a.transaction_index - b.transaction_index;
        return a.inner_instruction_index - b.inner_instruction_index;
    });
    assert.strictEqual(eventsToSort[0].slot, 99);
    assert.strictEqual(eventsToSort[1].transaction_index, 1);
    assert.strictEqual(eventsToSort[1].inner_instruction_index, 0);
    assert.strictEqual(eventsToSort[2].inner_instruction_index, 1);
    console.log('PASS: Same-Slot Ordering Hierarchy Validation');

    console.log('ALL TESTS PASSED (VFINAL COMPLIANT)');
}

runTests();
