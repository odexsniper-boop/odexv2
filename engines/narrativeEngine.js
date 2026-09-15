import { log } from '../config.js';
import { socialEngine } from './socialEngine.js';

/**
 * Stage 1: Narrative & Attention Engine
 * Evaluates token mindshare, meme hook, social footprint, and cultural relevance.
 */
export class NarrativeEngine {
  constructor() {
    this.trendingThemes = [
      {
        id: 'AI_AGENT_TECH',
        label: 'AI & Autonomous Meta',
        keywords: ['ai', 'agent', 'gpt', 'deepseek', 'claude', 'bot', 'terminal', 'neural', 'compute', 'singularity', 'virtual', 'model', 'gemini', 'open', 'agi'],
        weight: 35,
      },
      {
        id: 'VIRAL_MEME_CULTURE',
        label: 'Viral Meme / Animal Culture',
        keywords: ['cat', 'dog', 'wif', 'pepe', 'doge', 'shib', 'chad', 'wojak', 'giga', 'chill', 'frog', 'popcat', 'goat', 'bonk', 'retardio', 'mew'],
        weight: 30,
      },
      {
        id: 'INFLUENCER_EVENT_NEWS',
        label: 'Cultural Event & Influencer',
        keywords: ['elon', 'trump', 'musk', 'tate', 'vitalik', 'cz', 'saylor', 'breaking', 'official', 'news', 'nasa', 'mars'],
        weight: 30,
      },
      {
        id: 'COMMUNITY_TAKEOVER',
        label: 'Community Takeover (CTO)',
        keywords: ['cto', 'community', 'reborn', 'revival', 'cult', 'takeover'],
        weight: 25,
      },
    ];

    // Generic spam blacklist
    this.spamPatterns = [
      /^[a-z0-9]{12,}$/i, // Random hash-like name
      /test/i,
      /airdrop/i,
      /presale/i,
      /dev rug/i,
      /free sol/i,
    ];
  }

  /**
   * Evaluates narrative strength of a token
   * @param {Object} metadata - { name, symbol, description, twitter, telegram, website, replyCount }
   * @returns {{ passed: boolean, narrativeScore: number, theme: string, reasons: string[], socialsFound: number }}
   */
  evaluateNarrative(metadata = {}) {
    const name = (metadata.name || '').trim();
    const symbol = (metadata.symbol || '').trim();
    const desc = (metadata.description || '').trim();
    const textCorpus = `${name} ${symbol} ${desc}`.toLowerCase();

    let score = 25; // Base starting score
    const reasons = [];
    let detectedTheme = 'GENERIC';
    let socialsFound = 0;

    // 1. Check Spam / Low Effort Patterns
    for (const pat of this.spamPatterns) {
      if (pat.test(name) || pat.test(symbol)) {
        return {
          passed: false,
          narrativeScore: 10,
          theme: 'SPAM_LOW_EFFORT',
          reasons: ['Flagged by low-effort spam filter pattern'],
          socialsFound: 0,
        };
      }
    }

    // 2. Identify Themes & Keywords
    let maxThemeWeight = 0;
    for (const theme of this.trendingThemes) {
      const match = theme.keywords.find(kw => {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        return regex.test(textCorpus);
      });
      if (match) {
        score += theme.weight;
        reasons.push(`Matches narrative theme [${theme.label}] via "${match}"`);
        if (theme.weight > maxThemeWeight) {
          maxThemeWeight = theme.weight;
          detectedTheme = theme.id;
        }
        break; // Count top theme
      }
    }

    // 3. Social Media & Community Verification (Proof of Audience)
    if (metadata.twitter && metadata.twitter.length > 5) {
      score += 20;
      socialsFound++;
      reasons.push('Verified Twitter/X link attached');
    }
    if (metadata.telegram && metadata.telegram.length > 5) {
      score += 15;
      socialsFound++;
      reasons.push('Verified Telegram community attached');
    }
    if (metadata.website && metadata.website.startsWith('http')) {
      score += 10;
      socialsFound++;
      reasons.push('Dedicated website attached');
    }

    // 4. Description Depth / Meme Lore
    if (desc.length > 40) {
      score += 10;
      reasons.push('Has descriptive narrative lore');
    } else if (desc.length === 0) {
      score -= 10;
      reasons.push('No description provided');
    }

    // 5. Discussion / Community Engagement (reply_count from pump.fun)
    const replies = Number(metadata.replyCount || 0);
    if (replies >= 15) {
      score += 20;
      reasons.push(`High community chatter (${replies} replies)`);
    } else if (replies >= 5) {
      score += 10;
      reasons.push(`Active discussion (${replies} replies)`);
    }

    // 6. Asynchronous Zero-Delay Social Sentiment (RAM Lookup)
    const sentiment = socialEngine.checkSentiment(metadata);
    if (sentiment.bonusScore !== 0) {
      score += sentiment.bonusScore;
      reasons.push(sentiment.reason);
    }

    // Normalization (0-100)
    score = Math.max(0, Math.min(100, Math.round(score)));

    let passed = score >= 40;
    let requiresExceptionalMomentum = false;

    // Narrative VIP Bypass: Score 15-39 puts it on probation (requires exceptional on-chain momentum)
    if (score >= 15 && score < 40) {
      passed = true;
      requiresExceptionalMomentum = true;
    }

    return {
      passed,
      requiresExceptionalMomentum,
      narrativeScore: score,
      theme: detectedTheme,
      reasons,
      socialsFound: (metadata.twitter ? 1 : 0) + (metadata.telegram ? 1 : 0)
    };
  }
}

export const narrativeEngine = new NarrativeEngine();
