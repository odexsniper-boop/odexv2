export function buildFeature(value, eventTime, sourceName, status = 'AVAILABLE', availabilityTime = null) {
    const currentSimulatedTime = availabilityTime !== null ? availabilityTime : Date.now();
    return {
        value,
        timestamp: eventTime,
        source: sourceName,
        freshness: Math.max(0, currentSimulatedTime - eventTime), 
        availability: currentSimulatedTime,
        status
    };
}
