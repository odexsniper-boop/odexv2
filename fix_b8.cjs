const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'validTransfers.forEach((transfer) => {',
    'console.log("Transfer userAcct:", validTransfers.map(t => t.userAcct)); validTransfers.forEach((transfer) => {'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
