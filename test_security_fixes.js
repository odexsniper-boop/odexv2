import assert from 'assert';
import { DevWatcher } from './engines/devWatcher.js';
import { EventEmitter } from 'events';
import { eventBus } from './eventBus.js';

class MockConnection {
    constructor(mockBalance, shouldThrow = false) {
        this.mockBalance = mockBalance;
        this.shouldThrow = shouldThrow;
        this.accountChanges = [];
        this.listeners = {};
        this.subIdCounter = 1;
    }
    
    async getAccountInfo(pubkey, commitment) {
        if (this.shouldThrow) throw new Error("Mock RPC failure");
        
        if (this.mockBalance === null) {
            return null; // Account doesn't exist or closed
        }

        const buffer = Buffer.alloc(72);
        buffer.writeBigUInt64LE(BigInt(this.mockBalance), 64);
        return { data: buffer };
    }

    onAccountChange(pubkey, callback, commitment) {
        const id = this.subIdCounter++;
        this.listeners[id] = callback;
        return id;
    }
    
    triggerAccountChange(id, balance) {
        const cb = this.listeners[id];
        if (!cb) return;
        
        if (balance === null) {
             cb({ data: Buffer.alloc(0) }); // empty buffer for closed ATA
        } else {
             const buffer = Buffer.alloc(72);
             buffer.writeBigUInt64LE(BigInt(balance), 64);
             cb({ data: buffer });
        }
    }

    removeAccountChangeListener(id) {
        delete this.listeners[id];
    }
}

class MockPositionManager {
    constructor() {
        this.positions = new Map();
        this.emergencyExits = [];
    }
    triggerEmergencyFrontrun(mint, reason) {
        this.emergencyExits.push({mint, reason});
    }
}

async function runTests() {
    console.log("Running Security Fix Tests...");
    let passed = 0;
    let failed = 0;

    const assertCheck = (name, condition, msg) => {
        if (condition) {
            console.log(`✅ ${name}`);
            passed++;
        } else {
            console.error(`❌ ${name}: ${msg}`);
            failed++;
        }
    };

    // TEST 1: First-move dev dump
    try {
        const conn = new MockConnection(80000000n); // 80M initial balance
        const pm = new MockPositionManager();
        const watcher = new DevWatcher(conn, pm);
        
        let dumpAlertTriggered = false;
        eventBus.on('DEV_DUMP_ALERT', (alert) => {
            if (alert.mint === 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263') dumpAlertTriggered = true;
        });

        await watcher.watchDev('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        
        const record = watcher.monitoredDevs.get('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
        assertCheck('DevWatcher initialization fetches initial balance correctly', record && record.lastBalance === 80000000n && record.state === 'KNOWN', `State is ${record?.state} and balance is ${record?.lastBalance}`);
        
        // Trigger 100% dump
        conn.triggerAccountChange(record.subId, 0n);
        
        assertCheck('First-move dump successfully triggers dump alert', dumpAlertTriggered, 'DEV_DUMP_ALERT event not emitted');
        assertCheck('Emergency position exit triggered', pm.emergencyExits.length === 1 && pm.emergencyExits[0].reason === 'DEV_RUG_FRONTRUN', 'Position manager emergency exit not called');
        
    } catch (e) {
        console.error("Test 1 Error:", e);
        failed++;
    }

    // TEST 2: Sell plus ATA Close
    try {
        const conn = new MockConnection(100000000n); // 100M initial
        const pm = new MockPositionManager();
        const watcher = new DevWatcher(conn, pm);
        
        let dumpAlertTriggered = false;
        eventBus.on('DEV_DUMP_ALERT', (alert) => {
            if (alert.mint === 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKPeX') dumpAlertTriggered = true;
        });

        await watcher.watchDev('SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKPeX', '9WzDXwBbmcg8ZXTaBT251q11RRe84Fz6xJmDABY2743Y');
        const record = watcher.monitoredDevs.get('SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKPeX');
        
        // Trigger ATA closure (empty buffer)
        conn.triggerAccountChange(record.subId, null);
        
        assertCheck('Sell-plus-ATA-close triggers dump alert', dumpAlertTriggered, 'Empty buffer was silently ignored');
        assertCheck('Account state marked as CLOSED', record.state === 'CLOSED', `Expected CLOSED, got ${record.state}`);
        
    } catch (e) {
        console.error("Test 2 Error:", e);
        failed++;
    }

    // TEST 3: RPC Failure leaves state as UNKNOWN and isSafe is false
    try {
        const conn = new MockConnection(null, true); // Throw error
        const pm = new MockPositionManager();
        const watcher = new DevWatcher(conn, pm);
        
        await watcher.watchDev('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac', 'H7TzDq8Q7y6xN4qRQQkR3W9Z5A6M6mZ8bC6qW2qW3Z4A');
        const record = watcher.monitoredDevs.get('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac');
        
        assertCheck('RPC failure sets developer state to UNKNOWN', record.state === 'UNKNOWN', `Expected UNKNOWN, got ${record.state}`);
        assertCheck('Unknown developer state flags token as unsafe (isSafe=false)', watcher.isSafe('MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac') === false, 'isSafe should return false for UNKNOWN state');
        
    } catch (e) {
        console.error("Test 3 Error:", e);
        failed++;
    }
    
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    else process.exit(0);
}

runTests();
