
const SimulatedClock = require("./simulatedClock.cjs");

function runTest() {
    console.log("=== REPLAY PROOF TEST ===");
    const clock = new SimulatedClock();
    clock.currentTime = 0;
    clock.install();

    let execOrder = [];

    // Schedule events
    setTimeout(() => {
        execOrder.push(`Event A at T=${Date.now()}ms`);
    }, 0);

    setTimeout(() => {
        execOrder.push(`Event B at T=${Date.now()}ms`);
    }, 5000);

    setTimeout(() => {
        execOrder.push(`Event C at T=${Date.now()}ms`);
    }, 10000);

    // V1-equivalent timer at T=10s
    setTimeout(() => {
        execOrder.push(`V1-Equivalent Timer at T=${Date.now()}ms`);
    }, 10000);

    // Test advance
    console.log("Advancing to T=10000...");
    clock.advance(10000);
    
    console.log("Advancing to T=15000...");
    clock.advance(15000);

    console.log("Advancing to T=30000...");
    clock.advance(30000);
    
    console.log("Advancing to T=60000...");
    clock.advance(60000);
    
    console.log("\nExecution Results:");
    execOrder.forEach(o => console.log(o));
    
    clock.uninstall();
}

runTest();

