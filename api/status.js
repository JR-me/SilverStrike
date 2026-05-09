// GET /api/status — checks relayer wallet balance via RPC proxy

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL;
const CLAIM_AMOUNT_ETH = process.env.CLAIM_AMOUNT_ETH || '0.01';

async function rpcCall(method, params = []) {
  // Try primary RPC, then fallback
  const urls = [
    RPC_URL,
    'https://rpc.liteforge.caldera.xyz/http',
    'https://liteforge.rpc.caldera.xyz/http',
  ].filter(Boolean);

  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { RELAYER_PRIVATE_KEY } = process.env;
  if (!RELAYER_PRIVATE_KEY) return res.status(500).json({ available: false, reason: 'Misconfigured' });

  try {
    const key = RELAYER_PRIVATE_KEY.startsWith('0x') ? RELAYER_PRIVATE_KEY : `0x${RELAYER_PRIVATE_KEY}`;
    const relayerAddress = new ethers.Wallet(key).address;

    const balHex = await rpcCall('eth_getBalance', [relayerAddress, 'latest']);
    const balEth = parseFloat(ethers.formatEther(BigInt(balHex)));
    const claimsLeft = Math.floor(balEth / (parseFloat(CLAIM_AMOUNT_ETH) + 0.001));

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
