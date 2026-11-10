# Rasco Holdings

An approval pipeline for business and real estate opportunities. Each opportunity is a card on a kanban board; the card carries its notes, its full history and Jay's decision. Modelled on the One Hundred HQ pipeline board (`jayrascodes/hq`).

It is one Cloudflare Worker (`rasco-holdings`): the board page and its `/api`, backed by the D1 database `rasco-holdings`.

## The pipeline

| # | Stage | Who can move a card here | Leaves the stage when |
|---|-------|--------------------------|-----------------------|
| 0 | Sourced | anyone | Logged with a link, location and asking price |
| 1 | Screened | anyone | Fits the buy box; obvious deal-breakers ruled out |
| 2 | Underwriting | anyone | Numbers in notes: price, income, costs, financing, return |
| 3 | Diligence | anyone | Documents, legal, title and condition checked; risks listed |
| 4 | Memo ready | anyone | One-page memo in notes: the ask, the case, the risks, the recommendation |
| 5 | **Jay approval** | Jay only | Jay approves or rejects |
| 6 | Offer & closing | Jay only | Offer made, contract signed, closed or fallen through |
| 7 | Verdict | Jay only | Closed, passed or killed, with the reason in notes |

Rules (`lib/rules.js`, enforced in the API, not just the page):

- Only Jay (`JAY_EMAIL` in `lib/rules.js`) can move a card into or past **Jay approval**, or move a card that is already there. Anyone else gets `403` and the attempt is logged as `denied_move`.
- Only Jay's own signed-in session can approve or reject, once per visit to the gate. A service token can never decide.
- Approving records the decision; it does not move the card. Jay moves it on to Offer & closing (or back) himself.
- Notes are append-only, dated and attributed. Every change is written to the append-only `events` table.
- Deleting is a soft delete: Jay any card, an agent only cards it owns. Ids are never reused.

Stage names and order live in the `stages` table (`migrations/0002_stages.sql`) and in `STAGES` in `lib/rules.js`; a test fails if they drift apart.

## Who gets in

Every request, the page included, must carry a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`), checked in the Worker against the team certs and the application AUD. On top of that:

- Humans: only emails in `ALLOWED_EMAILS` (default: Jay only). Anyone else gets `403` even with a valid Access login.
- Agents: an Access service token whose client id is mapped to a name in `BOT_CLIENTS`. Unmapped tokens get `403`.
- If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty the Worker answers `500` to everything, so a deploy without Access set up exposes nothing.

## Deploy

The D1 database already exists (id in `wrangler.jsonc`). One-time setup:

1. `npm install`, then `npx wrangler login`.
2. `npm run deploy` (applies the migrations, then deploys). The Worker is live but answers `500` until step 4.
3. Cloudflare dashboard → Workers & Pages → `rasco-holdings` → Settings → Domains & Routes → `workers.dev` → **Enable Cloudflare Access**. In Zero Trust → Access → Applications, open the application it created and set its policy to Allow, Emails: Jay's address only. Copy the application's **AUD tag**.
4. Put the team domain (`<team>.cloudflareaccess.com`, the same one HQ uses) and the AUD tag in `vars` in `wrangler.jsonc`, then `npm run deploy` again.

To have pushes to `main` deploy on their own, connect the repo under the Worker's Settings → Builds, with deploy command `npm run deploy`.

## Adding an agent

1. Zero Trust → Access → Service Auth → create a service token for the agent.
2. Add a **Service Auth** policy for that token to the `rasco-holdings` Access application.
3. Add `"<client id>": "<Agent name>"` to `BOT_CLIENTS` in `wrangler.jsonc` and deploy. The client id is not secret; the client secret never goes in this repo.

## API

Agents send both headers on every request; Access swaps them for a JWT before the Worker sees it.

```bash
RH=https://rasco-holdings.<subdomain>.workers.dev
H=(-H "CF-Access-Client-Id: <CLIENT_ID>" -H "CF-Access-Client-Secret: <CLIENT_SECRET>")

# Board: stages, cards (with decisions), and who you are
curl -s "${H[@]}" "$RH/api/board"

# Create a card. Lands in Sourced; id is assigned (RE-001, BZ-001, OP-001) unless you pass one.
curl -s "${H[@]}" -H 'content-type: application/json' \
  -d '{"title":"12-unit on Elm St","type":"real_estate","location":"Tulsa, OK","ask":"$1.4M","link":"https://...","owner":"Scout","note":"Found on a broker list"}' \
  "$RH/api/cards"

# Update fields (any of: title, type, owner, location, ask, link, next_action)
curl -s "${H[@]}" -X PATCH -H 'content-type: application/json' -d '{"next_action":"Pull rent roll"}' "$RH/api/cards/RE-001"

# Add a note (dated and attributed)
curl -s "${H[@]}" -H 'content-type: application/json' -d '{"text":"NOI $118k, 8.4% cap"}' "$RH/api/cards/RE-001/notes"

# Move stage (agents can go up to "Memo ready"; "Jay approval" and later -> 403)
curl -s "${H[@]}" -H 'content-type: application/json' -d '{"stage":"Underwriting"}' "$RH/api/cards/RE-001/move"

# One card, and the activity log (optionally ?card=RE-001&limit=50)
curl -s "${H[@]}" "$RH/api/cards/RE-001"
curl -s "${H[@]}" "$RH/api/log?limit=20"
```

`type` is `real_estate`, `business` or `other`. Errors are JSON: `{"error":"..."}`, with `"rule":"jay-approval-gate"` on a blocked move or decision. Jay-only: `POST /api/cards/:id/decision {"decision":"approve"|"reject","note":"..."}`.

## Local development

`.dev.vars` (gitignored) can set `DEV_ACTOR_EMAIL` to stand in for an Access login. It is only honoured on localhost.

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

```bash
npm test
```

## Layout

- `src/index.js`: the Worker (auth, routes).
- `lib/`: Access JWT check, pipeline rules, HTTP helpers.
- `public/index.html`: the board.
- `migrations/`: D1 schema and stage seed.
- `test/`: rules, JWT validation, and the API end to end against the real schema.
