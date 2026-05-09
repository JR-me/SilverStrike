// ═══════════════════════════════════════════════════════════════════════
//  SilverStrike — Onboarding Relayer
//  Vercel Serverless Function  →  POST /api/onboard
//
//  Rules:
//    • One claim per wallet address (enforced via Upstash Redis)
//    • No IP restrictions
//    • Sends a fixed amount of zkLTC from the relayer wallet
//    • Returns txHash on success
//
//  Required env vars (set in Vercel dashboard):
//    RELAYER_PRIVATE_KEY        your funded relayer wallet private key
//    RPC_URL                    https://rpc.liteforge.caldera.xyz/http
//    UPSTASH_REDIS_REST_URL     from upstash.com free tier
//    UPSTASH_REDIS_REST_TOKEN   from upstash.com free tier
//    CLAIM_AMOUNT_ETH           amount of zkLTC to send (default: 0.01)
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

// ── Upstash Redis helpers (plain fetch, no SDK) ─────────────────────────
const upstashGet = async (key) => {
  const r = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const j = await r.json();
  return j.result ?? null;
};

const upstashSet = async (key, value) => {
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
};

// ── Main handler ────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // CORS — allow any origin so the frontend can call this
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate wallet address ─────────────────────────────────────────
  const { wallet } = req.body ?? {};
  if (!wallet)               return res.status(400).json({ error: 'Missing wallet address' });
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });

  // Normalise to checksummed address — consistent Redis key regardless of case
  const address = ethers.getAddress(wallet);

  // ── Check env vars ──────────────────────────────────────────────────
  const {
    RELAYER_PRIVATE_KEY,
    RPC_URL,
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN,
    CLAIM_AMOUNT_ETH = '0.01',
  } = process.env;

  if (!RELAYER_PRIVATE_KEY || !RPC_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Server misconfigured — contact the team.' });
  }

  // ── One-per-wallet check ────────────────────────────────────────────
  const redisKey    = `silverstrike:onboard:${address}`;
  const alreadyClaimed = await upstashGet(redisKey);

  if (alreadyClaimed) {
    let claimedAt = '';
    try { claimedAt = JSON.parse(alreadyClaimed).claimedAt ?? ''; } catch {}
    return res.status(409).json({
      error:     'Already claimed',
      message:   `Wallet ${address} already received onboarding zkLTC.${claimedAt ? ` Claimed on ${claimedAt}.` : ''}`,
      claimed:   true,
    });
  }

  // ── Send zkLTC ──────────────────────────────────────────────────────
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const relayer  = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

    // Guard: make sure relayer has enough funds
    const balance     = await provider.getBalance(relayer.address);
    const sendAmount  = ethers.parseEther(CLAIM_AMOUNT_ETH);
    const gasReserve  = ethers.parseEther('0.0005'); // keep a tiny buffer for gas

    if (balance < sendAmount + gasReserve) {
      return res.status(503).json({
        error:   'Relayer temporarily out of funds. Please use the official faucet.',
        faucet:  'https://liteforge.hub.caldera.xyz',
      });
    }

    // Estimate gas then send
    const gasLimit = await provider.estimateGas({
      to:   address,
      value: sendAmount,
      from: relayer.address,
    });

    const tx = await relayer.sendTransaction({
      to:       address,
      value:    sendAmount,
      gasLimit: gasLimit + 5000n,
    });

    // Mark as claimed immediately after broadcast (before confirmation)
    // This prevents race-condition double-claims
    await upstashSet(redisKey, JSON.stringify({
      txHash:    tx.hash,
      claimedAt: new Date().toISOString(),
      amount:    CLAIM_AMOUNT_ETH,
    }));

    return res.status(200).json({
      success:  true,
      txHash:   tx.hash,
      amount:   CLAIM_AMOUNT_ETH,
      explorer: `https://explorer.liteforge.caldera.xyz/tx/${tx.hash}`,
      message:  `${CLAIM_AMOUNT_ETH} zkLTC sent to your wallet!`,
    });

  } catch (err) {
    const msg = err?.message ?? '';
    if (msg.includes('insufficient funds'))
      return res.status(503).json({ error: 'Relayer out of gas. Try the faucet.', faucet: 'https://liteforge.hub.caldera.xyz' });
    if (msg.includes('nonce'))
      return res.status(503).json({ error: 'Relayer busy — try again in a few seconds.' });
    console.error('Onboard error:', err);
    return res.status(500).json({ error: 'Transaction failed. Please try again.' });
  }
}
