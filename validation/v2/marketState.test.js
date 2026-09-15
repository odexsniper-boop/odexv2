import assert from 'assert';
import { MarketStateBuilder } from '../../engines/v2/marketStateBuilderV2.js';

function runTests() {
    console.log('--- RUNNING MARKET STATE & MONEY FLOW V2 TESTS ---');
    
    const builder = new MarketStateBuilder();
    
    const baseTime = 1000000;
    
    // Simulate some events
    const events = [
        { classification: 'ECONOMIC_TRADE', side: 'BUY', cleanSOLVolume: 1.0, initiator: 'walletA', event_time: baseTime, effectivePrice: 0.001 },
        { classification: 'ECONOMIC_TRADE', side: 'BUY', cleanSOLVolume: 2.0, initiator: 'walletB', event_time: baseTime + 1000, effectivePrice: 0.0015 },
        { classification: 'ECONOMIC_TRADE', side: 'SELL', cleanSOLVolume: 0.5, initiator: 'walletC', event_time: baseTime + 2000, effectivePrice: 0.0012 }
    ];

    let state;
    for (const e of events) {
        state = builder.processClassifiedEvent(e);
    }
    
    // Check Market State wrappers
    assert.strictEqual(state.price.value, 0.0012, 'Latest price should be updated');
    assert.strictEqual(state.price.status, 'AVAILABLE', 'Price status should be AVAILABLE');
    
    // Check Money Flow for 5s window
    const mf5s = state.moneyFlow['5s'];
    assert.ok(mf5s, '5s window should exist');
    assert.strictEqual(mf5s.buyVolume.value, 3.0, 'Total buy volume should be 3.0 (1.0 + 2.0)');
    assert.strictEqual(mf5s.sellVolume.value, 0.5, 'Total sell volume should be 0.5');
    assert.strictEqual(mf5s.netFlow.value, 2.5, 'Net flow should be 2.5');
    assert.strictEqual(mf5s.buySellRatio.value, 3.0 / 0.5, 'Buy sell ratio should be 6.0');
    assert.strictEqual(mf5s.buyerCount.value, 2, 'Should be 2 unique buyers');
    assert.strictEqual(mf5s.sellerCount.value, 1, 'Should be 1 unique seller');
    
    // Test velocity/acceleration over time
    // Fast forward 5 seconds
    const futureTime = baseTime + 6000;
    state = builder.processClassifiedEvent({ 
        classification: 'ECONOMIC_TRADE', side: 'BUY', cleanSOLVolume: 4.0, initiator: 'walletD', event_time: futureTime, effectivePrice: 0.002 
    });

    const mf5sFuture = state.moneyFlow['5s'];
    // The previous events at 1000000, 1001000, 1002000
    // futureTime is 1006000. 5s window threshold is 1001000.
    // 1000000 drops out.
    // Inside 5s window: 1001000 (2.0 BUY), 1002000 (0.5 SELL), 1006000 (4.0 BUY)
    assert.strictEqual(mf5sFuture.buyVolume.value, 6.0, 'Buy volume should be 6.0 (2.0 + 4.0)');
    assert.strictEqual(mf5sFuture.sellVolume.value, 0.5, 'Sell volume should be 0.5');

    // Check velocity calculation
    assert.ok(mf5sFuture.buyVolumeVelocity.value !== undefined, 'Velocity should be computed');
    console.log('PASS: Money Flow 5s window and feature structures');

    // Test NO-LOOKAHEAD guarantee
    const noLookaheadState = builder.processClassifiedEvent({
        classification: 'ECONOMIC_TRADE', side: 'BUY', cleanSOLVolume: 10.0, initiator: 'walletE', event_time: futureTime + 1000, effectivePrice: 0.003
    });
    
    // Make sure we didn't inject events from the future into past states
    assert.strictEqual(state.moneyFlow['5s'].buyVolume.value, 6.0, 'Past state reference should not be mutated by future events');

    console.log('PASS: No-Lookahead validation on Market State mutations');
    console.log('ALL TESTS PASSED');
}

runTests();
