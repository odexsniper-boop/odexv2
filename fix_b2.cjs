const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'const orchestrator = new Orchestrator({ executionEngine: execMock, positionManager: posManager, buySizeSol: 0.1, autoBuyEnabled: true });',
    'const orchestrator = new Orchestrator({ executionEngine: execMock, positionManager: posManager, buySizeSol: 0.1, autoBuyEnabled: true, narrativeAuditor: { audit: async (record) => { record.transitionTo("MONEY_FLOW_WATCH"); return true; } } });'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
