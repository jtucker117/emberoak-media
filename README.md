# Ember & Oak — Website + Media Backend

A warm, editorial photography/video site for **Ember & Oak** (Houston area) with a
built-in, self-service media system. One Railway service hosts **both** the website
and its API. Storage lives on **Cloudinary**.

## What it does
- **Public site** — Home, Portfolio (filterable, lightbox, video support), About,
  Services & Pricing, Contact, Client Access.
- **Studio Admin** (footer link) — the studio logs in to upload/delete portfolio
  photos & videos, pick featured covers, set the Cover and About photos, and post
  **client delivery galleries**.
- **Client Access** — a client opens their private gallery by share code and
  downloads any full-resolution file or the **entire set as a ZIP** — no account.
- **Isolation** — every studio/client action is scoped to its own Cloudinary folder,
  so clients can never see each other's media.

## Repo layout
```
backend/
  server.js              Express API + serves the built site from public/
  public/index.html      The compiled, self-contained website (built artifact)
  package.json           Node deps + start script
  .env.example           All environment variables, documented
  clients.example.json   Example studio-owner login list
  hash-password.js       Generate a bcrypt hash for a login
Ember & Oak.dc.html      The website SOURCE (edit this, then rebuild — see below)
assets/                  Logo + icon used by the source
```

## Deploy (GitHub → Railway)
1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
3. **Settings → Root Directory** = `backend`.
4. **Variables** — copy from `backend/.env.example` and fill in:
   - `CLOUDINARY_CLOUD_NAME` = `wrjc0nyq`
   - `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (Cloudinary → Settings → API Keys)
   - `SESSION_SECRET` = a long random string
   - `CLIENTS_JSON` = the studio login(s)
   - `GALLERIES_JSON` / `ALLOW_OPEN_DELIVERIES` (client deliveries)
   - `ALLOWED_ORIGINS` = `*` (fine, since the API serves the site itself)
5. Deploy. Open the Railway URL — the site is live and Studio Admin/Client Access work.

Because the API serves the site from the same origin, the website's `API_BASE` is
empty and `USE_BACKEND` is `true` in the compiled `public/index.html`. Nothing else
to configure.

## Editing the site later
`backend/public/index.html` is a **compiled artifact** — do not hand-edit it. Edit the
source `Ember & Oak.dc.html`, then rebuild it into `backend/public/index.html`
(see `CLAUDE.md` for the exact rebuild step). The design was authored in an HTML
design tool; `CLAUDE.md` explains how a developer using Claude Code should treat it.

## Cloudinary notes
- Free tier = 25 GB storage + 25 GB/month bandwidth. Fine for portfolios and modest
  deliveries. For heavy full-res delivery volume, see `CLAUDE.md` → “Scaling storage”.
- Under Cloudinary **Settings → Security**, keep **“Resource list”** unchecked so the
  public galleries can enumerate images.
