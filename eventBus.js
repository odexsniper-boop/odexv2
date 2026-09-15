import EventEmitter from 'events';

class BotEventBus extends EventEmitter {}

export const eventBus = new BotEventBus();
// Increase max listeners for heavy event pipelines
eventBus.setMaxListeners(50);
