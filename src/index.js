// Rasco Holdings opportunity pipeline: one Worker serving the board page and its /api, all behind Cloudflare Access.
import { verifyAccessJwt, actorFromClaims, botClients } from "../lib/auth.js";
import { j, readJson, now, logEvent, getStages, getCard, getApprovals, csrfCheck } from "../lib/http.js";
import { checkMove, cleanFields, validId, nextId, canDecide, canDelete, recordDecision, emailAllowed, isJay, GATE, TYPES } from "../lib/rules.js";

const RULE = "jay-approval-gate";

// Returns { actor, claims } or { error: Response }.
export async function authenticate(request, env, opts = {}) {
  const host = new URL(request.url).hostname;
  // Local `wrangler dev` only: DEV_ACTOR_EMAIL (from .dev.vars) stands in for an Access login. Never honoured off localhost.
  if (env.DEV_ACTOR_EMAIL && (host === "localhost" || host === "127.0.0.1")) {
    const email = String(env.DEV_ACTOR_EMAIL).toLowerCase();
    return { actor: { type: "human", email, name: email }, claims: { email } };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { error: j({ error: "Server not configured for Access" }, 500) };
  let claims;
  try {
    claims = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, ...opts });
  } catch (_) { return { error: j({ error: "Unauthorized: valid Cloudflare Access JWT required" }, 401) }; }
  const actor = actorFromClaims(claims, botClients(env));
  if (!actor) return { error: j({ error: "Forbidden: service token is not mapped to an agent" }, 403) };
  if (actor.type === "human" && !emailAllowed(actor.email, env.ALLOWED_EMAILS)) return { error: j({ error: "Forbidden: this board is private" }, 403) };
  return { actor, claims };
}

async function board({ env, actor, claims }) {
  const [cards, stages, approvals, entered] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM cards WHERE deleted_at IS NULL ORDER BY updated_at DESC"),
    env.DB.prepare("SELECT * FROM stages ORDER BY n"),
    env.DB.prepare("SELECT card_id, decision, note, actor, created_at FROM approval_decisions ORDER BY created_at"),
    env.DB.prepare("SELECT card_id, MAX(at) AS at FROM events WHERE action = 'move' AND to_value = ? GROUP BY card_id").bind(GATE),
  ]);
  const since = Object.fromEntries(entered.results.map(r => [r.card_id, r.at]));
  // At the gate with no decision since it last arrived there (same test recordDecision applies).
  const awaiting = c => c.stage === GATE && !(ap[c.id] || []).some(a => a.created_at >= (since[c.id] || ""));
  const ap = {}; for (const r of approvals.results) (ap[r.card_id] ||= []).push(r);
  return j({
    me: { name: actor.name, type: actor.type, can_approve: isJay(actor) },
    gate: GATE,
    stages: stages.results,
    cards: cards.results.map(c => ({ ...c, approvals: ap[c.id] || [], awaiting_decision: awaiting(c), can_delete: canDelete(claims, actor, c) })),
  });
}

// POST /api/cards {title, type?, id?, stage?, owner?, location?, ask?, link?, next_action?, note?}
async function createCard({ env, request, actor }) {
  const b = await readJson(request);
  if (!b) return j({ error: "JSON body required" }, 400);
  const { fields, error } = cleanFields(b);
  if (error) return j({ error }, 400);
  if (!fields.title) return j({ error: "title is required" }, 400);
  const type = fields.type || "other";
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > 4000) return j({ error: "note is too long (max 4000 chars)" }, 400);
  const stages = await getStages(env.DB);
  const stage = b.stage ? String(b.stage) : stages[0];
  const deny = checkMove(actor, "", stage, stages);
  if (deny) return j({ error: deny.error, rule: RULE }, deny.status);
  let id = b.id ? String(b.id).trim().toUpperCase() : "";
  if (id && !validId(id)) return j({ error: "id must look like RE-001 (A-Z, 0-9, dash)" }, 400);
  if (!id) {
    const prefix = TYPES[type];
    const used = (await env.DB.prepare("SELECT id FROM cards WHERE id LIKE ?").bind(prefix + "-%").all()).results.map(r => r.id);
    id = nextId(prefix, used);
  }
  const t = now();
  const notes = note ? `[${t.slice(0, 10)} ${actor.name}] ${note}` : "";
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cards (id,title,type,stage,owner,location,ask,link,next_action,notes,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, fields.title, type, stage, fields.owner || "", fields.location || "", fields.ask || "", fields.link || "", fields.next_action || "", notes, t, actor.name, t, actor.name),
      logEvent(env.DB, actor, "create", id, null, `${fields.title} @ ${stage}`),
    ]);
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test(String(e && e.message))) return j({ error: `Card ${id} already exists; retry` }, 409);
    throw e;
  }
  return j({ card: { ...(await getCard(env.DB, id)), approvals: [] } }, 201);
}

