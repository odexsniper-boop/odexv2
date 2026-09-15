const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'orchestrator.handleTokenLaunch(baselineTrade);',
    'await orchestrator.handleTokenLaunch(baselineTrade);'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
