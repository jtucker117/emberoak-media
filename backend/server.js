// Ember & Oak — per-client media backend (Option 3a)
// Storage stays on YOUR Cloudinary account; this server gates every action to
// the logged-in client's own folder, so one client can never see or touch
// another client's media. Deploy this to Railway.
//
// Endpoints:
//   POST /api/login         { slug, password }            -> { token, client }
//   POST /api/sign-upload   { category }  (auth)          -> signed params for a direct Cloudinary upload, locked to <folder>/<category>
//   GET  /api/list?category=(auth)                        -> that client's images + videos for a category
//   POST /api/delete        { publicId, resourceType }    -> deletes ONLY if publicId is inside the client's folder
//   GET  /api/health                                      -> ok
//
// Config via environment variables (set these in Railway):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//   SESSION_SECRET   long random string for signing login tokens
//   CLIENTS_JSON     JSON array of clients (see clients.example.json)
//   ALLOWED_ORIGINS  comma-separated site origins, or * (default *)

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v2 as cloudinary } from 'cloudinary';

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  SESSION_SECRET,
  CLIENTS_JSON,
  GALLERIES_JSON,
  ALLOW_OPEN_DELIVERIES = 'true',
  DELIVERIES_ROOT = 'deliveries',
  ALLOWED_ORIGINS = '*',
  PORT = 3000,
} = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET)
  console.warn('[warn] Cloudinary env vars are not fully set.');
if (!SESSION_SECRET) console.warn('[warn] SESSION_SECRET is not set — using an insecure default. Set it in Railway.');

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

const SECRET = SESSION_SECRET || 'dev-insecure-secret-change-me';

// clients: [{ slug, name, folder, passwordHash }]
let CLIENTS = [];
try { CLIENTS = JSON.parse(CLIENTS_JSON || '[]'); }
catch (e) { console.error('[error] CLIENTS_JSON is not valid JSON:', e.message); }

const findClient = (slug) => CLIENTS.find(c => c.slug === slug);

// ---- persistent credential store ------------------------------------------
// CLIENTS_JSON is the seed. When a studio changes its own password we must put
// the new hash somewhere that survives a redeploy — Railway's container disk is
// wiped every deploy, so this needs a mounted Volume (default /data).
// If no writable volume exists the app still runs; password *changes* are simply
// refused with a clear message rather than silently reverting on the next deploy.
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || '/data/credentials.json';
let OVERRIDES = {}; // slug -> { passwordHash, updatedAt }
try {
  OVERRIDES = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) || {};
  console.log(`[info] loaded ${Object.keys(OVERRIDES).length} stored credential(s) from ${CREDENTIALS_PATH}`);
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[warn] could not read credential store:', e.message);
}
// Writable is not enough: the container's own disk is writable too, and a password
// saved there would silently vanish on the next deploy. A real Railway Volume is a
// separate mount, so it reports a different device id than "/". Anything on the same
// device as root is treated as "no store" rather than accepted and later lost.
function credStoreWritable() {
  const dir = path.dirname(CREDENTIALS_PATH);
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    if (st.dev === fs.statSync('/').dev) return false; // ephemeral container disk
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) { return false; }   // ENOENT = no volume mounted
}
function saveOverrides() {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(OVERRIDES, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_PATH); // atomic: never leave a half-written file
}
// the hash actually in force for a client — stored override wins over CLIENTS_JSON
async function verifyPassword(client, password) {
  if (!client || !password) return false;
  const ov = OVERRIDES[client.slug];
  if (ov && ov.passwordHash) return bcrypt.compare(String(password), ov.passwordHash);
  if (client.passwordHash) return bcrypt.compare(String(password), client.passwordHash);
  if (client.password) return String(password) === String(client.password);
  return false;
}
// every client is confined to its own top-level folder; default to the slug
const folderOf = (c) => (c.folder || c.slug).replace(/^\/+|\/+$/g, '');
const SAFE = /^[a-z0-9_-]+$/i; // category / slug / gallery-code charset

