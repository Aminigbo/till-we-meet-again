# tillwemeet

A digital cemetery and tribute platform. Families publish verified memorials; friends leave paid tributes and lay flowers. Every tribute and flower is split 40% to the memorial creator, 40% to charity and 20% to the platform.

**Database:** Firebase Cloud Firestore. **File uploads:** Firebase Cloud Storage (or the server's disk). **Server:** Node.js, using the Firebase Admin SDK.

## Run it on your computer

Requirements: **Node.js 20 or newer** and **ffmpeg** (checks that VVIP videos are 15–30 seconds; without it only the browser check runs).

```bash
npm install               # installs firebase-admin
npm run seed              # optional: fictional demo data
npm start                 # http://localhost:3000
npm test                  # end-to-end check of every main flow
```

The included `.env` file works as it is for your computer. It has development-only keys, so don't use it for the live site.

## Settings (.env files)

| File | What it's for |
|---|---|
| `.env` | Your computer. Ready to run: local database, simulated payments, demo admin. |
| `.env.example` | Every setting, with an explanation. |
| `.env.production.example` | The live site. Copy it to `.env.production` on your server and fill in every value, or enter the same values in your host's settings (on Cloud Run: Edit → Variables & secrets). |

Values are read in this order, first one wins: real environment variables, then `.env.<NODE_ENV>` (for example `.env.production` when `NODE_ENV=production`), then `.env`. In production the app refuses to start without Firebase, `SESSION_SECRET` and `ENCRYPTION_KEY`. All `.env` files except the two examples are kept out of git.

With no Firebase settings in `.env`, the app uses a **local development store** (`data/local-firestore.json`) that behaves like Firestore, so you can try everything before creating a Firebase project. It refuses to run when `NODE_ENV=production`.

Demo logins after `npm run seed`:

| Role | Email | Password |
|---|---|---|
| Admin | admin@tillwemeet.com | value of `ADMIN_PASSWORD`, or `tillwemeet-admin` |
| Memorial creator | family@example.com | demo12345 |
| Visitor | visitor1@example.com | demo12345 |

Make more admins with `npm run make-admin -- email@example.com "password"`.

## Connect Firebase

1. **Create a project** at [console.firebase.google.com](https://console.firebase.google.com). Firestore works on the free Spark plan, but Cloud Storage on new projects needs the **Blaze (pay as you go)** plan. At launch traffic the bill is usually small, and you can set a budget alert.
2. **Create the Firestore database**: Build → Firestore Database → Create database → **Production mode**. Pick a location close to your users (for Nigeria, `europe-west1` (Belgium) or `europe-west2` (London) usually give the lowest latency). The location can't be changed later.
3. **Turn on Storage**: Build → Storage → Get started. Note the bucket name (e.g. `your-project.firebasestorage.app`).
4. **Create a service account key**: Project settings → Service accounts → Generate new private key. Save the file as `service-account.json` in the project folder. Keep it secret; it's already in `.gitignore`.
5. **Fill in your settings**: in `.env` to use Firebase while developing, or in `.env.production` (copied from `.env.production.example`) on the live server. Set `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT=./service-account.json`, `FIREBASE_STORAGE_BUCKET`, plus `SESSION_SECRET`, `ENCRYPTION_KEY` and `ADMIN_PASSWORD`.
6. **Deploy the indexes and security rules** with the Firebase CLI:
   ```bash
   npm install -g firebase-tools
   firebase login
   cp .firebaserc.example .firebaserc     # put your project id in it
   npm run deploy:firestore
   ```
   Indexes take a few minutes to build. Until they're ready, Firestore returns an error with a link to the missing index.
7. `npm start`. On first start the app creates the admin account, the memorial tones and a placeholder charity partner. Run `npm run seed` only if you want demo data in that project.

To develop against the **Firebase emulator** instead: `firebase emulators:start --only firestore`, then set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `FIREBASE_PROJECT_ID=demo-tillwemeet` in `.env`.

### Security rules

`firestore.rules` and `storage.rules` deny **all** direct access from browsers. Only the server reads and writes data, through the Admin SDK, so NINs, death certificates and payment records can't be read even by someone who has your Firebase config.

## Data model

| Collection | Document id | Holds |
|---|---|---|
| `users` | auto | account, role, wallet totals (`earned`, `withdrawn`, `paid_out`), counts |
| `user_emails` | email | `{ uid }`. Claimed in a transaction so each email is used once |
| `profiles` | auto | the memorial, verification details, counters (`tribute_count`, `flower_count`, `candles`, `views`, `charity_raised`, `creator_earned`), search tokens |
| `slugs` | slug | `{ profile_id }`. Gives each memorial a unique web address |
| `tributes` | `{profileId}_{userId}` | one per person per memorial, by construction |
| `flowers` | auto | flower, note, a copy of the sender's name and the memorial's name for lists |
| `candles` | `{profileId}_{userId}` | one candle per person |
| `payments` | Paystack reference | amount, purpose, status, where to send the payer afterwards |
| `ledger` | auto | the 40/40/20 split of every tribute and flower, plus listing fees |
| `withdrawals`, `charities`, `charity_disbursements` | auto | payouts and charity giving |
| `revisions` | auto | edits waiting for review |
| `tones`, `settings`, `audit_log`, `sessions` | | tones, prices, admin actions, sign-in sessions |
| `stats/global`, `stats_daily/{date}` | | running totals for the dashboard and homepage |

How the rules are kept on Firestore:
- **Payments** are applied in one transaction: the payment, the tribute or flower, the memorial's counters, the creator's wallet, the ledger entries and the totals all change together, and applying the same payment twice does nothing.
- **Withdrawals** check and reduce the balance in one transaction, so two requests at once can't overdraw.
- **Edits** to live memorials check the 90-day rule and claim the edit inside a transaction.
- **Search** uses keys stored on each memorial: name prefixes, place and year (see "Search" below). Firestore has no full-text search, so misspellings aren't matched. For typo-tolerant search later, add Algolia or Typesense.
- **Page views** are added up in memory and written every 30 seconds, to stay under Firestore's limit of about one write per second per document.
- **Indexes**: `npm test` checks that every query the app runs has a composite index in `firestore.indexes.json` (49 at present). After adding a new query, run `npm run indexes` to regenerate the file, then deploy it.
- **Expired sessions** are deleted hourly. You can also add a Firestore TTL policy on `sessions.expires_at`.

## Payments

Without `PAYSTACK_SECRET_KEY` the site uses a simulated checkout (a yellow banner says so). To go live:

1. Add your Paystack secret and public keys to `.env`.
2. In the Paystack dashboard set the **Callback URL** to `https://YOUR-DOMAIN/payments/callback` and the **Webhook URL** to `https://YOUR-DOMAIN/payments/webhook`.

Every payment is verified with Paystack (amount and currency) before anything is published, and the webhook signature is checked.

## Deploying

**Google Cloud Run** fits Firebase best: same Google project, credentials supplied automatically (no key file needed), scales to zero.

```bash
gcloud run deploy tillwemeet --source . --region europe-west1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,BASE_URL=https://tillwemeet.com,FIREBASE_PROJECT_ID=your-project,FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app \
  --set-secrets SESSION_SECRET=session-secret:latest,ENCRYPTION_KEY=encryption-key:latest,PAYSTACK_SECRET_KEY=paystack-secret:latest
```

(Create those three secrets in Secret Manager first, and give the Cloud Run service account the "Cloud Datastore User" and "Storage Object Admin" roles.)

Set `FIREBASE_STORAGE_BUCKET` on any host where the disk isn't permanent (Cloud Run, Render, Railway), otherwise uploads are lost on restart. A VPS works too: install Node 20+ and ffmpeg, put `.env` and the service account file on the server, and run `npm start` behind HTTPS (Nginx or Caddy).

Back-ups: turn on Firestore **point-in-time recovery** or scheduled backups (Firestore → Disaster recovery), and object versioning on the Storage bucket.

## Search

The **Memorials** page (`/memorials`, or a category such as `/memorials/vip`) searches published memorials:

- **Name**: first name, middle name, surname, nickname or title. Partial names work ("oka" finds Okafor), and so do several words ("tam bri"). Names are suggested as you type, with photo, years and place.
- **Year**: died in, or born in, a year or a whole decade (for example, died in the 2010s).
- **Location**: country, then state or region, then LGA or county. The state and LGA boxes suggest places that already have memorials. Spelling and punctuation don't matter ("Obio/Akpor", "obio akpor").
- **Sort**: recently added, date of death, most tributes, most flowers, surname A–Z.
- Filters combine with each other and with the category tabs. Active filters show as chips you can remove one at a time. Every search has its own link, so it can be shared.
- The places and year of death on each memorial link to the matching search.

How it works on Firestore: each memorial stores a list of search keys (`filterKeys`, such as `s:lagos`, `l:ikeja`, `d:2024`, `dd:2020`, `n:oka`). Firestore narrows by the most specific filter, and the app checks the rest. This keeps the index count low (49 in total) whatever filters are combined. A search with several filters checks up to 1,000 memorials matching the most specific one. For much larger collections, move search to Algolia or Typesense.

**Upgrading an existing database?** Run `npm run reindex` once to add search keys to memorials created before this version.

## What's built

**Public site** — homepage with a spotlight headstone, search, and a row of up to 30 headstones for each category (Legends, VVIP, VIP, Regular) with "See all" pages, filters and paging. Memorial pages show the headstone, born/died dates, calculated age, place (country, state, LGA), and share buttons for WhatsApp, Facebook, X, LinkedIn and copy link. Each tribute has its own share page with a social preview. About, How it works (categories, pricing, verification, earnings, editing, Legends, FAQ), Charity partners and Terms pages.

**Rules implemented**
- Life stories and tributes require sign-in; reading tributes is public so shared links work.
- One tribute per person per memorial (enforced by the tribute's document id). Creators can't tribute their own memorial.
- Tribute fees ₦1,000 / ₦5,000 / ₦20,000 (Legend ₦20,000), with word limits of 250 / 500 / 1,500 (Legend 1,500).
- Flowers ₦2,000 / ₦10,000 / ₦50,000 (Legend ₦50,000). Anyone signed in can lay a flower at any time, as often as they like: white lily, red rose, marigold, chrysanthemum or pink carnation, with an optional note of up to 160 words. Everyone can see who laid flowers. After paying, the visitor gets a card (photo, name, years, their flower and note) to download as a PNG and share.
- Tributes and flowers are split 40/40/20 into a ledger. Tribute and flower counts show on every headstone card and memorial page.
- Listing fees ₦10,000 / ₦50,000 / ₦200,000. Only admins can make a Legend.
- Edits: changes are free until published. After publishing, the first edit is allowed any time; later edits open 90 days after the previous one. Live edits go to admin review and the memorial stays up. A declined edit returns the allowance. Upgrading opens an extra edit.
- Upgrades (Regular → VIP → VVIP) charge only the difference.

**Tiers**
- Regular: grey granite headstone, story, photo, tributes.
- VIP: white marble and brass, a solemn tone that fades in when the page opens (pausable, remembered), 6-photo gallery with lightbox, epitaph, "light a candle".
- VVIP: black granite with gold-leaf lettering, 15–30 s video, 12-photo gallery, life timeline, order of service with map links, "survived by", verified seal, homepage spotlight, printable funeral programme.
- Legends: bronze headstone with laurel, all VVIP features, top of the homepage.

**Verification** — death certificate (PDF/image), certificate number and issuer, uploader relationship, NIN (encrypted with AES-256-GCM; admins see the last 4 digits and a "reveal" that is logged), uploader photo, optional photo ID, phone, address, a second family contact, and an attestation. Documents are stored privately (Cloud Storage or disk) and only served to admins through the app. Uploads are checked by file content, not extension. Possible duplicates are flagged in review.

**Creator account** — memorial status and next steps, edit allowance, upgrade, stats, tribute reporting, earnings (40% share), bank details and withdrawals.

**Admin dashboard** — overview (money, charity balance, owed to creators, 30-day payments chart, memorial counts), review queue with documents, approve / send back with reason / suspend / reinstate, name or remove Legend, homepage spotlight, category override, edit requests with before/after comparison, tribute moderation and reports, flower moderation, users (ban, admin role, password reset), payments, withdrawal payouts, charity partners and published disbursements, memorial tones (upload your own), pricing, audit log.

**Security** — scrypt password hashing, Firestore-backed sessions with rotation on login, sign-out everywhere on password change or ban, CSRF tokens on every form, rate limits on sign-in/registration/creation, security headers and a Content Security Policy.

## Tones

Five tones are included and generated by `scripts/make-tones.py`: Amazing Grace and Taps (public-domain melodies) and three original pieces. "Popular" commercial songs need a licence; once you have one, upload them in **Admin → Tones**.

## Before launch

- Have a lawyer review the Terms page, especially the NDPA 2023 data-protection section.
- Replace the demo charity partners with real ones.
- Add email (password reset and notifications). Password resets currently go through **Admin → Users → Reset password**.
- NIN verification is manual. For automatic checks, integrate a provider such as NIMC-licensed verification services (e.g. Prembly, Dojah, Smile ID) in the review step.
