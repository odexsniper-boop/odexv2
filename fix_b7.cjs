const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'console.log("STATE:", record ? record.state : "NO_RECORD", record ? record.rejectionReason : "");',
    'console.log("STATE:", record ? record.state : "NO_RECORD", "BUYS:", record ? record.buyVolumeSol : 0, "BUYERS:", record ? record.uniqueBuyers.size : 0);'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
