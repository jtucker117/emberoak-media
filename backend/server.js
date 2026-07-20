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
// ---- per-gallery settings the studio can edit without a redeploy ----------
// Same persistence rules as credentials: needs a real mounted volume, otherwise
// a PIN set here would quietly disappear on the next deploy.
const GALLERY_SETTINGS_PATH = process.env.GALLERY_SETTINGS_PATH || '/data/galleries.json';
let GSTORE = {};  // code -> { pin, title, updatedAt }
try {
  GSTORE = JSON.parse(fs.readFileSync(GALLERY_SETTINGS_PATH, 'utf8')) || {};
  console.log(`[info] loaded settings for ${Object.keys(GSTORE).length} gallery(ies)`);
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[warn] could not read gallery settings:', e.message);
}
function saveGalleryStore() {
  fs.mkdirSync(path.dirname(GALLERY_SETTINGS_PATH), { recursive: true });
  const tmp = `${GALLERY_SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(GSTORE, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, GALLERY_SETTINGS_PATH);
}

// ---- manual photo order -----------------------------------------------------
// Cloudinary lists by upload date. A studio wants to choose what leads a gallery,
// so we keep an explicit publicId order per category; anything not listed falls in
// after, oldest first, which means new uploads simply append.
const ORDER_PATH = process.env.ORDER_PATH || '/data/order.json';
let ORDER = {};   // category -> [publicId, ...]
try {
  ORDER = JSON.parse(fs.readFileSync(ORDER_PATH, 'utf8')) || {};
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[warn] could not read photo order:', e.message);
}
function saveOrder() {
  fs.mkdirSync(path.dirname(ORDER_PATH), { recursive: true });
  const tmp = `${ORDER_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ORDER, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ORDER_PATH);
}
function applyOrder(category, items) {
  const want = ORDER[category];
  if (!want || !want.length) return items;
  const pos = {};
  want.forEach((id, i) => { pos[id] = i; });
  return items.slice().sort((a, b) => {
    const pa = pos[a.publicId], pb = pos[b.publicId];
    if (pa == null && pb == null) return new Date(a.createdAt) - new Date(b.createdAt);
    if (pa == null) return 1;      // unranked (newly uploaded) sinks below ranked
    if (pb == null) return -1;
    return pa - pb;
  });
}

