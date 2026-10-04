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
        keywords: ['ai', 'agent', 'gpt', 'deepseek', 'claude', 'bot', 'terminal', 'neural', 'compute', 'singularity', 'virtual', 'gemini', 'agi', 'openai', 'open ai', 'llm', 'foundation model', 'ai model', 'language model'],
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
        keywords: ['elon', 'trump', 'musk', 'tate', 'vitalik', 'cz', 'saylor', 'breaking', 'official', 'breaking news', 'crypto news', 'nasa', 'mars'],
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
      /^[0-9a-f]{16,}$/i, // Random hexadecimal hash-like string
      /^[bcdfghjklmnpqrstvwxyz0-9]{10,}$/i, // Random consonant/digit string without vowels
      /test/i,
      /airdrop/i,
      /presale/i,
      /dev rug/i,
      /free sol/i,
    ];
  }

  _isValidSocialHandle(url, type) {
    if (!url || typeof url !== 'string') return false;
    const clean = url.trim().toLowerCase();
    const placeholders = [
      'placeholder', 'example', 'username', 'yourhandle', 'yourchannel',
      'channelname', 'mychannel', 'test', 'pumpfun', 'unknown', 'channel',
      'home', 'null', 'undefined', 'elonmusk', 'solana', 'phantom', 'toly',
      'aeyakovenko', 'cz_binance', 'vitalikbuterin'
    ];

    if (type === 'twitter') {
      const match = clean.match(/(?:twitter\.com|x\.com)\/([a-z0-9_]+)/i);
      if (!match || !match[1]) return false;
      const handle = match[1];
      if (handle.length < 3 || placeholders.includes(handle)) return false;
      return true;
    }

    if (type === 'telegram') {
      const match = clean.match(/(?:t\.me|telegram\.me)\/([a-z0-9_]+)/i);
      if (!match || !match[1]) return false;
      const handle = match[1];
      if (handle.length < 3 || placeholders.includes(handle)) return false;
      return true;
    }

    if (type === 'website') {
      return clean.startsWith('http://') || clean.startsWith('https://');
    }

    return clean.length > 5;
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
        // Guard: Do not flag as spam if token corpus contains valid trending theme keywords
        const hasThemeKeyword = this.trendingThemes.some(theme =>
          theme.keywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(textCorpus))
        );
        if (!hasThemeKeyword) {
          return {
            passed: false,
            narrativeScore: 10,
            theme: 'SPAM_LOW_EFFORT',
            reasons: ['Flagged by low-effort spam filter pattern'],
            socialsFound: 0,
          };
        }
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

    // 3. Social Media & Community Verification (Proof of Audience & Depth)
    if (metadata.twitter && metadata.twitter.length > 5) {
      if (this._isValidSocialHandle(metadata.twitter, 'twitter')) {
        score += 20;
        socialsFound++;
        reasons.push('Verified Twitter/X link attached');
      } else {
        score -= 10;
        reasons.push('Suspicious or placeholder Twitter/X handle flagged');
      }
    }
    if (metadata.telegram && metadata.telegram.length > 5) {
      if (this._isValidSocialHandle(metadata.telegram, 'telegram')) {
        score += 15;
        socialsFound++;
        reasons.push('Verified Telegram community attached');
      } else {
        score -= 10;
        reasons.push('Suspicious or placeholder Telegram handle flagged');
      }
    }
    if (metadata.website && this._isValidSocialHandle(metadata.website, 'website')) {
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

    // Eligibility & Evidence Requirements
    let eligibilityState = 'INSUFFICIENT_DATA';
    let passed = false;
    let requiresExceptionalMomentum = false;

    // Minimum independent positive evidence
    const hasExternalEvidence = socialsFound > 0 || replies >= 5;
    const hasDescriptionEvidence = desc.length > 40 && score >= 40;

    if (score >= 40 && hasExternalEvidence) {
      eligibilityState = 'VERIFIED';
      passed = true;
    } else if (score >= 40 && hasDescriptionEvidence) {
      // Description-only evidence without socials or replies requires exceptional momentum
      eligibilityState = 'PROBATION';
      passed = true;
      requiresExceptionalMomentum = true;
      reasons.push('Probationary status: description-only evidence, requires exceptional momentum');
    } else if (score >= 15 && (hasExternalEvidence || hasDescriptionEvidence)) {
      eligibilityState = 'PROBATION';
      passed = true;
      requiresExceptionalMomentum = true;
      reasons.push('Probationary status: limited evidence, requires exceptional momentum');
    } else {
      eligibilityState = score < 15 ? 'REJECTED' : 'INSUFFICIENT_DATA';
      passed = false;
      if (!hasExternalEvidence && !hasDescriptionEvidence && score >= 15) {
        reasons.push('Rejected: Insufficient independent positive evidence despite base score');
      }
    }

    return {
      passed,
      eligibilityState,
      requiresExceptionalMomentum,
      narrativeScore: score,
      theme: detectedTheme,
      reasons,
      socialsFound
    };
  }
}

export const narrativeEngine = new NarrativeEngine();
