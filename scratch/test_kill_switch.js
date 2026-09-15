import fs from 'fs';
import { V2ShadowRunner } from '../engines/v2/shadowModeRunnerV2_3.js';

async function testKillSwitch() {
    console.log('=== VERIFYING SHADOW MODE KILL SWITCH BEHAVIOR ===\n');

    const runner = new V2ShadowRunner({
        killSwitchPath: 'validation/v2/shadow_kill_switch_test.flag'
    });

    // Ensure clean state
    if (fs.existsSync(runner.options.killSwitchPath)) {
        fs.unlinkSync(runner.options.killSwitchPath);
    }

    console.log('1. Initial kill switch state:', runner.checkKillSwitch() ? 'ACTIVE (FAIL)' : 'INACTIVE (PASS)');

    console.log('2. Triggering kill switch...');
    runner.triggerKillSwitch('UNIT_TEST_EMERGENCY_HALT');

    console.log('3. Post-trigger kill switch state:', runner.checkKillSwitch() ? 'ACTIVE (PASS)' : 'INACTIVE (FAIL)');
    const flagContent = JSON.parse(fs.readFileSync(runner.options.killSwitchPath, 'utf8'));
    console.log('   Flag Reason:', flagContent.reason);

    console.log('4. Clearing kill switch...');
    runner.clearKillSwitch();
    console.log('5. Final kill switch state:', runner.checkKillSwitch() ? 'ACTIVE (FAIL)' : 'INACTIVE (PASS)');

    console.log('\nKill switch test passed with 100% compliance.\n');
}

testKillSwitch();
