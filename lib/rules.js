// Pure pipeline rules (no I/O) so they can be unit-tested in Node.
export const STAGES = ["Sourced", "Screened", "Underwriting", "Diligence", "Memo ready", "Jay approval", "Offer & closing", "Verdict"];
export const GATE = "Jay approval";
export const JAY_EMAIL = "jay@ras.codes";
export const TYPES = { real_estate: "RE", business: "BZ", other: "OP" };

export const stageIndex = (s, stages = STAGES) => stages.indexOf(s);
export const isJay = actor => !!actor && actor.type === "human" && String(actor.email || "").toLowerCase() === JAY_EMAIL;

// Humans allowed through the door at all. Jay is always allowed; ALLOWED_EMAILS can add more (they still can't approve).
export function emailAllowed(email, allowedCsv) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (e === JAY_EMAIL) return true;
  return String(allowedCsv || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).includes(e);
}

// Gate: only Jay may set a stage at/past "Jay approval", or move a card that is currently at/past it.
// Returns null when allowed, or {status, error} when not.
export function checkMove(actor, fromStage, toStage, stages = STAGES) {
  const to = stageIndex(toStage, stages);
  if (to < 0) return { status: 400, error: `Unknown stage "${toStage}"` };
  const gate = stageIndex(GATE, stages);
  const from = stageIndex(fromStage || "", stages);
  const gated = to >= gate || (from >= 0 && from >= gate);
  if (gated && !isJay(actor)) {
    return { status: 403, error: `Only Jay can move a card into or past "${GATE}". ${actor && actor.name ? actor.name : "You"} can move cards up to "${stages[gate - 1]}".` };
  }
  return null;
}

export const EDITABLE = ["title", "type", "owner", "location", "ask", "link", "next_action"];
export function cleanFields(body) {
  const out = {};
  for (const k of EDITABLE) if (body && Object.prototype.hasOwnProperty.call(body, k)) {
    const v = body[k];
    if (v !== null && typeof v !== "string") return { error: `${k} must be a string` };
    if (v && v.length > 2000) return { error: `${k} is too long` };
    out[k] = (v ?? "").trim();
  }
  if ("type" in out && !TYPES[out.type]) return { error: `type must be one of: ${Object.keys(TYPES).join(", ")}` };
  if (out.link && !/^https?:\/\/\S+$/i.test(out.link)) return { error: "link must be an http(s) URL" };
  return { fields: out };
}
export const validId = id => typeof id === "string" && /^[A-Z0-9][A-Z0-9-]{1,23}$/.test(id);

// Next id for a type prefix given the ids already used (deleted cards included): RE-001, RE-002, ...
export function nextId(prefix, existingIds) {
  let max = 0;
  for (const id of existingIds) { const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

// Approval decisions: only Jay's own interactive Access user session (email claim, no service-token claims).
export function canDecide(claims) {
  if (!claims || typeof claims !== "object") return false;
  if (claims.common_name || claims.service_token_id || claims.service_token_status) return false;
  return String(claims.email || "").toLowerCase() === JAY_EMAIL;
}

// Insert a decision only if none exists since the card last entered the gate (last move into it, else creation).
// Single conditional INSERT so concurrent repeats can't both land. Returns true if recorded.
export async function recordDecision(db, cardId, decision, note, actor, at) {
  const r = await db.prepare(`INSERT INTO approval_decisions (card_id, decision, note, actor, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
      SELECT 1 FROM approval_decisions WHERE card_id = ?1 AND created_at >= COALESCE(
        (SELECT MAX(at) FROM events WHERE card_id = ?1 AND action = 'move' AND to_value = ?6), ''))`)
    .bind(cardId, decision, note, actor, at, GATE).run();
  return !!(r.meta && r.meta.changes);
}

// Delete: Jay's user session may delete any card; an agent only cards it owns (case-insensitive).
export function canDelete(claims, actor, card) {
  if (canDecide(claims)) return true;
  if (!claims || !claims.common_name || !actor || actor.type !== "bot" || claims.email) return false;
  const owner = String(card && card.owner || "").trim().toLowerCase();
  return !!owner && owner === String(actor.name).trim().toLowerCase();
}
