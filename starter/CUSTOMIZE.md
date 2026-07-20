# Customizing the Starter for a New Photographer

The starter site is `Studio-Site-Starter.dc.html`. It's the same site as the Ember &
Oak build with the branding stripped to `[bracketed placeholders]`. Fill it in with the
answers from `ONBOARDING_QUESTIONNAIRE.md`.

## 1. Drop in their brand assets
- Add their icon as `assets/studio-icon.png` (square monogram — used in the nav,
  footer-adjacent client login).
- Add their logo if you want it larger anywhere.

## 2. Replace the placeholder copy
Search the file for these and replace with real content:
- `Studio & Name` → the studio name (keep the colored `&` if you like).
- `[Your tagline headline goes here]`, `your tagline` → hero headline + script tagline.
- `[Your Name]` → the photographer's name (About).
- All `[bracketed]` lines → real intro, about, service-area, footer copy.
- `hello@yourstudio.com`, `@yourstudio`, Facebook URL → real contact + socials.
- Testimonials `[Client testimonial…]` / `[Client name]` → real quotes.

## 3. Set the photo categories
In the logic class find the `cats` array (in `renderVals`) and the matching `labels`
in `loadCloud`. Add/remove/rename categories to match what they shoot. Keep the `key`
lowercase (it's the Cloudinary tag) and give a friendly `label`. Also update the
`packages` array (Services & Pricing) and the contact form's session-type `<option>`s.

## 4. Video on or off
If they don't do video, the video/social categories can simply be left out of the
`cats` array — the galleries and reel copy drop automatically. If they do, keep them
and adjust the "Video & Social Reels" blurb on the Services page.

## 5. Colors
The palette is a small set of hex values (terracotta `#9e5423`, sage `#9aad8b`, cream
`#f8f4ec`, brown `#3c2f27`). Do a find-and-replace to their brand colors, or ask and
we'll set a harmonious palette.

## 6. Connect their accounts
- In the logic config near the top: set `CLOUD_NAME` and `UPLOAD_PRESET` to their
  Cloudinary values. For the live build, set `USE_BACKEND = true` (see below).
- Backend: create their `CLIENTS_JSON`, `SESSION_SECRET`, and Cloudinary keys as
  Railway env vars (`backend/.env.example`).

## 7. Build & deploy
Same as the main project:
1. Recompile the site into `backend/public/index.html` (with `USE_BACKEND = true`,
   `API_BASE = ''`).
2. Push to GitHub → Railway (root dir `backend`) → add env vars → deploy.

That's a fully branded, isolated site for the new photographer on their own Cloudinary
account.
