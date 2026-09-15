const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/bot.db');
const rows = db.prepare("SELECT raw_data FROM tokens_detected").all();
let avgBuy = 0;
let total = 0;
rows.forEach(r => {
    if(r.raw_data) {
        const d = JSON.parse(r.raw_data);
        if(d.buyVolumeSol) {
            avgBuy += d.buyVolumeSol;
            total++;
        }
    }
});
console.log('Avg Buy Volume SOL:', avgBuy / total, 'Total Tokens:', total);
