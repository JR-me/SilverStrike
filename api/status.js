// GET /api/status — returns relayer balance so frontend knows if onboarding is available

import { ethers } from 'ethers';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { RELAYER_PRIVATE_KEY, RPC_URL, CLAIM_AMOUNT_ETH = '0.01' } = process.env;
  if (!RELAYER_PRIVATE_KEY || !RPC_URL)
    return res.status(500).json({ available: false, reason: 'Misconfigured' });

  try {
    const key            = RELAYER_PRIVATE_KEY.startsWith('0x') ? RELAYER_PRIVATE_KEY : `0x${RELAYER_PRIVATE_KEY}`;
    const relayerAddress = new ethers.Wallet(key).address;

    // Raw JSON-RPC — same approach as onboard.js
    const rpcRes = await fetch(RPC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [relayerAddress, 'latest'] }),
    });
    const rpcJson = await rpcRes.json();
    if (rpcJson.error) throw new Error(rpcJson.error.message);

    const balEth    = parseFloat(ethers.formatEther(BigInt(rpcJson.result)));
    const perClaim  = parseFloat(CLAIM_AMOUNT_ETH) + 0.001;
    const claimsLeft = Math.floor(balEth / perClaim);

    return res.status(200).json({
      available:    claimsLeft > 0,
      claimsLeft,
      balanceZkLTC: balEth.toFixed(4),
      claimAmount:  CLAIM_AMOUNT_ETH,
    });
  } catch (e) {
    return res.status(500).json({ available: false, reason: `RPC error: ${e.message}` });
  }
}
