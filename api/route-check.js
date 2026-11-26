// GET /api/route-check?configId=...
// Used by the admin editor to verify a donate.gg config before a charity is approved.
// Calls donate.gg's public "get a config by id" endpoint and reports who the config pays and their status.
import { sendJson, getRoute, isConfigId } from './_lib.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const configId = (url.searchParams.get('configId') || '').trim();
  if (!isConfigId(configId)) {
    return sendJson(res, 400, { ok: false, error: 'Enter a donate.gg config ID: a base58 ID or 0x followed by 64 hex characters.' }, 0);
  }
  const route = await getRoute(configId, { donateKey: process.env.DONATE_API_KEY, fresh: true });
  return sendJson(res, route.ok ? 200 : 502, { configId, checkedAt: new Date().toISOString(), ...route }, 0);
}
