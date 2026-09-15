
const SimulatedClock = require("./simulatedClock.cjs");
global.clock = new SimulatedClock();
global.clock.install();

// Now that the global timers are intercepted, import the V1 strategy
import("./a6_engine_fixed.js").then(m => m.runA6Replay()).catch(console.error);

