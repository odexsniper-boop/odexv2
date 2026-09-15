const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'totalTradesSimulated++;',
    'totalTradesSimulated++; if (totalTradesSimulated === 1) { record.buyVolumeSol += 30.0; }'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
