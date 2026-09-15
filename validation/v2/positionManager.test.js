import assert from 'assert';
import { PositionManagerV2 } from '../../engines/v2/positionManagerV2.js';

function createMockMarketState({
    price = 0.0001,
    dataQuality = 'AVAILABLE',
    currentLiquidity = 30.0,
    liquidityDeterioration = 0,
    netFlow = 1.0,
    buyVolume = 2.0,
    sellVolume = 1.0,
    buyVolumeAcceleration = 0.1,
    priceVelocity = 0.00001,
    priceAcceleration = 0.000001,
    distributionRisk = 0,
    coordinationRisk = 0,
    smartMoneyScore = 50
}) {
    return {
        dataQuality,
        price: { value: price, status: 'AVAILABLE' },
        liquidityMetrics: {
            currentLiquidity: { value: currentLiquidity, status: 'AVAILABLE' },
            liquidityDeterioration: { value: liquidityDeterioration, status: 'DERIVED' }
        },
        moneyFlow: {
            '15s': {
                buyVolume: { value: buyVolume },
                sellVolume: { value: sellVolume },
                buyVolumeAcceleration: { value: buyVolumeAcceleration }
            },
            '30s': {
                netFlow: { value: netFlow },
                buyVolume: { value: buyVolume },
                sellVolume: { value: sellVolume }
            }
        },
        priceMomentum: {
            '10s': {
                priceVelocity: { value: priceVelocity },
                priceAcceleration: { value: priceAcceleration }
            },
            '30s': {
                priceVelocity: { value: priceVelocity }
            }
        },
        walletIntelligence: {
            '30s': {
                smartMoneyScore: { value: smartMoneyScore }
            }
        },
        coordinationRisk: {
            '10s': {
                coordinationRisk: { value: coordinationRisk }
            }
        },
        distributionRisk: {
            '10s': {
                distributionRisk: { value: distributionRisk }
            }
        }
    };
}

