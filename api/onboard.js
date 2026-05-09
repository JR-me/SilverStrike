// ═══════════════════════════════════════════════════════════════════════
//  SilverStrike — Onboarding Relayer
//  POST /api/onboard
//  One claim per wallet. No IP limits. Sends zkLTC to new players.
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

const CLAIM_AMOUNT_ETH = process.env.CLAIM_AMOUNT_ETH || '0.01';

// ── RPC with multiple fallback URLs + timeout ────────────────────────────
let _id = 1;
async function rpc(method, params = []) {
  const urls = [
    process.env.RPC_URL,
    'https://rpc.liteforge.caldera.xyz/http',
    'https://liteforge.rpc.caldera.xyz/http',
  ].filter(Boolean);

  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }),
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if (json.error) throw new Error(`${json.error.code}: ${json.error.message}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      console.warn(`RPC failed on ${url}: ${e.message}`);
    }
  }
  throw new Error(`All RPC endpoints failed. Last: ${lastErr?.message}`);
}

// ── Upstash Redis ────────────────────────────────────────────────────────
const upstashGet = async (key) => {
  const r = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  return (await r.json()).result ?? null;
};

const upstashSet = async (key, value) => {
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
};

// ── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Validate wallet
  const { wallet } = req.body ?? {};
  if (!wallet)                   return res.status(400).json({ error: 'Missing wallet address' });
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
  const address = ethers.getAddress(wallet);

  // Check env
  const { RELAYER_PRIVATE_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!RELAYER_PRIVATE_KEY || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN)
    return res.status(500).json({ error: 'Server misconfigured.' });

  // One-per-wallet check
  const redisKey = `silverstrike:onboard:${address}`;
  const claimed  = await upstashGet(redisKey);
  if (claimed) {
    let claimedAt = '';
    try { claimedAt = JSON.parse(claimed).claimedAt ?? ''; } catch {}
    return res.status(409).json({ error: 'Already claimed', claimed: true,
      message: `Wallet already received zkLTC.${claimedAt ? ` Claimed ${claimedAt}.` : ''}` });
  }

  // Build wallet (signing only — no provider)
  const key            = RELAYER_PRIVATE_KEY.startsWith('0x') ? RELAYER_PRIVATE_KEY : `0x${RELAYER_PRIVATE_KEY}`;
  const relayerWallet  = new ethers.Wallet(key);
  const relayerAddress = relayerWallet.address;

  try {
    const sendAmount = ethers.parseEther(CLAIM_AMOUNT_ETH);
    const gasReserve = ethers.parseEther('0.001');

    // Fetch all network data in parallel
    const [balHex, nonceHex, gasPriceHex, gasEstHex, chainIdHex] = await Promise.all([
      rpc('eth_getBalance',        [relayerAddress, 'latest']),
      rpc('eth_getTransactionCount',[relayerAddress, 'latest']),
      rpc('eth_gasPrice',          []),
      rpc('eth_estimateGas',       [{ from: relayerAddress, to: address, value: '0x' + sendAmount.toString(16) }]),
      rpc('eth_chainId',           []),
    ]);

    if (BigInt(balHex) < sendAmount + gasReserve)
      return res.status(503).json({ error: 'Relayer out of funds.', faucet: 'https://liteforge.hub.caldera.xyz' });

    // Sign legacy tx
    const signedTx = await relayerWallet.signTransaction({
      to:       address,
      value:    sendAmount,
      nonce:    Number(nonceHex),
      gasLimit: BigInt(gasEstHex) + 5000n,
      gasPrice: BigInt(gasPriceHex),
      chainId:  Number(chainIdHex),
      type:     0,
    });

    const txHash = await rpc('eth_sendRawTransaction', [signedTx]);
    console.log(`✅ ${txHash} → ${address}`);

    await upstashSet(redisKey, JSON.stringify({
      txHash, claimedAt: new Date().toISOString(), amount: CLAIM_AMOUNT_ETH,
    }));

    return res.status(200).json({
      success: true, txHash, amount: CLAIM_AMOUNT_ETH,
      explorer: `https://explorer.liteforge.caldera.xyz/tx/${txHash}`,
      message: `${CLAIM_AMOUNT_ETH} zkLTC sent to your wallet!`,
    });

  } catch (err) {
    const msg = err?.message ?? '';
    console.error('Onboard error:', msg);
    if (msg.includes('insufficient funds'))
      return res.status(503).json({ error: 'Relayer out of gas.', faucet: 'https://liteforge.hub.caldera.xyz' });
    if (msg.includes('nonce'))
      return res.status(503).json({ error: 'Relayer busy — retry in a few seconds.' });
    return res.status(500).json({ error: `Failed: ${msg}` });
  }
}
