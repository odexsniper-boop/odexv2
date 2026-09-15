import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

async function fetchOos4DatasetRobust() {
    console.log('=== FETCHING COMPLETELY UNSEEN OOS-4 HISTORICAL DATASET (ROBUST) ===\n');

    const key = process.env.HELIUS_API_KEY || '5512b207-b344-4c60-9b75-6f0dfc57b674';
    const db = new DatabaseSync('data/bot.db');

    function extractMints(file) {
        const txs = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tokens = new Set();
        for (const tx of txs) {
            if (tx.test_mint_context) tokens.add(tx.test_mint_context);
            if (tx.token) tokens.add(tx.token);
            if (tx.tokenTransfers) {
                for (const tt of tx.tokenTransfers) {
                    if (tt.mint && tt.mint !== 'So11111111111111111111111111111111111111112') tokens.add(tt.mint);
                }
            }
        }
        return tokens;
    }

    const devMints = extractMints('replay/raw_txs_expanded_35.json');
    const oos1Mints = extractMints('replay/raw_txs_oos_40.json');
    const oos2Mints = extractMints('replay/raw_txs_oos2_final.json');
    const oos3Mints = extractMints('replay/raw_txs_oos3_final.json');

    const allExcluded = new Set([...devMints, ...oos1Mints, ...oos2Mints, ...oos3Mints]);
    console.log(`Permanently excluded tokens across Dev, OOS-1, OOS-2, OOS-3: ${allExcluded.size}`);

    // 1. All 4 unconsumed trades from bot.db
    const tradeRows = db.prepare('SELECT mint, raw_data FROM trades').all();
    const candidateTrades = [];
    const seenMints = new Set();

    tradeRows.forEach(r => {
        if (!r.raw_data) return;
        try {
            const d = JSON.parse(r.raw_data);
            if (d.mint && !allExcluded.has(d.mint) && !seenMints.has(d.mint)) {
                seenMints.add(d.mint);
                candidateTrades.push(d);
            }
        } catch {}
    });

    // 2. Sample 40 unconsumed detected tokens to ensure we get at least 30-35 valid tokens with txs
    const detectedRows = db.prepare('SELECT mint, name, symbol, composite_score, liquidity, detected_at FROM tokens_detected ORDER BY detected_at DESC').all();
    const candidateDetected = [];
    for (const d of detectedRows) {
        if (!allExcluded.has(d.mint) && !seenMints.has(d.mint)) {
            seenMints.add(d.mint);
            candidateDetected.push(d);
            if (candidateDetected.length >= 40) break;
        }
    }

    const oos4TokenList = [
        ...candidateTrades.map(t => ({
            mint: t.mint,
            source: 'V1_EXECUTED_TRADE',
            name: t.name,
            symbol: t.symbol,
            v1PnlPct: t.finalPnlPercent,
            v1Sol: t.netProfitSol,
            v1Reason: t.reason
        })),
        ...candidateDetected.map(d => ({
            mint: d.mint,
            source: 'MARKET_DETECTED_TOKEN',
            name: d.name,
            symbol: d.symbol,
            v1PnlPct: null,
            v1Sol: null,
            v1Reason: null
        }))
    ];

    console.log(`Querying ${oos4TokenList.length} candidate tokens for OOS-4...\n`);

    const allOos4Txs = [];
    const validTokens = [];
    const seenSignatures = new Set();

    async function fetchWithRetry(mint, maxRetries = 4) {
        const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=50`;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (res.status === 429) {
                    console.log(`    [429 Rate limit] waiting ${attempt * 1000}ms...`);
                    await new Promise(r => setTimeout(r, attempt * 1000));
                    continue;
                }
                const data = await res.json();
                return data;
            } catch (err) {
                if (attempt === maxRetries) throw err;
                await new Promise(r => setTimeout(r, attempt * 1000));
            }
        }
        return null;
    }

    for (let i = 0; i < oos4TokenList.length; i++) {
        const tokenInfo = oos4TokenList[i];
        const mint = tokenInfo.mint;
        try {
            const data = await fetchWithRetry(mint);
            if (Array.isArray(data) && data.length > 0) {
                let addedForThisToken = 0;
                data.forEach(tx => {
                    if (!seenSignatures.has(tx.signature)) {
                        seenSignatures.add(tx.signature);
                        tx.test_mint_context = mint;
                        allOos4Txs.push(tx);
                        addedForThisToken++;
                    }
                });
                if (addedForThisToken > 0) {
                    validTokens.push(tokenInfo);
                    console.log(` [${i+1}/${oos4TokenList.length}] ${mint.slice(0, 10)}... -> Fetched ${addedForThisToken} txs (${tokenInfo.source}: ${tokenInfo.name || tokenInfo.symbol || 'token'})`);
                }
            } else {
                console.log(` [${i+1}/${oos4TokenList.length}] ${mint.slice(0, 10)}... -> Empty`);
            }
        } catch (err) {
            console.error(`Error fetching txs for ${mint}:`, err.message);
        }
        await new Promise(r => setTimeout(r, 450)); // generous 450ms pacing between requests
    }

    console.log(`\nSuccessfully fetched ${allOos4Txs.length} transactions across ${validTokens.length} tokens.`);

    // Sort chronologically
    allOos4Txs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Save to replay/raw_txs_oos4_final.json
    fs.writeFileSync('replay/raw_txs_oos4_final.json', JSON.stringify(allOos4Txs, null, 2));
    console.log('Saved replay/raw_txs_oos4_final.json successfully.');

    // Save metadata
    fs.writeFileSync('replay/oos4_tokens_metadata.json', JSON.stringify(validTokens, null, 2));
    console.log('Saved replay/oos4_tokens_metadata.json successfully.');
}

fetchOos4DatasetRobust();
