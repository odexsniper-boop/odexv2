
async function runForensic() {
    const key = process.env.HELIUS_API_KEY;
    const mint = "EQxcbhdtHvokaragixuiDYMhH5AwbooPWwAmFidypump";
    const url = "https://api.helius.xyz/v0/addresses/" + mint + "/transactions?api-key=" + key + "&limit=100";
    
    let rawTxs = [];
    try {
        const fetch = (await import("node-fetch")).default || global.fetch;
        const res = await fetch(url);
        rawTxs = await res.json();
    } catch (e) {
        console.error("Fetch failed", e);
        return;
    }
    
    let totalTxs = rawTxs.length;
    let totalInstructions = 0;
    let totalInnerInstructions = 0;
    let totalDerivableEvents = 0;
    
    // Check bundled transactions
    rawTxs.forEach((tx) => {
        const accountData = tx.accountData || [];
        const instructions = tx.instructions || [];
        totalInstructions += instructions.length;
        
        instructions.forEach(ix => {
            totalInnerInstructions += (ix.innerInstructions || []).length;
        });

        // How many discrete swaps can we find in this one tx?
        let swapCountInTx = 0;
        for (const acct of accountData) {
            const tokChanges = acct.tokenBalanceChanges || [];
            for (const t of tokChanges) {
                if (t.mint === mint) {
                    const amountRaw = Number(t.rawTokenAmount.tokenAmount);
                    if (amountRaw !== 0) { // A real transfer
                        swapCountInTx++;
                    }
                }
            }
        }
        totalDerivableEvents += swapCountInTx;
    });

    console.log("=== FORENSIC EVENT COUNT ===");
    console.log("Total Transactions:", totalTxs);
    console.log("Total Instructions:", totalInstructions);
    console.log("Total Inner Instructions:", totalInnerInstructions);
    console.log("Total Derivable Sub-Events (Discrete Wallet Swaps):", totalDerivableEvents);
}
runForensic().catch(console.error);