// ---- portfolio categories (studio-editable) --------------------------------
// Categories used to be hardcoded in the site source, so adding one meant a code
// change and a rebuild. They live here now; the site reads them at load.
const CATEGORIES_PATH = process.env.CATEGORIES_PATH || '/data/categories.json';
const DEFAULT_CATEGORIES = [
  { key: 'newborn', label: 'Newborn' },
  { key: 'family', label: 'Family' },
  { key: 'events', label: 'Events' },
  { key: 'cinematic', label: 'Cinematic' },
  { key: 'drone', label: 'Drone' },
  { key: 'video', label: 'Video / Reels' },
  { key: 'social', label: 'Social Reels' },
];
let CATEGORIES = null;
try {
  const parsed = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8'));
  if (Array.isArray(parsed) && parsed.length) CATEGORIES = parsed;
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[warn] could not read categories:', e.message);
}
if (!CATEGORIES) CATEGORIES = DEFAULT_CATEGORIES.slice();
function saveCategories() {
  fs.mkdirSync(path.dirname(CATEGORIES_PATH), { recursive: true });
  const tmp = `${CATEGORIES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(CATEGORIES, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CATEGORIES_PATH);
}
// 'hero' and 'about' are the homepage cover and About photo, not portfolio
// categories — a studio must not be able to create or delete them by name.
const RESERVED_CATEGORIES = ['hero', 'about'];

// ---- embedded video links (YouTube / Vimeo) -------------------------------
// Video is the one media type that does NOT belong in Cloudinary here: the free
// plan caps a video at 100 MB, and even under that a single film would drain the
// monthly bandwidth quota and take the photos down with it. So long-form video is
// embedded from a host built for streaming, and we only store the link.
const VIDEOS_PATH = process.env.VIDEOS_PATH || '/data/videos.json';
let VIDEOS = [];   // [{ id, provider, videoId, url, title, category, thumb, addedAt }]
try {
  VIDEOS = JSON.parse(fs.readFileSync(VIDEOS_PATH, 'utf8')) || [];
  console.log(`[info] loaded ${VIDEOS.length} embedded video link(s)`);
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[warn] could not read video links:', e.message);
}
function saveVideos() {
  fs.mkdirSync(path.dirname(VIDEOS_PATH), { recursive: true });
  const tmp = `${VIDEOS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(VIDEOS, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, VIDEOS_PATH);
}
// accepts watch?v=, youtu.be/, /embed/, /shorts/, /live/, and vimeo.com/<id>
function parseVideoUrl(u) {
  const s = String(u || '').trim();
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (m) return { provider: 'youtube', videoId: m[1] };
  m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { provider: 'vimeo', videoId: m[1] };
  return null;
}
// oEmbed gives the real title (and Vimeo's thumbnail) with no API key.
async function fetchOEmbed(provider, videoId) {
  const url = provider === 'vimeo'
    ? `https://vimeo.com/api/oembed.json?url=https://vimeo.com/${videoId}`
    : `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Videos added before titles were resolved show their raw id. Fill those in once,
// at boot, rather than making every page load pay for it.
async function backfillVideoTitles() {
  const missing = VIDEOS.filter(v => !v.title);
  if (!missing.length) return;
  for (const v of missing) {
    const j = await fetchOEmbed(v.provider, v.videoId);
    if (j && j.title) v.title = String(j.title).slice(0, 120);
    if (j && j.thumbnail_url && !v.thumb) v.thumb = j.thumbnail_url;
  }
  try { saveVideos(); console.log(`[info] backfilled ${missing.length} video title(s)`); } catch (e) {}
}

const embedUrlFor = (v) => v.provider === 'vimeo'
  ? `https://player.vimeo.com/video/${v.videoId}`
  : `https://www.youtube-nocookie.com/embed/${v.videoId}`;   // no-cookie: fewer trackers on the client's site

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
  // a PIN/title set from Studio Admin outranks the env config
  const st = GSTORE[code];
  if (st) return { code, title: st.title || code, pin: st.pin || null, folder: `${DROOT}/${code}`, expires: st.expires || null, watermark: !!st.watermark, downloads: st.downloads !== false };
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
  // 12h meant a studio that signed in at night was locked out by lunchtime, with
  // the UI still looking signed in. A week is plenty for a single-owner admin,
  // and Sign out revokes it immediately on that device.
  const token = jwt.sign({ slug: client.slug, folder: folderOf(client) }, SECRET, { expiresIn: '7d' });
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
  // use_filename keeps the studio's original name; unique_filename appends a short
  // suffix so two files called IMG_1001.jpg can't overwrite each other.
  const params = { folder, tags: `${req.client.slug},${category},${req.client.slug}__${category}`, timestamp,
    unique_filename: 'true', use_filename: 'true' };
  const signature = cloudinary.utils.api_sign_request(params, CLOUDINARY_API_SECRET);
  res.json({ cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, signature, folder, tags: params.tags,
    useFilename: 'true', uniqueFilename: 'true' });
});

// ---- list (scoped to the client's folder) ----
app.get('/api/list', auth, async (req, res) => {
  const category = String(req.query.category || '');
  if (category && !SAFE.test(category)) return res.status(400).json({ error: 'Bad category' });
  const prefix = category ? `${req.client.folder}/${category}` : `${req.client.folder}/`;
  try {
    const [imgs, vids] = await Promise.all([
      cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix, max_results: 500, tags: true }).catch(() => ({ resources: [] })),
      cloudinary.api.resources({ type: 'upload', resource_type: 'video', prefix, max_results: 500, tags: true }).catch(() => ({ resources: [] })),
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
      tags: r.tags || [],
    });
    const items = applyOrder(category, [
      ...(imgs.resources || []).map(r => map(r, false)),
      ...(vids.resources || []).map(r => map(r, true)),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));
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
  const { publicId, category, resourceType, clear } = req.body || {};
  if (!category) return res.status(400).json({ error: 'Missing category' });
  if (!SAFE.test(category)) return res.status(400).json({ error: 'Bad category' });
  if (!clear) {
    if (!publicId) return res.status(400).json({ error: 'Missing publicId' });
    if (!String(publicId).startsWith(`${req.client.folder}/`))
      return res.status(403).json({ error: 'Not allowed for this client' });
  }
  const coverTag = `${req.client.slug}__${category}_cover`;
  try {
    // Clear the cover tag from BOTH resource types — the old code only cleared the
    // type being set, so switching an image cover while a video held the tag left
    // two covers and the wrong one could win.
    for (const rt of ['image', 'video']) {
      const cur = await cloudinary.api.resources_by_tag(coverTag, { resource_type: rt, max_results: 100 }).catch(() => ({ resources: [] }));
      const ids = (cur.resources || []).map(r => r.public_id).filter(id => id !== publicId);
      if (ids.length) await cloudinary.uploader.remove_tag(coverTag, ids, { resource_type: rt }).catch(() => {});
    }
    if (clear) {
      // toggling the current cover off: strip it from the chosen asset too
      const rt = resourceType === 'video' ? 'video' : 'image';
      if (publicId) await cloudinary.uploader.remove_tag(coverTag, [publicId], { resource_type: rt }).catch(() => {});
      return res.json({ ok: true, cleared: true });
    }
    const rt = resourceType === 'video' ? 'video' : 'image';
    await cloudinary.uploader.add_tag(coverTag, [publicId], { resource_type: rt });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Feature failed', detail: String(e.message || e) });
  }
});

