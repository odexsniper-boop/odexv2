const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'await orchestrator.handleTokenLaunch(baselineTrade);',
    'await orchestrator.handleTokenLaunch(baselineTrade); await new Promise(r => setTimeout(r, 2500));'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
