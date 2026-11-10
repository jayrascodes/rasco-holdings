import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";
import { verifyAccessJwt, actorFromClaims } from "../lib/auth.js";

const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const TEAM = "team.cloudflareaccess.com", AUD = "aud123";
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
async function sign(payload, key = kp.privateKey, kid = "k1") {
  const h = enc({ alg: "RS256", kid }), p = enc(payload);
  const s = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p))).toString("base64url");
  return `${h}.${p}.${s}`;
}
const now = Math.floor(Date.now() / 1000);
const base = { aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, iat: now };
const opts = { teamDomain: TEAM, aud: AUD, keys: [jwk] };

test("valid human JWT -> email identity", async () => {
  const c = await verifyAccessJwt(await sign({ ...base, email: "Jay@ras.codes" }), opts);
  assert.deepEqual(actorFromClaims(c, {}), { type: "human", email: "jay@ras.codes", name: "jay@ras.codes" });
});
test("valid service-token JWT -> bot name via mapping", async () => {
  const c = await verifyAccessJwt(await sign({ ...base, common_name: "abc.access" }), opts);
  assert.deepEqual(actorFromClaims(c, { "abc.access": "Wren" }), { type: "bot", name: "Wren", client_id: "abc.access" });
  assert.equal(actorFromClaims(c, {}), null);
});
test("rejects missing, bad signature, wrong aud, expired, unknown kid, wrong iss", async () => {
  await assert.rejects(verifyAccessJwt(null, opts));
  await assert.rejects(verifyAccessJwt("a.b", opts));
  await assert.rejects(verifyAccessJwt(await sign({ ...base, email: "x@y" }, other.privateKey), opts), /signature/);
  await assert.rejects(verifyAccessJwt(await sign({ ...base, aud: ["nope"], email: "x@y" }), opts), /aud/);
  await assert.rejects(verifyAccessJwt(await sign({ ...base, exp: now - 3600, email: "x@y" }), opts), /expired/);
  await assert.rejects(verifyAccessJwt(await sign({ ...base, email: "x@y" }, kp.privateKey, "k2"), opts), /kid/);
  await assert.rejects(verifyAccessJwt(await sign({ ...base, iss: "https://evil", email: "x@y" }), opts), /iss/);
});
test("fetches certs from the team domain", async () => {
  let url;
  const fetcher = async u => { url = u; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  await verifyAccessJwt(await sign({ ...base, email: "a@b" }), { teamDomain: TEAM, aud: AUD, fetcher });
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
});
test("iss is required and must equal the team domain", async () => {
  const { iss, ...noIss } = base;
  await assert.rejects(verifyAccessJwt(await sign({ ...noIss, email: "jay@ras.codes" }), opts), /iss/);
  await assert.rejects(verifyAccessJwt(await sign({ ...base, iss: `https://${TEAM}.evil`, email: "jay@ras.codes" }), opts), /iss/);
});

test("botClients merges BOT_CLIENTS_EXTRA without letting it remap existing bots", async () => {
  const { botClients } = await import("../lib/auth.js");
  assert.deepEqual(botClients({ BOT_CLIENTS: '{"a.access":"Wren"}', BOT_CLIENTS_EXTRA: '{"w.access":"HQ Worker","a.access":"Evil"}' }),
    { "a.access": "Wren", "w.access": "HQ Worker" });
  assert.deepEqual(botClients({ BOT_CLIENTS_EXTRA: '{"w.access":"HQ Worker"}' }), { "w.access": "HQ Worker" });
  assert.deepEqual(botClients({ BOT_CLIENTS: "not json", BOT_CLIENTS_EXTRA: "[1]" }), {});
});
