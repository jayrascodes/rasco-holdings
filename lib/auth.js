// Cloudflare Access JWT validation (RS256 against the team's certs + AUD).
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const json = s => JSON.parse(new TextDecoder().decode(b64u(s)));

let certCache = { at: 0, keys: null, url: "" };
async function getKeys(certsUrl, fetcher) {
  if (certCache.keys && certCache.url === certsUrl && Date.now() - certCache.at < 10 * 60 * 1000) return certCache.keys;
  const r = await fetcher(certsUrl);
  if (!r.ok) throw new Error("certs fetch failed");
  const { keys } = await r.json();
  certCache = { at: Date.now(), keys, url: certsUrl };
  return keys;
}

// opts: { teamDomain, aud, fetcher?, now? (seconds), keys? (JWK array, for tests) }
export async function verifyAccessJwt(token, opts) {
  if (!token || typeof token !== "string") throw new Error("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = json(parts[0]), payload = json(parts[1]);
  if (header.alg !== "RS256") throw new Error("bad alg");
  const keys = opts.keys || await getKeys(`https://${opts.teamDomain}/cdn-cgi/access/certs`, opts.fetcher || fetch);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown kid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("not yet valid");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud)) throw new Error("bad aud");
  if (payload.iss !== `https://${opts.teamDomain}`) throw new Error("bad iss");
  return payload;
}

// Map verified claims to an actor. botMap: { "<client id>": "Wren", ... } (non-secret).
export function actorFromClaims(claims, botMap) {
  if (claims.email) return { type: "human", email: String(claims.email).toLowerCase(), name: String(claims.email).toLowerCase() };
  const cid = claims.common_name;
  if (cid && botMap && botMap[cid]) return { type: "bot", name: botMap[cid], client_id: cid };
  return null;
}

// Client id -> bot name. BOT_CLIENTS is the original map; BOT_CLIENTS_EXTRA adds bots without
// having to rewrite it (Pages hides encrypted values). Extra entries never remap an existing bot.
export function botClients(env) {
  const parse = s => { try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (_) { return {}; } };
  return { ...parse(env.BOT_CLIENTS_EXTRA), ...parse(env.BOT_CLIENTS) };
}
