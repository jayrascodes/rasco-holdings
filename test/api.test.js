// End-to-end through the Worker's fetch handler with real signed Access JWTs and the real schema.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";
import { handle } from "../src/index.js";
import { d1 } from "./d1.js";

const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const TEAM = "team.cloudflareaccess.com", AUD = "aud123";
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
async function token(claims) {
  const n = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "RS256", kid: "k1" }), p = enc({ aud: [AUD], iss: `https://${TEAM}`, exp: n + 600, iat: n, ...claims });
  const s = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(h + "." + p))).toString("base64url");
  return `${h}.${p}.${s}`;
}
const JAY = await token({ email: "jay@ras.codes" });
const STRANGER = await token({ email: "stranger@example.com" });
const SCOUT = await token({ common_name: "scout.access" });
const UNMAPPED = await token({ common_name: "nobody.access" });

function app(extraEnv = {}) {
  const env = { DB: d1(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: "jay@ras.codes", BOT_CLIENTS: '{"scout.access":"Scout"}',
    ASSETS: { fetch: async () => new Response("<html>board</html>") }, ...extraEnv };
  const call = async (tok, method, path, body, host = "rh.example") => {
    const headers = {}; if (tok) headers["Cf-Access-Jwt-Assertion"] = tok; if (method !== "GET") headers["content-type"] = "application/json";
    const r = await handle(new Request(`https://${host}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) }), env, { keys: [jwk] });
    let data = null; try { data = await r.clone().json(); } catch (_) {}
    return { status: r.status, data, text: () => r.text() };
  };
  return { env, call };
}

test("the page and the API are both closed without a valid Access login for an allowed identity", async () => {
  const { call } = app();
  for (const path of ["/", "/api/board"]) {
    assert.equal((await call(null, "GET", path)).status, 401, path);
    assert.equal((await call("a.b.c", "GET", path)).status, 401, path);
    assert.equal((await call(STRANGER, "GET", path)).status, 403, path);
    assert.equal((await call(UNMAPPED, "GET", path)).status, 403, path);
    assert.equal((await call(JAY, "GET", path)).status, 200, path);
    assert.equal((await call(SCOUT, "GET", path)).status, 200, path);
  }
  assert.equal(await (await call(JAY, "GET", "/")).text(), "<html>board</html>");
});
test("fails closed when Access is not configured; dev identity only works on localhost", async () => {
  assert.equal((await app({ ACCESS_AUD: "" }).call(JAY, "GET", "/api/board")).status, 500);
  const dev = app({ DEV_ACTOR_EMAIL: "jay@ras.codes" });
  assert.equal((await dev.call(null, "GET", "/api/board")).status, 401);
  assert.equal((await dev.call(null, "GET", "/api/board", null, "localhost")).data.me.can_approve, true);
});
test("full card flow: agent works a deal up to the gate, only Jay takes it through", async () => {
  const { call, env } = app();
  let r = await call(SCOUT, "POST", "/api/cards", { title: "12-unit on Elm St", type: "real_estate", location: "Tulsa, OK", ask: "$1.4M", link: "https://example.com/elm", note: "Found on LoopNet" });
  assert.equal(r.status, 201);
  assert.equal(r.data.card.id, "RE-001");
  assert.equal(r.data.card.stage, "Sourced");
  assert.match(r.data.card.notes, /^\[\d{4}-\d\d-\d\d Scout\] Found on LoopNet$/);
  assert.equal((await call(SCOUT, "POST", "/api/cards", { title: "Car wash", type: "business" })).data.card.id, "BZ-001");
  assert.equal((await call(SCOUT, "POST", "/api/cards", { title: "Duplex", type: "real_estate" })).data.card.id, "RE-002");
  assert.equal((await call(SCOUT, "POST", "/api/cards", { title: "" })).status, 400);
  assert.equal((await call(SCOUT, "POST", "/api/cards", { title: "Sneaky", stage: "Verdict" })).status, 403);

  r = await call(SCOUT, "PATCH", "/api/cards/RE-001", { owner: "Scout", next_action: "Pull rent roll" });
  assert.equal(r.data.card.next_action, "Pull rent roll");
  assert.equal((await call(SCOUT, "PATCH", "/api/cards/RE-001", { stage: "Verdict" })).status, 400);
  r = await call(SCOUT, "POST", "/api/cards/RE-001/notes", { text: "NOI $118k, 8.4% cap" });
  assert.equal(r.status, 201);
  assert.equal(r.data.card.notes.split("\n").length, 2);

  assert.equal((await call(SCOUT, "POST", "/api/cards/RE-001/move", { stage: "Memo ready" })).data.card.stage, "Memo ready");
  r = await call(SCOUT, "POST", "/api/cards/RE-001/move", { stage: "Jay approval" });
  assert.equal(r.status, 403);
  assert.equal(r.data.rule, "jay-approval-gate");
  assert.equal((await call(SCOUT, "POST", "/api/cards/RE-001/decision", { decision: "approve" })).status, 403);
  assert.equal((await call(JAY, "POST", "/api/cards/RE-001/decision", { decision: "approve" })).status, 409); // not at the gate yet

  assert.equal((await call(JAY, "POST", "/api/cards/RE-001/move", { stage: "Jay approval" })).status, 200);
  assert.equal((await call(SCOUT, "POST", "/api/cards/RE-001/move", { stage: "Sourced" })).status, 403);
  const awaiting = async () => (await call(JAY, "GET", "/api/board")).data.cards.find(c => c.id === "RE-001").awaiting_decision;
  assert.equal(await awaiting(), true);
  r = await call(JAY, "POST", "/api/cards/RE-001/decision", { decision: "approve", note: "Offer at $1.3M" });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.card.approvals.map(a => [a.decision, a.note, a.actor]), [["approve", "Offer at $1.3M", "jay@ras.codes"]]);
  assert.equal((await call(JAY, "POST", "/api/cards/RE-001/decision", { decision: "reject" })).status, 409);
  assert.equal(await awaiting(), false);

  r = await call(SCOUT, "GET", "/api/board");
  assert.equal(r.data.me.can_approve, false);
  assert.equal(r.data.stages.length, 8);
  const card = r.data.cards.find(c => c.id === "RE-001");
  assert.equal(card.approvals.length, 1);
  assert.equal(card.can_delete, true); // Scout owns it
  assert.equal(r.data.cards.find(c => c.id === "BZ-001").can_delete, false);

  const actions = (await call(JAY, "GET", "/api/log?card=RE-001")).data.events.map(e => e.action).reverse();
  assert.deepEqual(actions, ["create", "update:owner", "update:next_action", "note", "move", "denied_move", "move", "denied_move", "decision"]);

  assert.equal((await call(SCOUT, "DELETE", "/api/cards/BZ-001")).status, 403);
  assert.equal((await call(JAY, "DELETE", "/api/cards/BZ-001")).status, 204);
  assert.equal((await call(JAY, "GET", "/api/cards/BZ-001")).status, 404);
  assert.equal((await call(SCOUT, "POST", "/api/cards", { title: "Laundromat", type: "business" })).data.card.id, "BZ-002"); // deleted ids are not reused
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM cards").get().n, 4);
});
test("routing: unknown path 404, wrong method 405, cross-origin write rejected", async () => {
  const { call, env } = app();
  assert.equal((await call(JAY, "GET", "/api/nope")).status, 404);
  assert.equal((await call(JAY, "DELETE", "/api/board")).status, 405);
  const r = await handle(new Request("https://rh.example/api/cards", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": JAY, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }), env, { keys: [jwk] });
  assert.equal(r.status, 403);
});
