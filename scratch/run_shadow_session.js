import { V2ShadowRunner } from '../engines/v2/shadowModeRunnerV2_3.js';

async function runLiveShadowSession() {
    console.log('=== STARTING KO V3 V2.3 LIVE SHADOW MODE RECEPTOR ===');
    console.log('Target Duration: 120,000ms (2 minutes live streaming & decision evaluation)\n');

    const runner = new V2ShadowRunner({
        configPath: 'validation/v2/shadow_mode_config.json',
        metricsPath: 'validation/v2/shadow_mode_metrics.json',
        eventsPath: 'validation/v2/shadow_mode_events.json',
        tradesPath: 'validation/v2/shadow_mode_trades.json',
        killSwitchPath: 'validation/v2/shadow_kill_switch.flag',
        pollIntervalMs: 1200
    });

    const metrics = await runner.runSession(120000);

    console.log('\n===============================================================');
    console.log('SHADOW MODE SESSION METRICS SUMMARY:');
    console.log('===============================================================');
    console.log('Duration (seconds):', metrics.session_duration_seconds);
    console.log('Tokens Observed:', metrics.tokens_observed_count);
    console.log('Candidates Evaluated:', metrics.candidates_evaluated_count);
    console.log('Buys Generated:', metrics.buys_generated_count);
    console.log('Hypothetical Entries:', metrics.hypothetical_entries_count);
    console.log('Hypothetical Exits:', metrics.hypothetical_exits_count);
    console.log('Open Positions:', metrics.open_positions_count);
    console.log('Hard Safety Rejections:', metrics.hard_safety_rejections);
    console.log('Coordination Rejections:', metrics.coordination_rejections);
    console.log('Duplicate Events Filtered:', metrics.data_integrity.duplicate_events_count);
    console.log('Integrity Incidents:', metrics.data_integrity.integrity_incidents_count);
    console.log('Latency Mean (ms):', metrics.latency.mean_ms);
    console.log('Latency Median (ms):', metrics.latency.median_ms);
    console.log('Latency P95 (ms):', metrics.latency.p95_ms);
    console.log('Latency P99 (ms):', metrics.latency.p99_ms);
    console.log('Latency Worst (ms):', metrics.latency.worst_ms);
    console.log('Market Signal Net PnL (SOL):', metrics.market_signal_performance.net_pnl_sol.toFixed(4));
    console.log('Exec-Adjusted Net PnL (SOL):', metrics.execution_adjusted_performance.net_pnl_sol.toFixed(4));
    console.log('===============================================================\n');
}

runLiveShadowSession();
