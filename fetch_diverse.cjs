const fs = require('fs');

async function fetchDiverse() {
    const mints = [
      'sXCeH1YLHYQSC2Qqe8m7gsDNey57uq9krt5rc8Bpump',
      'ipC23YE2VjAqUzvWww6x6bXX87ToDX6r3niJaAspump',
      'Af8yT6o17ccxYsNpQkqqx9oGJS4ZDanKnN7dZfDFpump',
      'Aq5jcxymfjNGYp4CV8kLyaDKrFQu4rHEkUPHoE7rpump',
      '32Aw9ZUSWScbLBX4PPqTCcQt6SqKPdvriQQsQxJgpump'
    ];
    const key = process.env.HELIUS_API_KEY || '5512b207-b344-4c60-9b75-6f0dfc57b674';
    let allTxs = [];
    
    for (const mint of mints) {
        console.log('Fetching', mint);
        const url = \https://api.helius.xyz/v0/addresses/\/transactions?api-key=\&limit=50\;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (Array.isArray(data)) {
                // Attach mint ID so we know which token it belongs to
                data.forEach(tx => tx.test_mint_context = mint);
                allTxs.push(...data);
            }
        } catch (e) {
            console.error(e);
        }
    }
    
    fs.writeFileSync('replay/raw_txs_diverse.json', JSON.stringify(allTxs, null, 2));
    console.log('Saved', allTxs.length, 'txs');
}

fetchDiverse();