// ---- promote an existing photo to the Cover / About slot ----
// Copies it into <folder>/hero (or /about) rather than moving or re-tagging it:
//   - moving would pull it out of its category
//   - tagging alone would not work, because the admin lists by folder prefix
// The duplicate is what the homepage reads, and the original stays put.
app.post('/api/use-as', auth, async (req, res) => {
  const { publicId, target } = req.body || {};
  const slot = target === 'about' ? 'about' : 'hero';
  if (!publicId) return res.status(400).json({ error: 'Missing publicId' });
  if (!String(publicId).startsWith(`${req.client.folder}/`))
    return res.status(403).json({ error: 'Not allowed for this client' });
  try {
    const src = cloudinary.url(publicId, { secure: true });   // the stored original
    const out = await cloudinary.uploader.upload(src, {
      folder: `${req.client.folder}/${slot}`,
      tags: [req.client.slug, slot, `${req.client.slug}__${slot}`],
      use_filename: true,
      unique_filename: true,
    });
    res.json({ ok: true, publicId: out.public_id, slot });
  } catch (e) {
    res.status(500).json({ error: `Could not set the ${slot} photo`, detail: String(e.message || e) });
  }
});

// ---- repair: give every asset in the studio's folder the tag the site lists by ----
// Assets uploaded before SITE_SLUG was set only carry the bare category tag, so the
// gallery cannot see them. This re-tags them in place; it never deletes anything.
app.post('/api/retag', auth, async (req, res) => {
  const slug = req.client.slug, folder = req.client.folder;
  const tagged = {};
  try {
    for (const rt of ['image', 'video']) {
      const r = await cloudinary.api.resources({ type: 'upload', resource_type: rt, prefix: `${folder}/`, max_results: 500 })
        .catch(() => ({ resources: [] }));
      for (const a of (r.resources || [])) {
        const parts = String(a.public_id).split('/');   // <folder>/<category>/<name>
        const category = parts.length >= 3 ? parts[1] : '';
        if (!category || !SAFE.test(category)) continue;
        await cloudinary.uploader.add_tag(`${slug}__${category}`, [a.public_id], { resource_type: rt }).catch(() => {});
        tagged[category] = (tagged[category] || 0) + 1;
      }
    }
    res.json({ ok: true, tagged });
  } catch (e) {
    res.status(500).json({ error: 'Retag failed', detail: String(e.message || e) });
  }
});

// ---- photo order: public read (the site needs it), studio-only write ----
app.get('/api/order', (_req, res) => res.json({ order: ORDER }));

app.post('/api/order', auth, (req, res) => {
  const { category, publicIds } = req.body || {};
  const cat = String(category || '');
  if (!SAFE.test(cat)) return res.status(400).json({ error: 'Bad category' });
  if (!Array.isArray(publicIds)) return res.status(400).json({ error: 'publicIds must be a list' });
  // only ids inside this studio's folder may be ordered
  const clean = publicIds.filter(id => typeof id === 'string' && id.startsWith(`${req.client.folder}/`)).slice(0, 500);
  if (!credStoreWritable())
    return res.status(503).json({ error: 'Ordering needs storage. Add a Railway Volume mounted at /data.' });
  try {
    ORDER[cat] = clean;
    saveOrder();
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not save the order', detail: String(e.message || e) });
  }
});