// ---- client-delivery galleries (full-res download for the studio's clients) ----
let GALLERIES = [];
try { GALLERIES = JSON.parse(GALLERIES_JSON || '[]'); }
catch (e) { console.error('[error] GALLERIES_JSON is not valid JSON:', e.message); }
const DROOT = String(DELIVERIES_ROOT).replace(/^\/+|\/+$/g, '');
const OPEN_DELIVERIES = String(ALLOW_OPEN_DELIVERIES) === 'true';
// resolve a gallery by its share code. Configured galleries can carry a pin/title/expiry.
// If ALLOW_OPEN_DELIVERIES, any folder <DROOT>/<code> is reachable by its code (no pin).
function resolveGallery(code) {
  if (!code || !SAFE.test(code)) return null;
  const g = GALLERIES.find(x => x.code === code);
  if (g) return { code, title: g.title || code, pin: g.pin || null, folder: (g.folder || `${DROOT}/${code}`).replace(/^\/+|\/+$/g, ''), expires: g.expires || null };
  if (OPEN_DELIVERIES) return { code, title: code, pin: null, folder: `${DROOT}/${code}`, expires: null };
  return null;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: ALLOWED_ORIGINS === '*' ? true : ALLOWED_ORIGINS.split(',').map(s => s.trim()) }));

// serve the built website (backend/public/) so one Railway service hosts site + API
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

// ---- auth ----
app.post('/api/login', async (req, res) => {
  const { slug, password } = req.body || {};
  const client = findClient(slug);
  if (!client || !password) return res.status(401).json({ error: 'Invalid login' });
  // a stored (self-service changed) hash wins; otherwise fall back to CLIENTS_JSON
  const ok = await verifyPassword(client, password);
  if (!ok) return res.status(401).json({ error: 'Invalid login' });
  const token = jwt.sign({ slug: client.slug, folder: folderOf(client) }, SECRET, { expiresIn: '12h' });
  res.json({ token, client: { slug: client.slug, name: client.name || client.slug } });
});

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  try { req.client = jwt.verify(t, SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Not authenticated' }); }
}

// ---- who am I (profile header + whether password changes can persist) ----
app.get('/api/me', auth, (req, res) => {
  const client = findClient(req.client.slug) || {};
  const ov = OVERRIDES[req.client.slug];
  res.json({
    slug: req.client.slug,
    name: client.name || req.client.slug,
    folder: req.client.folder,
    canChangePassword: credStoreWritable(),
    passwordUpdatedAt: (ov && ov.updatedAt) || null,
  });
});

// ---- change your own password (persisted to the mounted volume) ----
app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const client = findClient(req.client.slug);
  if (!client) return res.status(401).json({ error: 'Unknown account' });
  if (!(await verifyPassword(client, currentPassword)))
    return res.status(401).json({ error: 'Current password is incorrect' });
  const pw = String(newPassword || '');
  if (pw.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters' });
  if (pw === String(currentPassword)) return res.status(400).json({ error: 'New password must be different' });
  if (!credStoreWritable())
    return res.status(503).json({ error: 'Password storage is not set up. Add a Railway Volume mounted at /data, then try again.' });
  try {
    OVERRIDES[client.slug] = { passwordHash: await bcrypt.hash(pw, 12), updatedAt: new Date().toISOString() };
    saveOverrides();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not save the new password', detail: String(e.message || e) });
  }
});

// ---- signed, folder-locked upload ----
app.post('/api/sign-upload', auth, (req, res) => {
  const category = String((req.body && req.body.category) || 'gallery');
  if (!SAFE.test(category)) return res.status(400).json({ error: 'Bad category' });
  const folder = `${req.client.folder}/${category}`;
  const timestamp = Math.round(Date.now() / 1000);
  // sign exactly the params the browser will send; tag with slug+category for listing
  const params = { folder, tags: `${req.client.slug},${category},${req.client.slug}__${category}`, timestamp };
  const signature = cloudinary.utils.api_sign_request(params, CLOUDINARY_API_SECRET);
  res.json({ cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, signature, folder, tags: params.tags });
});

