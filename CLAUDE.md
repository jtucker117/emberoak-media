# CLAUDE.md — guidance for Claude Code

This repo is **ready to deploy as-is**. Follow the human's request; below is the map.

## Architecture
- **One Node/Express service** (`backend/`) that (a) exposes a JSON API under `/api/*`
  and (b) serves the compiled website from `backend/public/`.
- **Cloudinary** stores all media. The server holds the Cloudinary API secret and
  signs every upload/delete so each studio/client is confined to its own folder.
- No database — studio logins live in `CLIENTS_JSON`, delivery galleries in
  `GALLERIES_JSON` (or any `deliveries/<code>` folder when `ALLOW_OPEN_DELIVERIES=true`).

## The website file is a design artifact
`Ember & Oak.dc.html` is a **Design Component** authored in an HTML design tool
(Omelette/DC runtime). `backend/public/index.html` is the **compiled, self-contained**
build of it. Treat the `.dc.html` as the source of truth for look & behavior.

- To change the site: edit `Ember & Oak.dc.html`, then **recompile** it to
  `backend/public/index.html`. The compile inlines the DC runtime + assets into one
  file. If you are outside the original design tool, the pragmatic path is to port the
  design into the project's real framework (or a plain static bundle) and output the
  result to `backend/public/index.html` — the server just serves whatever is there.
- The build that ships has `USE_BACKEND = true` and `API_BASE = ''` (same-origin).
  The design source keeps `USE_BACKEND = false` so it previews without a backend.

## API surface (backend/server.js)
- `POST /api/login` `{slug,password}` → `{token}` (studio owner)
- `POST /api/sign-upload` (auth) `{category}` → signed params, folder `<slug>/<category>`
- `GET  /api/list?category=` (auth) → studio's images+videos
- `POST /api/delete` (auth) `{publicId,resourceType}` → delete inside own folder only
- `POST /api/feature` (auth) `{publicId,category,resourceType}` → set homepage cover
- `POST /api/sign-delivery` (auth) `{code}` → signed upload into `deliveries/<code>`
- `POST /api/gallery/open` `{code,pin}` → client’s full-res list (no auth; code-gated)
- `POST /api/gallery/zip` `{code,pin}` → Cloudinary ZIP URL of all originals
- `GET  /api/health`

## Local run
```bash
cd backend
cp .env.example .env    # fill in real values
npm install
npm start               # http://localhost:3000
```

## Adding a client delivery
1. Studio signs into **Studio Admin** on the live site.
2. In **Client Deliveries**, type a code (e.g. `smith-wedding`), upload the full-res
   originals, and share the printed link `…/?gallery=smith-wedding`.
3. For a PIN or title, add an entry to `GALLERIES_JSON` and redeploy; otherwise open
   deliveries work by code alone.

## Scaling storage (if full-res delivery volume grows)
Cloudinary free tier is 25 GB storage + 25 GB/mo bandwidth. For large or frequent
full-res deliveries, either upgrade Cloudinary, or move **delivery** storage to an
object store with cheap/zero egress (Cloudflare R2, Backblaze B2) and swap the
`/api/gallery/*` handlers to presign from there — the front-end contract
(`open` → items[], `zip` → url) can stay the same. Keep the public portfolio on
Cloudinary for its transforms.

## Security checklist before going fully public
- Set `SESSION_SECRET` to a strong random value (already generated once; rotate if leaked).
- Prefer `passwordHash` over inline `password` in `CLIENTS_JSON` (`npm run hash "pw"`).
- Consider setting `ALLOWED_ORIGINS` to the real domain instead of `*`.
- Add PINs to sensitive delivery galleries via `GALLERIES_JSON`.
