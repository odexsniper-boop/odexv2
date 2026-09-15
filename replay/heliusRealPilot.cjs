
const CanonicalEvent = require("./canonicalSchema.cjs");

async function runRealHeliusPilot() {
    console.log("=== GATE A5: REAL MARKET-STATE RECONSTRUCTION PILOT ===");
    const key = process.env.HELIUS_API_KEY;
    const mint = "EQxcbhdtHvokaragixuiDYMhH5AwbooPWwAmFidypump";
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${key}&limit=100`;
    
    let rawTxs = [];
    try {
        const fetch = (await import("node-fetch")).default || global.fetch;
        const res = await fetch(url);
        rawTxs = await res.json();
    } catch (e) {
        return;
    }
    
    let canonicalEvents = [];
    let validCount = 0;
    let classificationErrors = 0;
    
    rawTxs.forEach((tx) => {
        let side = "OTHER";
        let baseAmt = 0;
        let tokAmt = 0;
        let wallet = null;
        
        const accountData = tx.accountData || [];
        
        // Find token change
        for (const acct of accountData) {
            const tokChanges = acct.tokenBalanceChanges || [];
            for (const t of tokChanges) {
                if (t.mint === mint) {
                    wallet = t.userAccount;
                    const amountRaw = Number(t.rawTokenAmount.tokenAmount);
                    // Determine if it was an add or subtract by looking at nativeBalanceChange of the same wallet
                    const userAcct = accountData.find(a => a.account === wallet);
                    
                    if (userAcct) {
                        const nativeChange = userAcct.nativeBalanceChange;
                        if (nativeChange < 0) {
                            // User spent SOL -> BUY tokens
                            side = "BUY";
                            tokAmt = amountRaw / Math.pow(10, t.rawTokenAmount.decimals);
                            baseAmt = Math.abs(nativeChange) / 1e9;
                        } else if (nativeChange > 0) {
                            // User gained SOL -> SELL tokens
                            side = "SELL";
                            tokAmt = amountRaw / Math.pow(10, t.rawTokenAmount.decimals);
                            baseAmt = nativeChange / 1e9;
                        }
                    }
                }
            }
        }
        
        const event = new CanonicalEvent({
            event_id: tx.signature,
            signature: tx.signature,
            slot: tx.slot,
            block_time: tx.timestamp,
            mint: mint,
            wallet: wallet || "UNAVAILABLE",
            side: side,
            base_asset_amount: baseAmt,
            token_amount: tokAmt,
            source: "HELIUS_ARCHIVE",
            historical_availability_timestamp: tx.timestamp * 1000,
            completeness_status: {
                wallet: wallet ? "AVAILABLE" : "UNAVAILABLE",
                liquidity: "ESTIMATED",
                price: (tokAmt > 0 && baseAmt > 0) ? "DERIVED" : "NOT_AVAILABLE"
            }
        });
        
        if (event.token_amount > 0 && event.base_asset_amount > 0) {
            event.effective_price = event.base_asset_amount / event.token_amount;
        }
        
        canonicalEvents.push(event);
        if (event.isValid()) validCount++;
    });
    
    console.log("=== PILOT RECONSTRUCTION METRICS ===");
    console.log(`Total raw events: ${rawTxs.length}`);
    console.log(`Canonical events generated: ${canonicalEvents.length}`);
    const missingWallet = canonicalEvents.filter(e => e.wallet === "UNAVAILABLE").length;
    console.log(`Wallet visibility (Missing wallets): ${missingWallet}`);
    
    const derivedPrices = canonicalEvents.filter(e => e.completeness_status.price === "DERIVED").length;
    console.log(`Price reconstruction (Derived Successfully): ${derivedPrices} / ${rawTxs.length}`);
    console.log(`Liquidity reconstruction: 100% ESTIMATED (Curve tracking required)`);
    
    if (canonicalEvents.length > 0) {
        console.log("\nSample Normalized Event (First BUY):");
        const sampleBuy = canonicalEvents.find(e => e.side === "BUY");
        console.log(JSON.stringify(sampleBuy || canonicalEvents[0], null, 2));
    }
}
runRealHeliusPilot().catch(console.error);

