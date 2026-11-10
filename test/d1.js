// Minimal D1-shaped shim over node:sqlite running the real migrations.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
export function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    _exec: () => /^\s*select/i.test(sql) ? { results: db.prepare(sql).all(...args).map(r => ({ ...r })) } : { meta: { changes: Number(db.prepare(sql).run(...args).changes) } },
  });
  return {
    raw: db, prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { const out = list.map(s => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
