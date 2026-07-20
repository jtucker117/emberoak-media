# Studio Site — Starter Kit

A rebrandable version of the Ember & Oak photography site: public portfolio, filterable
galleries with lightbox + video, About, Services & Pricing, Contact, Studio Admin
(upload / delete / featured covers), and Client Access (full-resolution client
deliveries with one-click ZIP download and optional auto-expiry).

## What's here
- `Studio-Site-Starter.dc.html` — the site source with branding stripped to
  `[placeholders]`.
- `ONBOARDING_QUESTIONNAIRE.md` — everything to collect from a new photographer.
- `CUSTOMIZE.md` — exactly what to change to make the site theirs.

## How to use it
1. Have the photographer fill out `ONBOARDING_QUESTIONNAIRE.md`.
2. Follow `CUSTOMIZE.md` to drop in their brand, copy, categories, colors, and accounts.
3. Reuse the same `backend/` from the main project (it's generic) — deploy it to their
   own Railway + Cloudinary. See the project root `README.md` and `CLAUDE.md`.

Each photographer ends up with their own repo, Railway service, and Cloudinary account,
so their media and clients are fully isolated from everyone else's.
