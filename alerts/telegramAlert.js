import { CONFIG, log } from '../config.js';

/**
 * Sends a rich Telegram HTML message (or dry-run console print)
 */
export async function sendTelegramRaw(text, imageUrl = null) {
  if (CONFIG.DRY_RUN) {
    log('--- [DRY RUN ACTIONABLE ALERT] ---');
    console.log(text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+(>|$)/g, ''));
    log('-----------------------------------');
    return;
  }

  const { BOT_TOKEN, CHAT_ID } = CONFIG.TELEGRAM;
  if (!BOT_TOKEN || !CHAT_ID) {
    log('Telegram credentials missing, alert printed to log.');
    return;
  }

  const endpoint = imageUrl ? 'sendPhoto' : 'sendMessage';
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`;
  
  const payload = {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
  };

  if (imageUrl) {
    payload.photo = imageUrl;
    payload.caption = text;
  } else {
    payload.text = text;
    payload.disable_web_page_preview = true;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      log('Telegram delivery error:', data.description);
    }
  } catch (err) {
    log('Telegram network exception:', err.message);
  }
}

/**
 * Dispatches an early-warning actionable intelligence card matching exact user specification
 */
export async function dispatchOpportunityAlert(data) {
  const {
    symbol,
    mint,
    ageSeconds,
    marketCap,
    liquidity,
    liqRatio,
    scores,
    kinematics,
    organic,
    audit,
    priceStructure,
    tier,
    opportunityScore,
  } = data;

  const ageMinutes = Math.floor(ageSeconds / 60);
  const ageRemainingSec = Math.floor(ageSeconds % 60);
  const ageStr = `${ageMinutes}m ${ageRemainingSec}s`;

  // Deep Links
  const axiomUrl = `https://axiom.trade/trade/${mint}`;
  const fomoUrl = `https://fomo.fund/token/${mint}`;
  const birdeyeUrl = `https://birdeye.so/token/${mint}?chain=solana`;
  const dexScreenerUrl = `https://dexscreener.com/solana/${mint}`;
  const solscanUrl = `https://solscan.io/token/${mint}`;
  const rugcheckUrl = `https://rugcheck.xyz/tokens/${mint}`;
  const bubblemapsUrl = `https://bubblemaps.io/solana/token/${mint}`;

  const header =
    tier === 'ENTRY_WINDOW'
      ? '━━━━━━━━━━━━━━━━━━━━━━\n🟢 <b>A+ CANDIDATE (ENTRY WINDOW)</b>\n━━━━━━━━━━━━━━━━━━━━━━'
      : '━━━━━━━━━━━━━━━━━━━━━━\n🟡 <b>WATCH CANDIDATE (DEVELOPING)</b>\n━━━━━━━━━━━━━━━━━━━━━━';

  const text = `
${header}

<b>$${symbol}</b>
<code>${mint}</code>
• Age: <b>${ageStr}</b>
• MC: <b>$${Math.round(marketCap).toLocaleString()}</b>
• Liquidity: <b>$${Math.round(liquidity).toLocaleString()}</b> (${(liqRatio * 100).toFixed(1)}%)

<b>SCORES</b>
• MOMENTUM: <b>${scores.momentum}/100</b>
• SAFETY: <b>${scores.safety}/100</b>
• SMART MONEY: <b>${scores.smartMoney}/100</b>
• STRUCTURE: <b>${scores.structure}/100</b>

<b>MARKET KINEMATICS</b>
• Volume Accel: <b>${kinematics.volumeAcceleration}x</b>
• Buy Pressure: <b>${kinematics.buyPressurePercent}%</b>
• Holder Velocity: <b>+${kinematics.holderVelocity}/min</b>
• Liquidity Trend: <b>${kinematics.liquidityChangePercent >= 0 ? '+' : ''}${kinematics.liquidityChangePercent}%</b>

<b>WALLET & DISTRIBUTION</b>
• Top 10 (ex-LP): <b>${audit.top10Percent.toFixed(1)}%</b>
• Dev Holding: <b>${audit.devPercent.toFixed(1)}%</b>
• Sniper/Bundle: <b>${audit.bundlePercent.toFixed(1)}%</b>
• Wash Risk: <b>${organic.washRisk}</b>
• Cluster Risk: <b>${audit.clusterRisk || 'LOW'}</b>
• Dev Risk: <b>${audit.creatorRisk || 'LOW'}</b>

<b>PRICE STRUCTURE</b>
• Stage: <b>${priceStructure.stage}</b>
• Higher Low: <b>${priceStructure.isHigherLow ? '✅ Confirmed' : '⏳ Forming'}</b>
• Pullback Depth: <b>${priceStructure.pullbackDepth}%</b>
• Reclaim Trigger: <b>${priceStructure.isReclaim ? '🟢 Active' : '⏳ Pending'}</b>

🎯 <b>OPPORTUNITY SCORE: ${opportunityScore}/100</b>

🚀 <b>ACTION: ${tier === 'ENTRY_WINDOW' ? '👀 CHECK NOW (CONFIRMED WINDOW)' : '🔍 MONITOR STRUCTURE'}</b>

🔗 <b>RESEARCH & EXECUTION LINKS</b>
[<a href="${axiomUrl}">AXIOM</a>] • [<a href="${fomoUrl}">FOMO</a>] • [<a href="${birdeyeUrl}">BIRDEYE</a>]
[<a href="${dexScreenerUrl}">DEXSCREENER</a>] • [<a href="${solscanUrl}">SOLSCAN</a>] • [<a href="${rugcheckUrl}">RUGCHECK</a>] • [<a href="${bubblemapsUrl}">BUBBLEMAPS</a>]
`;

  const imageUrl = audit?.imageUrl || data.imageUrl || null;
  await sendTelegramRaw(text, imageUrl);
}
