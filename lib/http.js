export const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
export async function readJson(request) { try { return await request.json(); } catch (_) { return null; } }
export const now = () => new Date().toISOString();
export function logEvent(db, actor, action, card_id, from, to) {
  return db.prepare("INSERT INTO events (actor, actor_type, action, card_id, from_value, to_value, at) VALUES (?,?,?,?,?,?,?)")
    .bind(actor.name, actor.type, action, card_id, from ?? null, to ?? null, now());
}
export async function getStages(db) { return (await db.prepare("SELECT name FROM stages ORDER BY n").all()).results.map(r => r.name); }
export async function getCard(db, id) { return db.prepare("SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL").bind(id).first(); }
export async function getApprovals(db, id) {
  return (await db.prepare("SELECT decision, note, actor, created_at FROM approval_decisions WHERE card_id = ? ORDER BY created_at").bind(id).all()).results;
}

// CSRF guard for writes: JSON content type, and Origin (if sent) must match the request host. null = ok.
export function csrfCheck(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return null;
  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return j({ error: "Content-Type must be application/json" }, 415);
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host = null; try { host = new URL(origin).host; } catch (_) {}
    if (host !== new URL(request.url).host) return j({ error: "Cross-origin write rejected" }, 403);
  }
  return null;
}
