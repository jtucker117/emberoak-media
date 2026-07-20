# Ember & Oak — Media Backend (Option 3a)

A tiny Express API that lets each client manage **only their own** photos & videos.
Files are stored on **your single Cloudinary account**, one folder per client. This
server holds the client logins and your secret Cloudinary key, and scopes every
upload / list / delete to the logged-in client's folder — so clients are fully
isolated from each other and never see your dashboard.

## What each client gets
- A login (`slug` + password) on the site's Studio Admin.
- Upload straight into their own folder (`<folder>/<category>`).
- A gallery list and **Delete** buttons that only ever touch their own folder.

## Deploy to Railway
1. Push this repo to GitHub (the site + this `backend/` folder).
2. In Railway: **New Project → Deploy from GitHub repo**, set the **root directory** to `backend/`.
3. Add environment variables (see `.env.example`):
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
     (find the key/secret in Cloudinary → Settings → API Keys)
   - `SESSION_SECRET` — any long random string
   - `CLIENTS_JSON` — your client list (build it as below)
   - `ALLOWED_ORIGINS` — your site's URL(s), comma-separated, or `*` while testing
4. Deploy. Railway gives you a public URL like `https://emberoak-backend.up.railway.app`.
5. Put that URL into the website's `API_BASE` (Studio Admin config) and you're live.

## Adding a client
1. Hash their password:
   ```bash
   cd backend && npm install
   npm run hash "their-password"
   ```
2. Add an entry to `CLIENTS_JSON`:
   ```json
   { "slug": "smith-family", "name": "The Smith Family", "folder": "smith-family", "passwordHash": "<hash>" }
   ```
3. Redeploy (Railway restarts automatically on a new env var).

`slug` = login name, `folder` = their private Cloudinary folder (keep them the same
for simplicity). Never reuse a folder across clients.

## Security notes
- The Cloudinary **API secret lives only here**, never in the website.
- Deletes are refused unless the target `publicId` sits inside the caller's folder.
- Login tokens expire after 12h.
- Set `ALLOWED_ORIGINS` to your real site URL before going public.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` | – | `{slug,password}` → `{token}` |
| POST | `/api/sign-upload` | ✓ | signed params for a folder-locked upload |
| GET | `/api/list?category=` | ✓ | that client's images + videos |
| POST | `/api/delete` | ✓ | delete one asset in the client's folder |
| GET | `/api/health` | – | status |
