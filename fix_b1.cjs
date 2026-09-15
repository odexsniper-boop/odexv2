const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace('export async function runB1Replay() {', 'export async function runB1Replay(rawTxs) {');
c = c.replace('const fetch = (await import("node-fetch")).default || global.fetch;', '');
c = c.replace('let rawTxs = (await (await fetch(url)).json()).reverse();', '');
c = c.replace('let report = "# KO V3 V1 GATE B1 VALIDATION REPORT\\n";', 'let report = "# KO V3 V1 GATE B1 VALIDATION REPORT\\n"; console.log("STATE:", record ? record.state : "NO_RECORD", record ? record.rejectionReason : "");');
fs.writeFileSync('replay/b1_engine_final.js', c);