// ---- categories: public list, studio-only add/rename/delete ----
app.get('/api/categories', (_req, res) => res.json({ items: CATEGORIES }));

app.post('/api/categories', auth, (req, res) => {
  const label = String((req.body && req.body.label) || '').trim();
  if (!label) return res.status(400).json({ error: 'Give the category a name' });
  // derive a safe key from the label so the studio never has to think about slugs
  let key = String((req.body && req.body.key) || label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!key || !SAFE.test(key)) return res.status(400).json({ error: 'Use letters or numbers in the name' });
  if (RESERVED_CATEGORIES.indexOf(key) !== -1) return res.status(400).json({ error: `"${key}" is reserved` });
  if (CATEGORIES.some(c => c.key === key)) return res.status(409).json({ error: 'That category already exists' });
  if (CATEGORIES.length >= 20) return res.status(400).json({ error: 'That is the maximum number of categories' });
  if (!credStoreWritable())
    return res.status(503).json({ error: 'Categories need storage. Add a Railway Volume mounted at /data.' });
  try {
    CATEGORIES.push({ key, label: label.slice(0, 40) });
    saveCategories();
    res.json({ ok: true, items: CATEGORIES });
  } catch (e) {
    CATEGORIES = CATEGORIES.filter(c => c.key !== key);
    res.status(500).json({ error: 'Could not save', detail: String(e.message || e) });
  }
});

app.post('/api/categories/rename', auth, (req, res) => {
  const { key, label } = req.body || {};
  const c = CATEGORIES.find(x => x.key === String(key || ''));
  if (!c) return res.status(404).json({ error: 'No such category' });
  const l = String(label || '').trim();
  if (!l) return res.status(400).json({ error: 'Give the category a name' });
  if (!credStoreWritable()) return res.status(503).json({ error: 'Categories need storage. Add a Railway Volume mounted at /data.' });
  // only the display label changes — the key is baked into every asset's tags
  c.label = l.slice(0, 40);
  try { saveCategories(); res.json({ ok: true, items: CATEGORIES }); }
  catch (e) { res.status(500).json({ error: 'Could not save', detail: String(e.message || e) }); }
});

app.post('/api/categories/delete', auth, async (req, res) => {
  const key = String((req.body && req.body.key) || '');
  if (!CATEGORIES.some(c => c.key === key)) return res.status(404).json({ error: 'No such category' });
  if (CATEGORIES.length <= 1) return res.status(400).json({ error: 'Keep at least one category' });
  if (!credStoreWritable()) return res.status(503).json({ error: 'Categories need storage. Add a Railway Volume mounted at /data.' });
  // Refuse while it still holds media. Removing the category would leave those
  // files in Cloudinary but invisible everywhere — storage you pay for and cannot
  // see. Make the studio empty it first, deliberately.
  try {
    const prefix = `${req.client.folder}/${key}/`;
    let count = 0;
    for (const rt of ['image', 'video']) {
      const r = await cloudinary.api.resources({ type: 'upload', resource_type: rt, prefix, max_results: 500 }).catch(() => ({ resources: [] }));
      count += (r.resources || []).length;
    }
    const vids = VIDEOS.filter(v => v.category === key).length;
    if (count || vids) {
      return res.status(409).json({
        error: `"${key}" still has ${count} file(s)${vids ? ` and ${vids} video link(s)` : ''}. Delete those first, then remove the category.`,
        count, videos: vids,
      });
    }
    CATEGORIES = CATEGORIES.filter(c => c.key !== key);
    saveCategories();
    res.json({ ok: true, items: CATEGORIES });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete', detail: String(e.message || e) });
  }
});

// ---- embedded videos: public list, studio-only add/remove ----
app.get('/api/videos', (_req, res) => {
  res.json({ items: VIDEOS.map(v => ({ ...v, embedUrl: embedUrlFor(v) })) });
});

