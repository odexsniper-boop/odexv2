import { CONFIG, log } from '../config.js';

export class TradeNotifier {
  constructor() {
    this.botToken = CONFIG.TELEGRAM.BOT_TOKEN;
    this.chatId = CONFIG.TELEGRAM.CHAT_ID;
  }

  async sendTelegramMessage(text) {
    if (!this.botToken || !this.chatId || this.botToken.includes('your_bot_token')) {
      return; // Skip if credentials not set
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (e) {
      log(`[TELEGRAM NOTIFIER ERR] ${e.message}`);
    }
  }

  notifyTradeOpen(pos) {
    const msg = `?? <b>PUMP.FUN SNIPE EXECUTED</b>\n\n` +
      `<b>Mint:</b> <code>${pos.mint}</code>\n` +
      `<b>Entry Price:</b> ${pos.entryPriceSol.toExponential(4)} SOL\n` +
      `<b>Size:</b> ${pos.initialSolSpent} SOL\n` +
      `<b>Mode:</b> ${pos.mode || 'PAPER'}\n` +
      `<b>Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
      `<a href="https://solscan.io/token/${pos.mint}">View on Solscan</a>`;
    this.sendTelegramMessage(msg);
  }

  notifyTradeClose(trade) {
    const isWin = (trade.finalPnlPercent || 0) >= 0;
    const emoji = isWin ? '??' : '??';
    const msg = `${emoji} <b>POSITION CLOSED: ${trade.reason || 'EXIT'}</b>\n\n` +
      `<b>Mint:</b> <code>${trade.mint}</code>\n` +
      `<b>P&L:</b> ${isWin ? '+' : ''}${(trade.finalPnlPercent || 0).toFixed(2)}%\n` +
      `<b>Net SOL:</b> ${(trade.netProfitSol || trade.profitSol || 0).toFixed(4)} SOL\n` +
      `<b>Exit Reason:</b> ${trade.reason}\n\n` +
      `<a href="https://solscan.io/token/${trade.mint}">View on Solscan</a>`;
    this.sendTelegramMessage(msg);
  }
}
