# New Studio Onboarding — Intake Questionnaire

Fill this out for each new photographer. Everything here maps directly to a spot in
the site or the backend config, so once it's complete the site can be made theirs.

---

## 1. Business basics
- **Studio name** (exact styling, e.g. "Ember & Oak"): ______________________
- **Owner / photographer name** (for the About page): ______________________
- **Tagline** (short, script line above the hero — e.g. "warm, timeless stories"): ______________________
- **Hero headline** (the big statement — e.g. "Photography, film & social reels made to be felt."): ______________________
- **One-line hero subtext** (what you shoot + area): ______________________

## 2. Brand look
- **Logo file** (PNG/SVG, transparent if possible): ______________________
- **Icon/monogram file** (square, for nav + client login): ______________________
- **Primary color** (accent — buttons/links; hex if known): ______________________
- **Secondary color** (supporting accent): ______________________
- **Background tone** (cream / white / warm / cool): ______________________
- **Vibe in 3 words** (e.g. warm, intimate, editorial): ______________________
- Any fonts you love? (else we pick a tasteful pairing): ______________________

## 3. What you offer — photo categories
Check all that apply (these become your Portfolio filters + gallery cards):
- [ ] Weddings
- [ ] Newborn
- [ ] Family
- [ ] Maternity
- [ ] Engagement / Couples
- [ ] Cinematic / Portrait
- [ ] Drone / Aerial
- [ ] Events
- [ ] Branding / Business
- [ ] Real estate
- [ ] Other: ______________________

## 4. Video & reels
- Do you offer **video / films**?  ☐ Yes  ☐ No
- Do you offer **custom social media reels**?  ☐ Yes  ☐ No
- How should video show? ☐ In the galleries (uploaded)  ☐ Linked from YouTube/Vimeo  ☐ Instagram/TikTok embeds
- Notes on video packages: ______________________

## 5. About section
- **Your story** (a paragraph or two — how you started, what you love): ______________________
- **Photo of you** for the About page: ______________________

## 6. Services & pricing
For each package you offer (add/remove as needed):

| Package name | Starting price | Short description | 3–4 bullet inclusions |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |

- Which package is your **most popular** (gets the highlight badge)? ______________________
- Any **video / reel** pricing note to show below the packages? ______________________

## 7. Testimonials
Provide 2–3 short client quotes + names:
1. "______________________" — ______________________
2. "______________________" — ______________________
3. "______________________" — ______________________

## 8. Contact & socials
- **Email**: ______________________
- **Instagram handle**: ______________________
- **Facebook URL**: ______________________
- Other (TikTok, Pinterest, phone, booking link): ______________________
- **Service area** (cities): ______________________

## 9. Client delivery preferences
- Default **auto-delete window** for client galleries? (e.g. 30 / 60 / 90 days, or never): ______________________
- Should delivery galleries require a **PIN** by default?  ☐ Yes  ☐ No
- Roughly how many photos per delivery, and typical file size? ______________________
  *(helps decide if Cloudinary free tier is enough or if we move delivery storage.)*

## 10. Accounts & hosting (technical)
- **Cloudinary** account created?  ☐ Yes  ☐ No  — cloud name: ______________________
  - Unsigned upload preset name: ______________________
  - API key/secret ready for the backend (kept private)?  ☐ Yes  ☐ No
- **GitHub** account for the repo: ______________________
- **Railway** account for hosting: ______________________
- **Domain name** (if they have one to connect): ______________________

---

### Where each answer goes
- Sections 1–8 → edit the site source (`Studio-Site-Starter.dc.html`) — see `CUSTOMIZE.md`.
- Section 9 → defaults in the delivery UI + `GALLERIES_JSON` (for PINs).
- Section 10 → Railway environment variables (`backend/.env.example`).
