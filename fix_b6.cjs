const fs = require('fs');
let c = fs.readFileSync('replay/b1_engine_final.js','utf8');
c = c.replace(
    'validTransfers.push({ isBuy: tt.fromUserAccount === curveSolAcct, tokAmt: tt.tokenAmount, innerIdx });',
    'validTransfers.push({ isBuy: tt.fromUserAccount === curveSolAcct, tokAmt: tt.tokenAmount, innerIdx, userAcct: tt.fromUserAccount === curveSolAcct ? tt.toUserAccount : tt.fromUserAccount });'
);
c = c.replace(
    'buyerPubkey: "sim_user",',
    'buyerPubkey: transfer.userAcct,'
);
fs.writeFileSync('replay/b1_engine_final.js', c);
