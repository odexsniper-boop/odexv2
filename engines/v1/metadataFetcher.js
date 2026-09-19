const metadataCache = new Map();

/**
 * Normalizes all IPFS gateway variants to the fast dedicated pump.mypinata CDN
 */
export function normalizeIpfsUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Extract CID from ipfs://<cid> or https://<gateway>/ipfs/<cid>
  const match = trimmed.match(/(?:ipfs\/|ipfs:\/\/)([a-zA-Z0-9_-]+)/i);
  if (match && match[1]) {
    return `https://pump.mypinata.cloud/ipfs/${match[1]}`;
  }
  return trimmed;
}

/**
 * Fetches real token name, symbol, and image using pump.fun and DexScreener with fast timeouts
 */
export async function fetchTokenMetadata(mintAddress, fallbackName = null, fallbackSymbol = null) {
  if (metadataCache.has(mintAddress)) {
    const cached = metadataCache.get(mintAddress);
    if (cached && cached.imageUrl && cached.name && cached.name !== 'Unknown Token' && cached.name !== 'Resolving...') return cached;
  }

  // 1. Query pump.fun API first for immediate metadata and image (fast 1200ms timeout)
  try {
    const pumpUrl = `https://frontend-api-v3.pump.fun/coins/${mintAddress}`;
    const res = await fetch(pumpUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(1200)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.name || data.image_uri)) {
        const imageUrl = normalizeIpfsUrl(data.image_uri);
        const meta = {
          name: data.name,
          symbol: data.symbol,
          imageUrl,
          description: data.description || '',
          twitter: data.twitter || null,
          telegram: data.telegram || null,
          website: data.website || null,
          replyCount: data.reply_count || 0,
          usdMarketCap: data.usd_market_cap || null,
        };
        metadataCache.set(mintAddress, meta);
        return meta;
      }
    }
  } catch (err) {}

  // 2. Fallback to DexScreener (fast 1200ms timeout)
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(1200)
    });
    if (res.ok) {
      const json = await res.json();
      if (json.pairs && json.pairs.length > 0) {
        const pair = json.pairs[0];
        const base = pair.baseToken;
        if (base && base.name && base.symbol) {
          const socials = pair.info?.socials || [];
          const twitterObj = socials.find(s => s.type === 'twitter');
          const telegramObj = socials.find(s => s.type === 'telegram');
          const websites = pair.info?.websites || [];
          const imageUrl = normalizeIpfsUrl(pair.info?.imageUrl);
          const meta = {
            name: base.name,
            symbol: base.symbol,
            priceUsd: pair.priceUsd,
            imageUrl,
            description: '',
            twitter: twitterObj?.url || null,
            telegram: telegramObj?.url || null,
            website: websites[0]?.url || null,
            replyCount: 0,
            volume: pair.volume,
            txns: pair.txns,
            liquidity: pair.liquidity?.usd,
          };
          metadataCache.set(mintAddress, meta);
          return meta;
        }
      }
    }
  } catch (err) {}

  // 3. Fast On-Chain Fallback: If external APIs haven't indexed the token yet,
  // return the on-chain decoded name and symbol immediately so the token appears instantly!
  if (fallbackName && fallbackName !== 'Resolving...' && fallbackName !== 'Unknown Token') {
    return {
      name: fallbackName,
      symbol: fallbackSymbol || 'UNK',
      imageUrl: null,
      description: '',
      twitter: null,
      telegram: null,
      website: null,
      replyCount: 0,
      usdMarketCap: null,
    };
  }

  return null;
}

