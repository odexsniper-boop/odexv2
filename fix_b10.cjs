const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'record.buyVolumeSol += 30.0;',
    'orchestrator.tokens.get(mint).buyVolumeSol += 30.0;'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
