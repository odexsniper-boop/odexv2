class SimulatedClock {
    constructor() {
        this.currentTime = Date.now();
        this.originalDateNow = Date.now;
        this.originalDate = Date;
    }

    install() {
        Date.now = () => this.currentTime;
        // Do not patch setTimeout or setInterval to avoid Supabase/Undici crashes!
    }

    uninstall() {
        Date.now = this.originalDateNow;
    }

    advance(targetTime) {
        if (targetTime > this.currentTime) {
            this.currentTime = targetTime;
        }
    }
}
module.exports = SimulatedClock;
