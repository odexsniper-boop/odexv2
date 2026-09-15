const fs = require('fs');
const txs = JSON.parse(fs.readFileSync('replay/raw_txs.json', 'utf8'));

// Look at the first transaction (initialization)
const initTx = txs[txs.length - 1]; // Because Helius orders descending, last is oldest usually, or let's find the one with >700M token transfer.
const mint = 'EQxcbhdtHvokaragixuiDYMhH5AwbooPWwAmFidypump';

for (let tx of txs) {
    if (tx.tokenTransfers) {
        for (let t of tx.tokenTransfers) {
            if (t.mint === mint && t.tokenAmount > 700000000) {
                console.log('INIT TX FOUND');
                console.log('toTokenAccount:', t.toTokenAccount);
                console.log('toUserAccount:', t.toUserAccount);
                break;
            }
        }
    }
}

// Find a random buy
for (let tx of txs) {
    if (tx.tokenTransfers) {
        for (let t of tx.tokenTransfers) {
            if (t.mint === mint && t.tokenAmount < 700000000 && t.tokenAmount > 0) {
                console.log('SWAP TX FOUND');
                console.log(t);
                console.log(tx.accountData.filter(a => a.nativeBalanceChange !== 0).map(a => a.account));
                break;
            }
        }
    }
}
