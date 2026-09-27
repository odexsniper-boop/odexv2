async function check() {
  const mint = 'FGT1vzjKKrLTf6vS6LHMYKAjHjTj6n8HJtXjNz54pump';
  const res = await fetch('https://pump.fun/coin/' + mint, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const t = await res.text();
  const og = t.match(/<meta property="og:image" content="([^"]+)"/i);
  if (og) console.log('OG IMAGE:', og[1]);
  const twitter = t.match(/<meta name="twitter:image" content="([^"]+)"/i);
  if (twitter) console.log('TWITTER IMAGE:', twitter[1]);
  const ipfs = t.match(/https:\/\/[a-zA-Z0-9.-]+\/ipfs\/[a-zA-Z0-9_-]+/gi);
  if (ipfs) console.log('IPFS MATCHES:', [...new Set(ipfs)]);
}
check();
