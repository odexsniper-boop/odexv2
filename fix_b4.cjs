const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace('export async function runB1Replay(rawTxs) {', 'export async function runB1Replay() { let rawTxs = JSON.parse(fs.readFileSync("replay/raw_txs.json", "utf8"));');
fs.writeFileSync('replay/b1_engine_final.js', c);