app.post('/api/videos', auth, async (req, res) => {
  const { url, category, title } = req.body || {};
  const parsed = parseVideoUrl(url);
  if (!parsed) {
    // a channel/handle link is the most likely mistake — say so instead of "invalid"
    const isChannel = /youtube\.com\/(@|c\/|channel\/|user\/)/i.test(String(url || ''));
    return res.status(400).json({ error: isChannel
      ? 'That is a channel link. Open the individual video on YouTube, then Share \u2192 Copy link and paste that.'
      : 'Paste a YouTube or Vimeo video link (e.g. https://youtu.be/abc123)' });
  }
  const cat = String(category || 'video');
  if (!SAFE.test(cat)) return res.status(400).json({ error: 'Bad category' });
  if (!credStoreWritable())
    return res.status(503).json({ error: 'Video links need storage. Add a Railway Volume mounted at /data, then try again.' });
  const id = `${parsed.provider}:${parsed.videoId}`;
  if (VIDEOS.some(v => v.id === id)) return res.status(409).json({ error: 'That video is already in the portfolio' });

  let thumb = parsed.provider === 'youtube'
    ? `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`   // hqdefault always exists; maxres often 404s
    : '';
  let name = String(title || '').slice(0, 120);
  // ask oEmbed for the real title (and Vimeo's thumbnail, which isn't derivable)
  const meta = await fetchOEmbed(parsed.provider, parsed.videoId);
  if (meta) {
    if (!name && meta.title) name = String(meta.title).slice(0, 120);
    if (!thumb && meta.thumbnail_url) thumb = meta.thumbnail_url;
  }
  const item = { id, provider: parsed.provider, videoId: parsed.videoId, url: String(url).trim(), title: name, category: cat, thumb, addedAt: new Date().toISOString() };
  try {
    VIDEOS.push(item);
    saveVideos();
    res.json({ ok: true, item: { ...item, embedUrl: embedUrlFor(item) } });
  } catch (e) {
    VIDEOS = VIDEOS.filter(v => v.id !== id);
    res.status(500).json({ error: 'Could not save that link', detail: String(e.message || e) });
  }
});

app.post('/api/videos/update', auth, (req, res) => {
  const { id, title, category, featured } = req.body || {};
  const v = VIDEOS.find(x => x.id === String(id || ''));
  if (!v) return res.status(404).json({ error: 'No such video' });
  if (featured != null) {
    // one cover per category: clear the flag from that category's other videos
    if (featured) VIDEOS.forEach(x => { if (x.category === (category || v.category) && x.id !== v.id) x.featured = false; });
    v.featured = !!featured;
  }
  if (category != null) {
    const cat = String(category);
    if (!SAFE.test(cat)) return res.status(400).json({ error: 'Bad category' });
    v.category = cat;
  }
  if (title != null) v.title = String(title).slice(0, 120);
  try { saveVideos(); res.json({ ok: true, item: { ...v, embedUrl: embedUrlFor(v) } }); }
  catch (e) { res.status(500).json({ error: 'Could not save', detail: String(e.message || e) }); }
});

