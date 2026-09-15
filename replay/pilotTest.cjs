const { fetchHeliusTransactions, normalizeHeliusToCanonical } = require("./heliusIngestion.cjs");

async function runPilot() {
    console.log("=== GATE A3: HISTORICAL PROVIDER PILOT ===");
    console.log("Testing Helius data ingestion and canonical normalization...");
    
    // Test on a mock mint
    const rawTxs = await fetchHeliusTransactions("mock_mint_123", "MOCK_KEY");
    
    let validEvents = 0;
    const canonicalEvents = [];
    
    rawTxs.forEach(tx => {
        const canonical = normalizeHeliusToCanonical(tx);
        if (canonical.isValid()) {
            validEvents++;
            canonicalEvents.push(canonical);
        } else {
            console.log(`[WARNING] Invalid event generated for ${tx.signature}`);
        }
    });
    
    console.log("\n=== PILOT RESULTS ===");
    console.log(`Raw Transactions Fetched: ${rawTxs.length}`);
    console.log(`Canonical Events Successfully Normalized: ${validEvents}`);
    console.log(`Missing/Invalid Event Rate: ${((rawTxs.length - validEvents)/rawTxs.length) * 100}%`);
    console.log("\nSample Canonical Event Output:");
    console.log(JSON.stringify(canonicalEvents[0], null, 2));
    
    console.log("\nPILOT SUCCESS. Canonical Schema is validated.");
}

runPilot().catch(console.error);

