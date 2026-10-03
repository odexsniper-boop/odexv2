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
export async function fetchTokenMetadata(mintAddress, fallbackName = null, fallbackSymbol = null, metadataUri = null) {
  if (metadataCache.has(mintAddress)) {
    const cached = metadataCache.get(mintAddress);
    if (cached && (cached.twitter || cached.telegram || cached.website || cached.description) && cached.imageUrl) return cached;
  }

  // 1. Direct IPFS Metadata Fetch if metadataUri is provided (Fastest: 50-150ms)
  if (metadataUri) {
    const gateways = [];
    const pinata = normalizeIpfsUrl(metadataUri);
    if (pinata) gateways.push(pinata);
    if (metadataUri && !gateways.includes(metadataUri)) gateways.push(metadataUri);

    for (const gwUrl of gateways) {
      try {
        const res = await fetch(gwUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
          const d = await res.json();
          if (d && (d.name || d.image || d.description || d.twitter || d.telegram)) {
            const rawImg = d.image || d.image_uri || d.image_url;
            const meta = {
              name: (d.name && d.name.trim()) || fallbackName,
              symbol: (d.symbol && d.symbol.trim()) || fallbackSymbol || 'UNK',
              imageUrl: normalizeIpfsUrl(rawImg),
              description: d.description || '',
              twitter: d.twitter || null,
              telegram: d.telegram || null,
              website: d.website || null,
              replyCount: 0,
            };
            metadataCache.set(mintAddress, meta);
            return meta;
          }
        }
      } catch (err) {}
    }
  }

  // 2. Query pump.fun API using coins query param (fast 1200ms timeout)
  try {
    const pumpUrl = `https://frontend-api-v3.pump.fun/coins?coins=${encodeURIComponent(mintAddress)}`;
    const res = await fetch(pumpUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(1200)
    });
    if (res.ok) {
      const data = await res.json();
      const coin = Array.isArray(data) ? data.find(c => c.mint === mintAddress) || data[0] : data;
      if (coin && (coin.name || coin.image_uri || coin.description)) {
        const imageUrl = normalizeIpfsUrl(coin.image_uri);
        const meta = {
          name: coin.name || fallbackName,
          symbol: coin.symbol || fallbackSymbol,
          imageUrl,
          description: coin.description || '',
          twitter: coin.twitter || null,
          telegram: coin.telegram || null,
          website: coin.website || null,
          replyCount: coin.reply_count || 0,
          usdMarketCap: coin.usd_market_cap || null,
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

