// GET /api/status — returns relayer balance so frontend knows if onboarding is available

import { ethers } from 'ethers';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { RELAYER_PRIVATE_KEY, RPC_URL, CLAIM_AMOUNT_ETH = '0.01' } = process.env;
  if (!RELAYER_PRIVATE_KEY || !RPC_URL)
    return res.status(500).json({ available: false, reason: 'Misconfigured' });

  try {
    const provider  = new ethers.JsonRpcProvider(RPC_URL);
    const relayer   = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
    const balance   = await provider.getBalance(relayer.address);
    const balEth    = parseFloat(ethers.formatEther(balance));
    const perClaim  = parseFloat(CLAIM_AMOUNT_ETH) + 0.0005;
    const claimsLeft = Math.floor(balEth / perClaim);

    return res.status(200).json({
      available:      claimsLeft > 0,
      claimsLeft,
      balanceZkLTC:   balEth.toFixed(4),
      claimAmount:    CLAIM_AMOUNT_ETH,
    });
  } catch (e) {
    return res.status(500).json({ available: false, reason: 'RPC error' });
  }
}
