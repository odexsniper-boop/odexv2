const fs = require('fs');
const txs = JSON.parse(fs.readFileSync('replay/raw_txs.json', 'utf8'));
const mint = 'EQxcbhdtHvokaragixuiDYMhH5AwbooPWwAmFidypump';
let pda, ata;
for (const tx of txs) {
    if (tx.tokenTransfers) {
        for (const t of tx.tokenTransfers) {
            if (t.mint === mint && t.tokenAmount > 700000000) {
                pda = t.toUserAccount;
                // find the ATA in tokenTransfers or we can just guess.
                // pump.fun usually mints to a specific ATA.
                ata = tx.tokenTransfers.find(x => x.tokenAmount > 700000000).toTokenAccount;
                break;
            }
        }
    }
    if (pda) break;
}
console.log('Mint:', mint);
console.log('PDA:', pda);
console.log('ATA:', ata);
console.log('Total Txs:', txs.length);
