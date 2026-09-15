import { CONFIG, log } from './config.js';

/**
 * Sends a message via Telegram bot API
 * @param {string} text - HTML formatted message text
 */
export async function sendTelegramMessage(text) {
  if (CONFIG.DRY_RUN) {
    log('--- [DRY RUN SIGNAL PREVIEW] ---');
    console.log(text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+(>|$)/g, ''));
    log('--------------------------------');
    return;
  }

  const { BOT_TOKEN, CHAT_ID } = CONFIG.TELEGRAM;
  if (!BOT_TOKEN || !CHAT_ID) {
    log('Error: Telegram token or chat ID is missing in configuration.');
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json();
    if (!data.ok) {
      log('Telegram API Error:', data.description);
    } else {
      log('Signal broadcasted successfully to Telegram.');
    }
  } catch (error) {
    log('Network error sending message to Telegram:', error.message);
  }
}

/**
 * Formats signal parameters into a rich HTML alert and broadcasts it
 * @param {object} signal - Signal data containing symbol, mint, metrics, targets, risk checks, etc.
 */
export async function sendSignal(signal) {
  const dsUrl = `https://dexscreener.com/solana/${signal.mint}`;
  const beUrl = `https://birdeye.so/token/${signal.mint}?chain=solana`;
  
  const text = `
🟢 <b>MOMENTUM RECLAIM SIGNAL: $${signal.symbol}</b>
<code>${signal.mint}</code>

📊 <b>Market Data</b>
• Market Cap (FDV): <b>$${signal.marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b>
• Liquidity Pool: <b>$${signal.liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b> (Ratio: <b>${(signal.liqRatio * 100).toFixed(1)}%</b>)
• Age: <b>${signal.ageMinutes.toFixed(0)} mins</b>

🔍 <b>On-Chain Audit Checks</b>
• Mint Authority: <b>${signal.safety.mintDisabled ? '✅ Revoked' : '❌ Active'}</b>
• Freeze Authority: <b>${signal.safety.freezeDisabled ? '✅ Revoked' : '❌ Active'}</b>
• Top 10 Holders: <b>${signal.safety.top10Percent.toFixed(1)}%</b> (${signal.safety.top10Percent <= 35 ? '✅ Safe' : '⚠️ Centralized'})

📈 <b>Momentum Setup</b>
• Entry Trigger (Reclaim): <b>$${signal.entryPrice.toFixed(8)}</b>
• Invalidation Stop-Loss: <b>$${signal.stopLossPrice.toFixed(8)}</b> (Risk: <b>${(signal.stopLossPercent * 100).toFixed(1)}%</b>)

💼 <b>Risk & Size Calculator (Bankroll: $${CONFIG.RISK.BANKROLL})</b>
• Target Risk: <b>$${(CONFIG.RISK.BANKROLL * (CONFIG.RISK.RISK_PERCENT / 100)).toFixed(2)} (${CONFIG.RISK.RISK_PERCENT}%)</b>
• Recommended Position Size: <b>$${signal.positionSize.toFixed(2)}</b>
• Recommended Slippage: <b>5% - 10%</b>

🔗 <b>Charts & Trading</b>
• <a href="${dsUrl}">DexScreener Chart</a> | <a href="${beUrl}">Birdeye Chart</a>
`;

  await sendTelegramMessage(text);
}