app.post('/api/videos/delete', auth, (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const before = VIDEOS.length;
  VIDEOS = VIDEOS.filter(v => v.id !== id);
  if (VIDEOS.length === before) return res.status(404).json({ error: 'No such video' });
  try { saveVideos(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Could not save', detail: String(e.message || e) }); }
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
  const params = { folder, tags: `delivery,${code}`, timestamp, unique_filename: 'true', use_filename: 'true' };
  // optional auto-expiry: stored as context on every asset; the sweep deletes past it
  const expires = req.body && req.body.expires ? String(req.body.expires) : '';
  if (expires && !isNaN(new Date(expires).getTime())) params.context = `expires=${new Date(expires).toISOString()}`;
  const signature = cloudinary.utils.api_sign_request(params, CLOUDINARY_API_SECRET);
  res.json({ cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, signature, folder, tags: params.tags, context: params.context || '',
    useFilename: 'true', uniqueFilename: 'true' });
});

// Studio: list every delivery gallery that exists, with counts + share codes.
app.get('/api/deliveries', auth, async (req, res) => {
  const byCode = {};
  try {
    for (const rt of ['image', 'video']) {
      const r = await cloudinary.api.resources({ type: 'upload', resource_type: rt, prefix: `${DROOT}/`, max_results: 500, context: true })
        .catch(() => ({ resources: [] }));
      for (const a of (r.resources || [])) {
        const parts = String(a.public_id).split('/');   // <DROOT>/<code>/<name>
        const code = parts.length >= 3 ? parts[1] : '';
        if (!code || !SAFE.test(code)) continue;
        if (!byCode[code]) byCode[code] = { code, count: 0, createdAt: a.created_at, expires: null };
        const g = byCode[code];
        g.count++;
        if (a.created_at && a.created_at < g.createdAt) g.createdAt = a.created_at;
        const exp = a.context && a.context.custom && a.context.custom.expires;
        if (exp) g.expires = exp;
      }
    }
    const items = Object.values(byCode).map(g => {
      const cfg = GALLERIES.find(x => x.code === g.code) || {};
      const st = GSTORE[g.code] || {};
      return { ...g, title: st.title || cfg.title || g.code, hasPin: !!(st.pin || cfg.pin) };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Could not list deliveries', detail: String(e.message || e) });
  }
});

// Studio: the individual files inside one delivery gallery, for curating it.
app.get('/api/delivery/items', auth, async (req, res) => {
  const code = String(req.query.code || '');
  if (!SAFE.test(code)) return res.status(400).json({ error: 'Bad gallery code' });
  const folder = `${DROOT}/${code}`;
  try {
    const [imgs, vids] = await Promise.all([
      cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix: `${folder}/`, max_results: 500 }).catch(() => ({ resources: [] })),
      cloudinary.api.resources({ type: 'upload', resource_type: 'video', prefix: `${folder}/`, max_results: 500 }).catch(() => ({ resources: [] })),
    ]);
    const map = (r, isVideo) => ({
      publicId: r.public_id,
      resourceType: isVideo ? 'video' : 'image',
      isVideo,
      filename: String(r.public_id).split('/').pop() + '.' + r.format,
      bytes: r.bytes || 0,
      thumb: isVideo
        ? cloudinary.url(r.public_id, { resource_type: 'video', transformation: [{ width: 320, height: 320, crop: 'fill', quality: 'auto', start_offset: '0' }], format: 'jpg' })
        : cloudinary.url(r.public_id, { transformation: [{ width: 320, height: 320, crop: 'fill', quality: 'auto', fetch_format: 'auto' }] }),
    });
    const items = [
      ...(imgs.resources || []).map(r => map(r, false)),
      ...(vids.resources || []).map(r => map(r, true)),
    ];
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Could not list that gallery', detail: String(e.message || e) });
  }
});

// Studio: remove ONE file from a delivery gallery (guarded to that gallery's folder).
app.post('/api/delivery/item/delete', auth, async (req, res) => {
  const { code, publicId, resourceType } = req.body || {};
  if (!SAFE.test(String(code || ''))) return res.status(400).json({ error: 'Bad gallery code' });
  if (!publicId) return res.status(400).json({ error: 'Missing publicId' });
  if (!String(publicId).startsWith(`${DROOT}/${code}/`))
    return res.status(403).json({ error: 'That file is not in this gallery' });
  try {
    const rt = resourceType === 'video' ? 'video' : 'image';
    const out = await cloudinary.uploader.destroy(publicId, { resource_type: rt, invalidate: true });
    if (out.result !== 'ok' && out.result !== 'not found') return res.status(400).json({ error: out.result });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', detail: String(e.message || e) });
  }
});

// Studio: read/write a gallery's access code and display title.
app.get('/api/delivery/settings', auth, (req, res) => {
  const code = String(req.query.code || '');
  if (!SAFE.test(code)) return res.status(400).json({ error: 'Bad gallery code' });
  const st = GSTORE[code] || {};
  const cfg = GALLERIES.find(x => x.code === code) || {};
  res.json({
    code,
    pin: st.pin || cfg.pin || '',
    title: st.title || cfg.title || '',
    watermark: !!st.watermark,
    downloads: st.downloads !== false,     // downloads stay on unless turned off
    canSave: credStoreWritable(),
    fromEnv: !GSTORE[code] && !!cfg.code,
  });
});

app.post('/api/delivery/settings', auth, (req, res) => {
  const { code, pin, title, watermark, downloads } = req.body || {};
  if (!SAFE.test(String(code || ''))) return res.status(400).json({ error: 'Bad gallery code' });
  const p = String(pin == null ? '' : pin).trim();
  if (p && !/^[A-Za-z0-9-]{4,32}$/.test(p))
    return res.status(400).json({ error: 'Access code must be 4-32 letters, numbers or dashes' });
  if (!credStoreWritable())
    return res.status(503).json({ error: 'Gallery settings need storage. Add a Railway Volume mounted at /data, then try again.' });
  try {
    const prev = GSTORE[code] || {};
    GSTORE[code] = {
      pin: p,
      title: String(title == null ? (prev.title || '') : title).slice(0, 120),
      watermark: watermark == null ? !!prev.watermark : !!watermark,
      downloads: downloads == null ? (prev.downloads !== false) : !!downloads,
      updatedAt: new Date().toISOString(),
    };
    // only drop the entry when nothing non-default is set
    const g = GSTORE[code];
    if (!g.pin && !g.title && !g.watermark && g.downloads) delete GSTORE[code];
    saveGalleryStore();
    res.json({ ok: true, pin: p });
  } catch (e) {
    res.status(500).json({ error: 'Could not save gallery settings', detail: String(e.message || e) });
  }
});

// Studio: permanently delete a whole delivery gallery (every original in it).
app.post('/api/delivery/delete', auth, async (req, res) => {
  const code = String((req.body && req.body.code) || '');
  if (!SAFE.test(code)) return res.status(400).json({ error: 'Bad gallery code' });
  try {
    await deleteFolder(`${DROOT}/${code}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', detail: String(e.message || e) });
  }
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
    // Proofing watermark: a tiled-ish diagonal caption over the preview only.
    // Kept to letters/numbers/spaces so it can't break the transformation URL.
    // strip characters that could break the transformation URL, then collapse the
    // gaps they leave behind — 'Ember & Oak' became 'Ember   Oak' without this
    const wmText = String((CLIENTS[0] && CLIENTS[0].name) || 'PROOF')
      .replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'PROOF';
    // Relative sizing: the text layer is scaled to ~88% of the image width, so it
    // reads the same on a 600px thumbnail and an 1800px preview. A fixed font_size
    // looked tiny on the large preview and oversized on thumbnails.
    const wmLayer = { overlay: { font_family: 'Arial', font_size: 120, font_weight: 'bold', text: wmText },
                      color: '#FFFFFF', opacity: 38, gravity: 'center', angle: -30,
                      width: '0.88', crop: 'fit', flags: 'relative' };
    const allowDownload = g.downloads !== false;
    const map = (r, isVideo) => ({
      publicId: r.public_id,
      isVideo,
      filename: nameOf(r.public_id) + '.' + r.format,
      // preview keeps bandwidth low; download link forces the FULL-RES original
      thumb: cloudinary.url(r.public_id, { resource_type: isVideo ? 'video' : 'image', transformation: [{ width: 600, crop: 'limit', quality: 'auto', fetch_format: isVideo ? undefined : 'auto' }].concat(g.watermark && !isVideo ? [wmLayer] : []), format: isVideo ? 'jpg' : undefined, start_offset: isVideo ? '0' : undefined }),
      // viewer/slideshow uses a large preview, NOT the original — full-res originals
      // would burn the bandwidth quota just from browsing.
      preview: isVideo
        ? cloudinary.url(r.public_id, { resource_type: 'video', transformation: [{ quality: 'auto' }], format: 'mp4' })
        : cloudinary.url(r.public_id, { transformation: [{ width: 1800, crop: 'limit', quality: 'auto', fetch_format: 'auto' }].concat(g.watermark ? [wmLayer] : []) }),
      // no download URL at all when downloads are off — hiding the button client-side
      // would still leave the original one right-click away
      download: allowDownload ? cloudinary.url(r.public_id, { resource_type: isVideo ? 'video' : 'image', flags: 'attachment' }) : '',
    });
    const items = [
      ...(imgs.resources || []).map(r => map(r, false)),
      ...(vids.resources || []).map(r => map(r, true)),
    ];
    if (!items.length) return res.status(404).json({ error: 'This gallery has no photos yet' });
    res.json({ title: g.title, count: items.length, items, downloads: allowDownload, watermark: !!g.watermark });
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
  if (g.downloads === false) return res.status(403).json({ error: 'Downloads are turned off for this gallery' });
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
backfillVideoTitles();

app.listen(PORT, () => console.log(`Ember & Oak media backend listening on ${PORT}`));