export function runTests() {
    console.log('=== RUNNING POSITION MANAGER V2 TEST SUITE (SCENARIOS A - Q) ===');

    const pm = new PositionManagerV2();
    const entryTime = 1000000;
    const entryPrice = 0.0001;

    // A. Strong continuation
    {
        const pos = pm.openPosition({
            positionId: 'test_A',
            token: 'TOKEN_A',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const state = createMockMarketState({ price: 0.00012, netFlow: 2.0 });
        const res = pm.updatePosition('test_A', state, entryTime + 10000);
        assert.strictEqual(res.action.type, 'HOLD');
        assert.strictEqual(pos.thesis_state, 'THESIS_STRONG');
        assert.strictEqual(pos.mfe.maxFavorablePercent > 0, true);
        console.log('PASS: Scenario A - Strong continuation');
    }

    // B. Temporary drawdown followed by recovery
    {
        const pos = pm.openPosition({
            positionId: 'test_B',
            token: 'TOKEN_B',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        // Minor drawdown with positive flow (not triggering stop)
        const stateDrawdown = createMockMarketState({ price: 0.000095, netFlow: 1.5 });
        pm.updatePosition('test_B', stateDrawdown, entryTime + 10000);
        assert.strictEqual(pos.mae.maxAdversePercent < 0, true);
        // Recovery
        const stateRecovery = createMockMarketState({ price: 0.00011, netFlow: 2.5 });
        const res = pm.updatePosition('test_B', stateRecovery, entryTime + 20000);
        assert.strictEqual(res.action.type, 'HOLD');
        assert.strictEqual(pos.unrealized_pnl > 0, true);
        console.log('PASS: Scenario B - Temporary drawdown followed by recovery');
    }

    // C. Flow collapse -> FLOW_FAILURE exit
    {
        const pos = pm.openPosition({
            positionId: 'test_C',
            token: 'TOKEN_C',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateCollapse = createMockMarketState({ price: 0.00009, netFlow: -1.5 });
        const res = pm.updatePosition('test_C', stateCollapse, entryTime + 15000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'FLOW_FAILURE');
        console.log('PASS: Scenario C - Flow collapse');
    }

    // D. Buyer acceleration collapse -> WEAKENING
    {
        const pos = pm.openPosition({
            positionId: 'test_D',
            token: 'TOKEN_D',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateD1 = createMockMarketState({ price: 0.000102, buyVolumeAcceleration: -0.2, priceAcceleration: -0.00001 });
        pm.updatePosition('test_D', stateD1, entryTime + 5000);
        const stateD2 = createMockMarketState({ price: 0.000101, buyVolumeAcceleration: -0.3, priceAcceleration: -0.00001 });
        pm.updatePosition('test_D', stateD2, entryTime + 10000);
        assert.strictEqual(pos.thesis_state, 'THESIS_WEAKENING');
        console.log('PASS: Scenario D - Buyer acceleration collapse (Weakening)');
    }

    // E. Seller acceleration spike -> THESIS_WEAKENING
    {
        const pos = pm.openPosition({
            positionId: 'test_E',
            token: 'TOKEN_E',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateE1 = createMockMarketState({ price: 0.0001, sellVolume: 5.0, buyVolume: 1.0, buyVolumeAcceleration: -0.1 });
        pm.updatePosition('test_E', stateE1, entryTime + 5000);
        const stateE2 = createMockMarketState({ price: 0.0001, sellVolume: 6.0, buyVolume: 1.0, buyVolumeAcceleration: -0.1 });
        pm.updatePosition('test_E', stateE2, entryTime + 10000);
        assert.strictEqual(pos.thesis_state, 'THESIS_WEAKENING');
        console.log('PASS: Scenario E - Seller acceleration spike');
    }

    // F. Liquidity collapse (<5 SOL) -> EMERGENCY
    {
        const pos = pm.openPosition({
            positionId: 'test_F',
            token: 'TOKEN_F',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateLiqCollapse = createMockMarketState({ price: 0.00008, currentLiquidity: 3.5 });
        const res = pm.updatePosition('test_F', stateLiqCollapse, entryTime + 10000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'EMERGENCY');
        assert.strictEqual(pos.thesis_state, 'EMERGENCY');
        console.log('PASS: Scenario F - Liquidity collapse (Emergency)');
    }

    // G. Smart-wallet distribution -> THESIS_BROKEN / EXIT
    {
        const pos = pm.openPosition({
            positionId: 'test_G',
            token: 'TOKEN_G',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        // Smart wallet distribution causes broken thesis after 2 ticks
        const stateG1 = createMockMarketState({ price: 0.000095, distributionRisk: 65, netFlow: -0.8 });
        pm.updatePosition('test_G', stateG1, entryTime + 5000);
        const stateG2 = createMockMarketState({ price: 0.000092, distributionRisk: 65, netFlow: -0.8 });
        const res = pm.updatePosition('test_G', stateG2, entryTime + 10000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        console.log('PASS: Scenario G - Smart-wallet distribution');
    }

    // H. Coordinated distribution -> Immediate exit on heavy distribution
    {
        const pos = pm.openPosition({
            positionId: 'test_H',
            token: 'TOKEN_H',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateH = createMockMarketState({ price: 0.00009, distributionRisk: 80, netFlow: -0.2 });
        const res = pm.updatePosition('test_H', stateH, entryTime + 10000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'COORDINATED_DISTRIBUTION');
        console.log('PASS: Scenario H - Coordinated distribution');
    }

    // I. Momentum failure (double tick confirmation) -> THESIS_BROKEN
    {
        const pos = pm.openPosition({
            positionId: 'test_I',
            token: 'TOKEN_I',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateI1 = createMockMarketState({ price: 0.000098, priceVelocity: -0.00002, netFlow: -0.8 });
        pm.updatePosition('test_I', stateI1, entryTime + 5000);
        const stateI2 = createMockMarketState({ price: 0.000095, priceVelocity: -0.00003, netFlow: -1.0 });
        const res = pm.updatePosition('test_I', stateI2, entryTime + 10000);
        assert.strictEqual(pos.thesis_state, 'THESIS_BROKEN');
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'THESIS_BROKEN');
        console.log('PASS: Scenario I - Momentum failure');
    }

    // J. Long stagnation -> TIME_DECAY
    {
        const pos = pm.openPosition({
            positionId: 'test_J',
            token: 'TOKEN_J',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateJ = createMockMarketState({ price: entryPrice });
        const res = pm.updatePosition('test_J', stateJ, entryTime + 190000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'TIME_DECAY');
        console.log('PASS: Scenario J - Long stagnation time decay');
    }

    // K. Rapid explosive winner -> PARTIAL_PROFIT
    {
        const pos = pm.openPosition({
            positionId: 'test_K',
            token: 'TOKEN_K',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateK = createMockMarketState({ price: 0.00015 });
        const res = pm.updatePosition('test_K', stateK, entryTime + 15000);
        assert.strictEqual(res.action.type, 'PARTIAL_EXIT');
        assert.strictEqual(res.action.reason, 'PARTIAL_PROFIT');
        assert.strictEqual(pos.stage, 'RUNNER');
        assert.strictEqual(pos.current_size, 0.5);
        assert.strictEqual(pos.realized_pnl > 0, true);
        console.log('PASS: Scenario K - Rapid explosive winner');
    }

    // L. Emergency event (data corruption) -> Immediate Emergency exit
    {
        const pos = pm.openPosition({
            positionId: 'test_L',
            token: 'TOKEN_L',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateCorrupted = createMockMarketState({ dataQuality: 'CORRUPTED', price: 0.00012 });
        const res = pm.updatePosition('test_L', stateCorrupted, entryTime + 10000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'EMERGENCY');
        console.log('PASS: Scenario L - Emergency event');
    }

    // M. Partial-profit then continued rally
    {
        const pos = pm.openPosition({
            positionId: 'test_M',
            token: 'TOKEN_M',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateM1 = createMockMarketState({ price: 0.000145 });
        pm.updatePosition('test_M', stateM1, entryTime + 10000);
        assert.strictEqual(pos.stage, 'RUNNER');

        const stateM2 = createMockMarketState({ price: 0.000190 });
        const res = pm.updatePosition('test_M', stateM2, entryTime + 20000);
        assert.strictEqual(res.action.type, 'HOLD');
        assert.strictEqual(pos.peakPrice, 0.000190);
        console.log('PASS: Scenario M - Partial-profit then continued rally');
    }

    // N. Partial-profit then collapse
    {
        const pos = pm.openPosition({
            positionId: 'test_N',
            token: 'TOKEN_N',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateN1 = createMockMarketState({ price: 0.000145 });
        pm.updatePosition('test_N', stateN1, entryTime + 10000);

        const stateN2 = createMockMarketState({ price: 0.00011, priceVelocity: -0.00002 });
        const res = pm.updatePosition('test_N', stateN2, entryTime + 20000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(pos.stage, 'CLOSED');
        console.log('PASS: Scenario N - Partial-profit then collapse (Trailing/Momentum Exit)');
    }

    // O. Runner continuation
    {
        const pos = pm.openPosition({
            positionId: 'test_O',
            token: 'TOKEN_O',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        pm.updatePosition('test_O', createMockMarketState({ price: 0.00015 }), entryTime + 10000);
        const stateO = createMockMarketState({ price: 0.00016 });
        const res = pm.updatePosition('test_O', stateO, entryTime + 25000);
        assert.strictEqual(res.action.type, 'HOLD');
        console.log('PASS: Scenario O - Runner continuation');
    }

    // P. Runner reversal -> TRAILING_EXIT
    {
        const pos = pm.openPosition({
            positionId: 'test_P',
            token: 'TOKEN_P',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        pm.updatePosition('test_P', createMockMarketState({ price: 0.00020 }), entryTime + 10000);
        const stateP = createMockMarketState({ price: 0.00015 });
        const res = pm.updatePosition('test_P', stateP, entryTime + 20000);
        assert.strictEqual(res.action.type, 'FULL_EXIT');
        assert.strictEqual(res.action.reason, 'TRAILING_EXIT');
        console.log('PASS: Scenario P - Runner reversal');
    }

    // Q. Rapid thesis state oscillation (Debounce / Hysteresis verification)
    {
        const pos = pm.openPosition({
            positionId: 'test_Q',
            token: 'TOKEN_Q',
            entryTimestamp: entryTime,
            entryPrice,
            entrySizeSol: 1.0
        });
        const stateWeak = createMockMarketState({ price: 0.000101, buyVolumeAcceleration: -0.2, sellVolume: 3.0, buyVolume: 1.0 });
        pm.updatePosition('test_Q', stateWeak, entryTime + 5000);
        assert.strictEqual(pos.thesis_state, 'THESIS_STRONG', 'Single tick must not cause state flip');

        const stateStrong = createMockMarketState({ price: 0.000105, buyVolumeAcceleration: 0.2, sellVolume: 0.5, buyVolume: 2.0 });
        pm.updatePosition('test_Q', stateStrong, entryTime + 10000);
        assert.strictEqual(pos.thesis_state, 'THESIS_STRONG', 'Flapping prevented by hysteresis');
        console.log('PASS: Scenario Q - Rapid thesis state oscillation prevented by hysteresis');
    }

    console.log('ALL 17 SCENARIOS (A - Q) PASSED!');
}

runTests();