// ---- list (scoped to the client's folder) ----
app.get('/api/list', auth, async (req, res) => {
  const category = String(req.query.category || '');
  if (category && !SAFE.test(category)) return res.status(400).json({ error: 'Bad category' });
  const prefix = category ? `${req.client.folder}/${category}` : `${req.client.folder}/`;
  try {
    const [imgs, vids] = await Promise.all([
      cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix, max_results: 500 }).catch(() => ({ resources: [] })),
      cloudinary.api.resources({ type: 'upload', resource_type: 'video', prefix, max_results: 500 }).catch(() => ({ resources: [] })),
    ]);
    const map = (r, isVideo) => ({
      publicId: r.public_id,
      resourceType: isVideo ? 'video' : 'image',
      isVideo,
      thumb: isVideo
        ? cloudinary.url(r.public_id, { resource_type: 'video', transformation: [{ width: 700, height: 875, crop: 'fill', quality: 'auto', start_offset: '0' }], format: 'jpg' })
        : cloudinary.url(r.public_id, { transformation: [{ width: 700, crop: 'fill', quality: 'auto', fetch_format: 'auto' }] }),
      full: isVideo
        ? cloudinary.url(r.public_id, { resource_type: 'video', transformation: [{ quality: 'auto' }], format: 'mp4' })
        : cloudinary.url(r.public_id, { transformation: [{ width: 1600, quality: 'auto', fetch_format: 'auto' }] }),
      createdAt: r.created_at,
    });
    const items = [
      ...(imgs.resources || []).map(r => map(r, false)),
      ...(vids.resources || []).map(r => map(r, true)),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'List failed', detail: String(e.message || e) });
  }
});

// ---- delete (only inside the client's folder) ----
app.post('/api/delete', auth, async (req, res) => {
  const { publicId, resourceType } = req.body || {};
  if (!publicId) return res.status(400).json({ error: 'Missing publicId' });
  // hard guard: the id MUST live under this client's folder
  if (!String(publicId).startsWith(`${req.client.folder}/`))
    return res.status(403).json({ error: 'Not allowed for this client' });
  try {
    const rt = resourceType === 'video' ? 'video' : 'image';
    const out = await cloudinary.uploader.destroy(publicId, { resource_type: rt, invalidate: true });
    if (out.result !== 'ok' && out.result !== 'not found') return res.status(400).json({ error: out.result });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', detail: String(e.message || e) });
  }
});