async function getOne({ env, id }) {
  const card = await getCard(env.DB, id);
  return card ? j({ card: { ...card, approvals: await getApprovals(env.DB, id) } }) : j({ error: "Card not found" }, 404);
}

// PATCH /api/cards/:id  (stage changes go through /move, notes through /notes)
async function patchCard({ env, request, actor, id }) {
  const b = await readJson(request);
  if (!b) return j({ error: "JSON body required" }, 400);
  if ("stage" in b) return j({ error: "Use POST /api/cards/:id/move to change stage" }, 400);
  if ("notes" in b) return j({ error: "Use POST /api/cards/:id/notes to add a note" }, 400);
  const card = await getCard(env.DB, id);
  if (!card) return j({ error: "Card not found" }, 404);
  const { fields, error } = cleanFields(b);
  if (error) return j({ error }, 400);
  if ("title" in fields && !fields.title) return j({ error: "title is required" }, 400);
  const changed = Object.keys(fields).filter(k => (card[k] ?? "") !== fields[k]);
  if (!changed.length) return j({ card });
  await env.DB.batch([
    env.DB.prepare(`UPDATE cards SET ${changed.map(k => `${k} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).bind(...changed.map(k => fields[k]), now(), actor.name, card.id),
    ...changed.map(k => logEvent(env.DB, actor, `update:${k}`, card.id, card[k], fields[k])),
  ]);
  return j({ card: await getCard(env.DB, card.id) });
}

