const SimulatedClock = require('./simulatedClock.cjs');
global.clock = new SimulatedClock();
global.clock.install();

import('./b1_engine_final.js').then(async m => {
    await m.runB1Replay();
}).catch(console.error);