// ---- set the featured/cover asset for a category (folder-scoped) ----
app.post('/api/feature', auth, async (req, res) => {
  const { publicId, category, resourceType } = req.body || {};
  if (!publicId || !category) return res.status(400).json({ error: 'Missing publicId or category' });
  if (!SAFE.test(category)) return res.status(400).json({ error: 'Bad category' });
  if (!String(publicId).startsWith(`${req.client.folder}/`))
    return res.status(403).json({ error: 'Not allowed for this client' });
  const rt = resourceType === 'video' ? 'video' : 'image';
  const coverTag = `${req.client.slug}__${category}_cover`;
  try {
    // remove the cover tag from any asset that currently has it, then set it on the chosen one
    const cur = await cloudinary.api.resources_by_tag(coverTag, { resource_type: rt, max_results: 100 }).catch(() => ({ resources: [] }));
    const ids = (cur.resources || []).map(r => r.public_id).filter(id => id !== publicId);
    if (ids.length) await cloudinary.uploader.remove_tag(coverTag, ids, { resource_type: rt }).catch(() => {});
    await cloudinary.uploader.add_tag(coverTag, [publicId], { resource_type: rt });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Feature failed', detail: String(e.message || e) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, clients: CLIENTS.length, credentialStore: credStoreWritable() ? 'writable' : 'unavailable' }));

// ============================================================================
//  CLIENT DELIVERIES — full-resolution galleries the studio hands to a client.
//  The client needs no account: they open with a share code (+ optional pin),
//  view every full-res photo, download any one, or download ALL as a ZIP.
// ============================================================================

// Owner posts a delivery: signed upload straight into deliveries/<code> (auth = studio).
app.post('/api/sign-delivery', auth, (req, res) => {
  const code = String((req.body && req.body.code) || '');
  if (!SAFE.test(code)) return res.status(400).json({ error: 'Bad gallery code' });
  const folder = `${DROOT}/${code}`;
  const timestamp = Math.round(Date.now() / 1000);
  const params = { folder, tags: `delivery,${code}`, timestamp };
  // optional auto-expiry: stored as context on every asset; the sweep deletes past it
  const expires = req.body && req.body.expires ? String(req.body.expires) : '';
  if (expires && !isNaN(new Date(expires).getTime())) params.context = `expires=${new Date(expires).toISOString()}`;
  const signature = cloudinary.utils.api_sign_request(params, CLOUDINARY_API_SECRET);
  res.json({ cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, signature, folder, tags: params.tags, context: params.context || '' });
});

// Client opens a delivery gallery by code (+ pin if the gallery has one).
app.post('/api/gallery/open', async (req, res) => {
  const { code, pin } = req.body || {};
  const g = resolveGallery(String(code || '').trim());
  if (!g) return res.status(404).json({ error: 'Gallery not found' });
  if (g.expires && Date.now() > new Date(g.expires).getTime()) return res.status(410).json({ error: 'This gallery has expired' });
  if (g.pin && String(pin || '') !== String(g.pin)) return res.status(401).json({ error: 'Wrong access code' });
  try {
    const [imgs, vids] = await Promise.all([
      cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix: g.folder, max_results: 500, context: true }).catch(() => ({ resources: [] })),
      cloudinary.api.resources({ type: 'upload', resource_type: 'video', prefix: g.folder, max_results: 500, context: true }).catch(() => ({ resources: [] })),
    ]);
    // auto-expiry: if any asset carries an expired "expires" context, the album is gone
    const allRes = [...(imgs.resources || []), ...(vids.resources || [])];
    const expCtx = allRes.map(r => r.context && r.context.custom && r.context.custom.expires).find(Boolean);
    if (expCtx && Date.now() > new Date(expCtx).getTime()) {
      deleteFolder(g.folder).catch(() => {});
      return res.status(410).json({ error: 'This gallery has expired and is no longer available' });
    }
    const nameOf = (pid) => pid.split('/').pop();
    const map = (r, isVideo) => ({
      publicId: r.public_id,
      isVideo,
      filename: nameOf(r.public_id) + '.' + r.format,
      // preview keeps bandwidth low; download link forces the FULL-RES original
      thumb: cloudinary.url(r.public_id, { resource_type: isVideo ? 'video' : 'image', transformation: [{ width: 600, crop: 'limit', quality: 'auto', fetch_format: isVideo ? undefined : 'auto' }], format: isVideo ? 'jpg' : undefined, start_offset: isVideo ? '0' : undefined }),
      download: cloudinary.url(r.public_id, { resource_type: isVideo ? 'video' : 'image', flags: 'attachment' }),
    });
    const items = [
      ...(imgs.resources || []).map(r => map(r, false)),
      ...(vids.resources || []).map(r => map(r, true)),
    ];
    if (!items.length) return res.status(404).json({ error: 'This gallery has no photos yet' });
    res.json({ title: g.title, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: 'Could not open gallery', detail: String(e.message || e) });
  }
});

// One-click ZIP of every full-res image in the gallery (Cloudinary builds it on the fly).
app.post('/api/gallery/zip', async (req, res) => {
  const { code, pin } = req.body || {};
  const g = resolveGallery(String(code || '').trim());
  if (!g) return res.status(404).json({ error: 'Gallery not found' });
  if (g.pin && String(pin || '') !== String(g.pin)) return res.status(401).json({ error: 'Wrong access code' });
  try {
    const url = cloudinary.utils.download_zip_url({
      resource_type: 'image',
      prefixes: [g.folder],
      use_original_filename: true,
      target_public_id: g.code,
    });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'Could not build ZIP', detail: String(e.message || e) });
  }
});

// SPA fallback: any non-API route serves the site.
app.get(/^(?!\/api).+/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// delete every asset (image + video) under a folder prefix
async function deleteFolder(folder) {
  for (const rt of ['image', 'video']) {
    await cloudinary.api.delete_resources_by_prefix(folder, { resource_type: rt }).catch(() => {});
  }
  await cloudinary.api.delete_folder(folder).catch(() => {});
}

// hourly sweep: permanently delete any delivery asset past its "expires" date
async function sweepExpired() {
  const now = Date.now();
  for (const rt of ['image', 'video']) {
    try {
      const r = await cloudinary.api.resources_by_tag('delivery', { context: true, max_results: 500, resource_type: rt });
      for (const res of (r.resources || [])) {
        const exp = res.context && res.context.custom && res.context.custom.expires;
        if (exp && now > new Date(exp).getTime())
          await cloudinary.uploader.destroy(res.public_id, { resource_type: rt, invalidate: true }).catch(() => {});
      }
    } catch (e) {}
  }
}
setInterval(sweepExpired, 60 * 60 * 1000);
sweepExpired();

app.listen(PORT, () => console.log(`Ember & Oak media backend listening on ${PORT}`));
