// ═══════════════════════════════════════════════════════════════════════
//  SilverStrike — Onboarding Relayer
//  Vercel Serverless Function  →  POST /api/onboard
//
//  Rules:
//    • One claim per wallet address (enforced via Upstash Redis)
//    • No IP restrictions
//    • Sends a fixed amount of zkLTC from the relayer wallet
//
//  Required env vars (set in Vercel dashboard):
//    RELAYER_PRIVATE_KEY        your funded relayer wallet private key (with 0x prefix)
//    RPC_URL                    https://rpc.liteforge.caldera.xyz/http
//    UPSTASH_REDIS_REST_URL     from upstash.com free tier
//    UPSTASH_REDIS_REST_TOKEN   from upstash.com free tier
//    CLAIM_AMOUNT_ETH           amount of zkLTC to send (default: 0.01)
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

// ── Raw JSON-RPC helper ──────────────────────────────────────────────────
// Uses fetch directly instead of ethers.JsonRpcProvider.
// Caldera RPC works fine with server-side POST requests when sent with
// explicit Content-Type headers — ethers provider can sometimes fail in
// Vercel's sandboxed environment due to missing browser globals.
let _rpcId = 1;
async function rpc(method, params = []) {
  const res = await fetch(process.env.RPC_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

// ── Upstash Redis helpers ────────────────────────────────────────────────
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

// ── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate wallet address ───────────────────────────────────────────
  const { wallet } = req.body ?? {};
  if (!wallet)                   return res.status(400).json({ error: 'Missing wallet address' });
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
  const address = ethers.getAddress(wallet);

  // ── Check env vars ────────────────────────────────────────────────────
  const {
    RELAYER_PRIVATE_KEY,
    RPC_URL,
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN,
    CLAIM_AMOUNT_ETH = '0.01',
  } = process.env;

  if (!RELAYER_PRIVATE_KEY || !RPC_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error('Missing env vars');
    return res.status(500).json({ error: 'Server misconfigured — contact the team.' });
  }

  // ── One-per-wallet check ──────────────────────────────────────────────
  const redisKey       = `silverstrike:onboard:${address}`;
  const alreadyClaimed = await upstashGet(redisKey);
  if (alreadyClaimed) {
    let claimedAt = '';
    try { claimedAt = JSON.parse(alreadyClaimed).claimedAt ?? ''; } catch {}
    return res.status(409).json({
      error:   'Already claimed',
      message: `Wallet ${address} already received onboarding zkLTC.${claimedAt ? ` Claimed on ${claimedAt}.` : ''}`,
      claimed: true,
    });
  }

  // ── Build relayer wallet (signing only, no provider) ──────────────────
  const relayerKey     = RELAYER_PRIVATE_KEY.startsWith('0x') ? RELAYER_PRIVATE_KEY : `0x${RELAYER_PRIVATE_KEY}`;
  const relayerWallet  = new ethers.Wallet(relayerKey);
  const relayerAddress = relayerWallet.address;

  try {
    // Get balance
    const balHex     = await rpc('eth_getBalance', [relayerAddress, 'latest']);
    const balance    = BigInt(balHex);
    const sendAmount = ethers.parseEther(CLAIM_AMOUNT_ETH);
    const gasReserve = ethers.parseEther('0.001');

    if (balance < sendAmount + gasReserve) {
      return res.status(503).json({
        error:  'Relayer temporarily out of funds. Please use the official faucet.',
        faucet: 'https://liteforge.hub.caldera.xyz',
      });
    }

    // Get nonce, gas price, gas estimate, chain ID in parallel
    const [nonceHex, gasPriceHex, gasEstHex, chainIdHex] = await Promise.all([
      rpc('eth_getTransactionCount', [relayerAddress, 'latest']),
      rpc('eth_gasPrice', []),
      rpc('eth_estimateGas', [{ from: relayerAddress, to: address, value: '0x' + sendAmount.toString(16) }]),
      rpc('eth_chainId', []),
    ]);

    const nonce    = Number(nonceHex);
    const gasPrice = BigInt(gasPriceHex);
    const gasLimit = BigInt(gasEstHex) + 5000n;
    const chainId  = Number(chainIdHex);

    // Build, sign, and broadcast
    const signedTx = await relayerWallet.signTransaction({
      to:       address,
      value:    sendAmount,
      nonce,
      gasLimit,
      gasPrice,
      chainId,
      type:     0, // legacy tx — most compatible
    });

    const txHash = await rpc('eth_sendRawTransaction', [signedTx]);
    console.log(`✅ Onboard tx: ${txHash} → ${address}`);

    // Mark claimed in Redis
    await upstashSet(redisKey, JSON.stringify({
      txHash,
      claimedAt: new Date().toISOString(),
      amount:    CLAIM_AMOUNT_ETH,
    }));

    return res.status(200).json({
      success:  true,
      txHash,
      amount:   CLAIM_AMOUNT_ETH,
      explorer: `https://explorer.liteforge.caldera.xyz/tx/${txHash}`,
      message:  `${CLAIM_AMOUNT_ETH} zkLTC sent to your wallet!`,
    });

  } catch (err) {
    const msg = err?.message ?? '';
    console.error('Onboard error:', msg);
    if (msg.includes('insufficient funds'))
      return res.status(503).json({ error: 'Relayer out of gas. Try the faucet.', faucet: 'https://liteforge.hub.caldera.xyz' });
    if (msg.includes('nonce'))
      return res.status(503).json({ error: 'Relayer busy — try again in a few seconds.' });
    return res.status(500).json({ error: `Transaction failed: ${msg}` });
  }
}