// DELETE /api/cards/:id -> soft delete; history is kept.
async function deleteCard({ env, actor, claims, id }) {
  const card = await getCard(env.DB, id);
  if (!card) return j({ error: "Card not found" }, 404);
  if (!canDelete(claims, actor, card)) return j({ error: "Only Jay, or the agent that owns this card, can delete it" }, 403);
  const t = now();
  const res = await env.DB.prepare("UPDATE cards SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(t, actor.name, t, actor.name, card.id).run();
  if (!res.meta.changes) return j({ error: "Card not found" }, 404);
  await logEvent(env.DB, actor, "delete", card.id, card.stage, null).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

// POST /api/cards/:id/move {stage}
async function moveCard({ env, request, actor, id }) {
  const b = await readJson(request);
  if (!b || typeof b.stage !== "string") return j({ error: "stage is required" }, 400);
  const card = await getCard(env.DB, id);
  if (!card) return j({ error: "Card not found" }, 404);
  if (card.stage === b.stage) return j({ card });
  const deny = checkMove(actor, card.stage, b.stage, await getStages(env.DB));
  if (deny) {
    if (deny.status === 403) await logEvent(env.DB, actor, "denied_move", card.id, card.stage, b.stage).run();
    return j({ error: deny.error, rule: RULE }, deny.status);
  }
  // compare-and-set on the old stage so two movers can't race past the gate
  const res = await env.DB.prepare("UPDATE cards SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ? AND stage = ? AND deleted_at IS NULL")
    .bind(b.stage, now(), actor.name, card.id, card.stage).run();
  if (!res.meta.changes) return j({ error: "Card changed meanwhile; reload and retry" }, 409);
  await logEvent(env.DB, actor, "move", card.id, card.stage, b.stage).run();
  return j({ card: await getCard(env.DB, card.id) });
}

// POST /api/cards/:id/notes {text} -> appends a dated, attributed entry
async function addNote({ env, request, actor, id }) {
  const b = await readJson(request);
  const text = b && typeof b.text === "string" ? b.text.trim() : "";
  if (!text || text.length > 4000) return j({ error: "text is required (max 4000 chars)" }, 400);
  const card = await getCard(env.DB, id);
  if (!card) return j({ error: "Card not found" }, 404);
  const t = now();
  const line = `[${t.slice(0, 10)} ${actor.name}] ${text}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET notes = CASE WHEN notes = '' THEN ?1 ELSE notes || char(10) || ?1 END, updated_at = ?2, updated_by = ?3 WHERE id = ?4").bind(line, t, actor.name, card.id),
    logEvent(env.DB, actor, "note", card.id, null, text.length > 200 ? text.slice(0, 200) + "…" : text),
  ]);
  return j({ card: await getCard(env.DB, card.id) }, 201);
}

// POST /api/cards/:id/decision {decision: "approve"|"reject", note?} -- Jay's own signed-in session only
async function decide({ env, request, actor, claims, id }) {
  if (!canDecide(claims)) return j({ error: "Only Jay's own signed-in session can approve or reject", rule: RULE }, 403);
  const b = await readJson(request);
  if (!b || !["approve", "reject"].includes(b.decision)) return j({ error: 'decision must be "approve" or "reject"' }, 400);
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > 2000) return j({ error: "note is too long (max 2000 chars)" }, 400);
  const card = await getCard(env.DB, id);
  if (!card) return j({ error: "Card not found" }, 404);
  if (card.stage !== GATE) return j({ error: `Card is not in "${GATE}"` }, 409);
  if (!(await recordDecision(env.DB, card.id, b.decision, note, actor.name, now())))
    return j({ error: `A decision was already recorded since this card entered "${GATE}"` }, 409);
  await logEvent(env.DB, actor, "decision", card.id, null, b.decision).run();
  return j({ card: { ...card, approvals: await getApprovals(env.DB, card.id) } }, 201);
}

async function log({ env, url }) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
  const card = url.searchParams.get("card");
  const q = card ? env.DB.prepare("SELECT * FROM events WHERE card_id = ? ORDER BY id DESC LIMIT ?").bind(card, limit)
                 : env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit);
  return j({ events: (await q.all()).results });
}

const ROUTES = [
  ["GET", /^\/api\/board$/, board],
  ["POST", /^\/api\/cards$/, createCard],
  ["GET", /^\/api\/cards\/([^/]+)$/, getOne],
  ["PATCH", /^\/api\/cards\/([^/]+)$/, patchCard],
  ["DELETE", /^\/api\/cards\/([^/]+)$/, deleteCard],
  ["POST", /^\/api\/cards\/([^/]+)\/move$/, moveCard],
  ["POST", /^\/api\/cards\/([^/]+)\/notes$/, addNote],
  ["POST", /^\/api\/cards\/([^/]+)\/decision$/, decide],
  ["GET", /^\/api\/log$/, log],
];

export async function handle(request, env, authOpts) {
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");
  if (isApi) { const bad = csrfCheck(request); if (bad) return bad; }
  const auth = await authenticate(request, env, authOpts);
  if (auth.error) return auth.error;
  if (!isApi) return env.ASSETS.fetch(request);
  let pathMatched = false;
  for (const [method, re, fn] of ROUTES) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    try { return await fn({ env, request, url, actor: auth.actor, claims: auth.claims, id: m[1] && decodeURIComponent(m[1]).toUpperCase() }); }
    catch (e) { console.error(e); return j({ error: "Server error" }, 500); }
  }
  return pathMatched ? j({ error: "Method not allowed" }, 405) : j({ error: "Not found" }, 404);
}

export default { fetch: (request, env) => handle(request, env) };
