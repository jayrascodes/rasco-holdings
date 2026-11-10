import test from "node:test";
import assert from "node:assert/strict";
import { checkMove, cleanFields, canDecide, canDelete, emailAllowed, nextId, recordDecision, STAGES, GATE } from "../lib/rules.js";
import { csrfCheck } from "../lib/http.js";
import { d1 } from "./d1.js";

const jay = { type: "human", email: "jay@ras.codes", name: "jay@ras.codes" };
const other = { type: "human", email: "someone@example.com", name: "someone@example.com" };
const bot = { type: "bot", name: "Scout" };
const fakeJay = { type: "bot", name: "jay@ras.codes", email: "jay@ras.codes" };

test("stage list in code matches the seeded stages table", async () => {
  const rows = (await d1().prepare("SELECT name FROM stages ORDER BY n").all()).results.map(r => r.name);
  assert.deepEqual(rows, STAGES);
});
test("everyone can move freely below the gate", () => {
  for (const a of [jay, other, bot]) {
    assert.equal(checkMove(a, "Sourced", "Screened"), null);
    assert.equal(checkMove(a, "Screened", "Memo ready"), null);
    assert.equal(checkMove(a, "Memo ready", "Sourced"), null);
  }
});
test("only Jay may move into or past Jay approval, or move a card already there", () => {
  for (const to of ["Jay approval", "Offer & closing", "Verdict"]) {
    for (const a of [other, bot, fakeJay, null]) assert.equal(checkMove(a, "Memo ready", to).status, 403);
    assert.equal(checkMove(jay, "Memo ready", to), null);
  }
  for (const from of ["Jay approval", "Offer & closing", "Verdict"]) {
    assert.equal(checkMove(bot, from, "Sourced").status, 403);
    assert.equal(checkMove(jay, from, "Sourced"), null);
  }
  assert.equal(checkMove(jay, "Sourced", "Nope").status, 400);
  assert.match(checkMove(bot, "Memo ready", GATE).error, /Only Jay/);
});
test("cleanFields keeps editable fields only and validates type and link", () => {
  assert.deepEqual(cleanFields({ owner: " Scout ", stage: "Verdict", notes: "n", updated_by: "x" }).fields, { owner: "Scout" });
  assert.ok(cleanFields({ owner: 5 }).error);
  assert.ok(cleanFields({ type: "yacht" }).error);
  assert.ok(cleanFields({ link: "javascript:alert(1)" }).error);
  assert.equal(cleanFields({ link: "https://example.com/listing" }).fields.link, "https://example.com/listing");
});
test("canDecide: only Jay's user session, never a service token or other user", () => {
  assert.equal(canDecide({ email: "Jay@ras.codes" }), true);
  assert.equal(canDecide({ email: "someone@ras.codes" }), false);
  assert.equal(canDecide({ common_name: "abc.access" }), false);
  assert.equal(canDecide({ email: "jay@ras.codes", common_name: "abc.access" }), false);
  assert.equal(canDecide(null), false);
});
test("canDelete: Jay any card, an agent only its own", () => {
  assert.equal(canDelete({ email: "jay@ras.codes" }, jay, { owner: "Scout" }), true);
  assert.equal(canDelete({ common_name: "a.access" }, bot, { owner: "scout" }), true);
  assert.equal(canDelete({ common_name: "a.access" }, bot, { owner: "Other" }), false);
  assert.equal(canDelete({ email: "someone@example.com" }, other, { owner: "someone@example.com" }), false);
});
test("emailAllowed: Jay always, others only when listed", () => {
  assert.equal(emailAllowed("JAY@ras.codes", ""), true);
  assert.equal(emailAllowed("a@b.co", "jay@ras.codes"), false);
  assert.equal(emailAllowed("a@b.co", "jay@ras.codes, A@B.co"), true);
  assert.equal(emailAllowed("", "jay@ras.codes"), false);
});
test("nextId counts up per prefix", () => {
  assert.equal(nextId("RE", []), "RE-001");
  assert.equal(nextId("RE", ["RE-001", "RE-014", "BZ-099", "RE-X"]), "RE-015");
});
test("csrf: writes need JSON content-type and same-origin Origin when present", () => {
  const req = (method, headers = {}) => new Request("https://rh.example/api/cards", { method, headers, body: method === "GET" ? undefined : "{}" });
  assert.equal(csrfCheck(req("GET")), null);
  assert.equal(csrfCheck(req("POST", { "content-type": "application/json", origin: "https://rh.example" })), null);
  assert.equal(csrfCheck(req("POST", { "content-type": "text/plain" })).status, 415);
  assert.equal(csrfCheck(req("POST", { "content-type": "application/json", origin: "https://evil.example" })).status, 403);
});
test("decisions are idempotent per entry into Jay approval", async () => {
  const db = d1();
  db.raw.exec("INSERT INTO cards (id,title,stage) VALUES ('X-1','t','Jay approval')");
  const enter = at => db.raw.exec(`INSERT INTO events (actor,actor_type,action,card_id,from_value,to_value,at) VALUES ('j','human','move','X-1','Memo ready','Jay approval','${at}')`);
  enter("2026-01-01T00:00:00.000Z");
  assert.equal(await recordDecision(db, "X-1", "approve", "", "jay", "2026-01-02T00:00:00.000Z"), true);
  assert.equal(await recordDecision(db, "X-1", "reject", "", "jay", "2026-01-02T00:00:01.000Z"), false);
  enter("2026-01-03T00:00:00.000Z");
  assert.equal(await recordDecision(db, "X-1", "reject", "", "jay", "2026-01-03T00:00:01.000Z"), true);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM approval_decisions").get().n, 2);
});
test("events log is append-only", () => {
  const db = d1();
  db.raw.exec("INSERT INTO events (actor,actor_type,action) VALUES ('j','human','create')");
  assert.throws(() => db.raw.exec("UPDATE events SET actor='x'"), /append-only/);
  assert.throws(() => db.raw.exec("DELETE FROM events"), /append-only/);
});
