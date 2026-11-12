# AGENTS.md: guide for AI coding assistants working on IOYA

This file is for AI assistants (Claude Code, Copilot, Cursor, Codex, etc.) helping a member of the IOYA team. Read it fully before making changes. The human-facing setup guide is [README.md](README.md); this file adds the context an assistant needs to work safely.

## Start here (read this first)

### Which file to edit

The site is three separate pages. Edit the one that matches the change; most work is in the app.

| What you're changing | File | Open it at |
|---|---|---|
| **The app**: Home, History, Split Bill, Contacts, Profile, the app's colors, fonts and wording | **`public/app.html`** | http://localhost:3001/app |
| The landing page: headline, "How it works", the Log in box, the admin Maintain buttons | `public/index.html` | http://localhost:3001 |
| The admin Maintain pages (Users, Contacts, Groups, Splits, Payment Methods) | `public/admin.html` | http://localhost:3001/admin |
| The login cookies shared by all three pages | `public/session.js` | |
| Routes (which file each address serves) | `server.js` | |

Before November 10, 2026 the app was `public/index.html`. **If your branch is older than that and changes the app in `public/index.html`, stop and tell your human:** that file is now the landing page, so the change must move to `public/app.html` (Jackson can help).

### Every new task, in this order

Run these in a terminal **inside the project folder** (the one with `package.json`; in VS Code use File → Open Folder, then Terminal → New Terminal). `git status` should print `On branch …`; if it says "not a git repository", you're in the wrong folder.

```bash
git switch main
git pull
npm install
git switch -c short-task-name
```

`npm install` picks up packages teammates added (for example `qrcode`). Then `npm start` and open http://localhost:3001/app. After pulling or switching branches, **stop the server (Ctrl+C) and run `npm start` again**: Node keeps running the old `server.js` until it restarts.

Merged branches are deleted from GitHub automatically, so start each task from a fresh `main` instead of reusing an old branch.

### Accounts you'll see

- Opening `/app` gives every browser a **guest** account automatically; no login needed to test the app.
- **Log in** (email + password) is on the landing page `/`. **Admins** (`users.is_admin`) see the Maintain buttons **on the landing page**, and an "Admin tools" button on the app's Profile tab. They are not in the app's tab bar.
- Only Jackson makes accounts admins (an SQL line in Supabase). Don't try to make an account an admin from code.

### Common problems and fixes

| What you see | Why | Fix |
|---|---|---|
| `npm error enoent Could not read package.json` | The terminal is one folder too high | `cd` into the project folder (the one with `package.json`), then retry |
| `Cannot GET /app` | The server was started before `/app` existed | Ctrl+C, then `npm start` again |
| `EADDRINUSE` / address already in use | `npm start` is already running in another terminal | Use that one, or stop it with Ctrl+C there |
| `cannot switch branch while merging` | A merge was started and not finished | `git merge --abort` (not `--quit`, which leaves conflict markers in files), then `git switch main` |
| `your local changes would be overwritten` | Uncommitted edits | Commit them on your branch first, or ask your human; never discard them silently |
| A merge conflict in `public/index.html` | Your branch edits the old app file | See "Which file to edit": move the change to `public/app.html` |
| "Couldn't load your data" mentioning a column or function that doesn't exist | A Supabase SQL file hasn't been run | Tell your human which file the message names; Jackson runs SQL on the shared project |
| No Maintain buttons after logging in | Looking in `/app`, or the account isn't an admin | Check the landing page `/`; ask Jackson about admin access |

### Rules that bite

- **Database changes:** don't write new SQL, tables, policies or grants without asking Jackson first. The team shares one Supabase project and Jackson runs every SQL file. If a feature seems to need a database change, stop and ask.
- **Fonts:** `--f-mono` in `public/app.html` must stay a **monospace** font (currently IBM Plex Mono). It's used for money amounts so digits line up in columns; a regular font makes totals look uneven. Change `--f-body` or `--f-display` for the look of text instead.
- Ask before every `git push` or PR, never commit `.env` or keys, and add no AI co-author lines (details in "Git workflow").

## What IOYA is

IOYA is a bill-splitting web app built by a four-person student team (Jackson, Tye, Nick, Tanner) for BYU IS 401. The payer scans a receipt, assigns line items to friends (shared items split evenly), tax/tip/fees are split in proportion to what each person ordered, and the app tracks who has paid back. It is a class project with real grading constraints (see "Course rules" below).

## Stack (keep it this simple unless the team decides otherwise)

| Layer | What | Where |
|---|---|---|
| Frontend | Plain HTML, CSS and vanilla JavaScript. No framework, no build step. | `public/index.html` (landing, `/`), `public/app.html` (app, `/app`), `public/admin.html` (admin, `/admin`), `public/session.js` (login cookies) |
| Data + API | Supabase (hosted PostgreSQL + auto REST API), called with `supabase-js` v2 loaded from jsDelivr | `supabase/*.sql` |
| Web server | Node 18+ / Express 5, ~25 lines. Serves `public/` and `GET /config.js`, which injects the Supabase URL and anon key from `.env` so they are never committed. | `server.js` |

Port: **3001** (3000 is used by another project on Jackson's machine).

Hosting: the live app is at https://ioya.onrender.com, on Render's free tier. Render runs `npm install` and `npm start`, reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from its own environment settings, and supplies `PORT` itself. The live site uses the same shared Supabase project as local development. **Every visitor gets a guest account, and each account can read only its own data (see Security rules). It is still a class project: keep only fake data in it and do not share the link publicly.**

## Getting it running

1. Requirements: Node.js 18+ and Git. Check with `node -v`.
2. Install dependencies from the repo root:

   ```bash
   npm install
   ```

3. Create `.env` in the repo root (it is git-ignored). Copy `.env.example` and fill in:

   ```
   SUPABASE_URL=https://<project-id>.supabase.co
   SUPABASE_ANON_KEY=<anon public key>
   PORT=3001
   ```

   **You do not have these values and must not invent them.** Ask your human for them; a teammate shares them privately. Never ask for, store or use the `service_role` key or the database password. They are not needed.

4. Start the server, then open http://localhost:3001/app for the app (http://localhost:3001 is the landing page):

   ```bash
   npm start
   ```

   `npm run dev` restarts on file changes. If it exits with "Missing SUPABASE_URL or SUPABASE_ANON_KEY", `.env` is missing or misnamed.

5. The team shares **one** Supabase project. Anything saved from the app (contacts, "Mark as paid") is real shared data that teammates see. Test with obviously fake names and clean up after yourself.

## Repository layout

```
server.js                   Express: static files + /config.js (reads .env)
public/index.html           Landing page (/): hero + image, How it works, email/password Log in, admin Maintain buttons, Log out
public/app.html             The app (/app), the main frontend
public/admin.html           Admin Maintain pages (/admin#users, #contacts, #groups, #splits, #methods); admins only
public/session.js           Cookie storage for the Supabase login (chunked; moves old localStorage logins); IOYA_CLEAR_LOGIN_COOKIES()
public/images/              App screenshots used on the landing page
supabase/schema.sql         Creates all 11 tables, RLS policies and the contact/group functions. DROPS tables first.
supabase/seed.sql           Sample rows for every table (run after schema.sql)
supabase/contacts-sync.sql  Older migration that added save_contact/delete_contact (superseded; don't re-run)
supabase/anonymous-accounts.sql  Guest accounts: users.auth_user_id, ensure_my_user(), per-user contact functions
supabase/private-data.sql   Private-data RLS rules, friend_groups.user_id owner, save_group()/delete_group()
supabase/profile.sql        save_my_profile(): edits the users row and the "You" contact together
supabase/admin-users.sql    Maintain Users: admin_list_users(), admin_save_user(), admin_delete_user(); latest ensure_my_user() (links a first login to an admin-added user by email)
supabase/admin-records.sql  Maintain Contacts, Groups, Payment Methods: admin_list_/save_/delete_contact(s), _group(s), _payment_method(s)
supabase/admin-splits.sql   Maintain Splits: admin_list_splits(), admin_save_split(event, payer, jsonb) replaces the receipt/items/shares/people in one step, admin_delete_split()
supabase/admin-login.sql    users.user_email + users.is_admin, is_admin(), and the current ensure_my_user() (keeps user_email in sync)
supabase/payment-preference.sql  Preferred payment app: profile_payment_accounts.preferred + get_/set_my_payment_preference()
supabase/avatars.sql        Profile pictures: public "avatars" Storage bucket + per-folder policies, users.avatar_path, set_my_avatar()
docs/ioya-erd.pdf / .png    The team's ERD (the source of truth for the data model)
README.md                   Human setup guide + course deliverable (graded; keep its 5 sections)
.env.example                Template for .env
```

## Data model

The schema follows the team's ERD (`docs/ioya-erd.pdf`). ERD names are PascalCase; the database uses snake_case (`Users.UserFirstName` → `users.user_first_name`). Money is **always integer cents** (`1959` = $19.59).

| Table | Key | Notes |
|---|---|---|
| `users` | `user_id` | `auth_user_id` (uuid, unique) links a row to its Supabase Auth user; it is NULL for the seed users. `avatar_path` (text, not in the ERD yet) is the profile picture's path in the `avatars` Storage bucket, NULL = no photo; change it only with `set_my_avatar()`. The app acts as the signed-in user (`S.userId`). Seed user 1 ("Demo Payer") owns the sample data, and no account signs in as it. New users start with blank names. |
| `contacts` | `contact_id` | `user_id` FK. The payer also has a contact row with the **same first name, last name and phone** as their `users` row; the app finds it by that match and shows it as "You". Don't break that match. |
| `friend_groups` / `group_members` | `group_id` / (`group_id`, `contact_id`) | Groups ↔ contacts, many-to-many. `friend_groups.user_id` (not in the ERD yet) is the owner. |
| `payment_methods` | `pay_method_id` | Lookup: 1 Venmo, 2 PayPal, 3 Zelle, 4 Cash |
| `contacts_payment_method` | (`contact_id`, `pay_method_id`) | Username per method; `is_preferred` (at most one per contact, enforced by a partial unique index) |
| `events` | `event_id` | One outing; can hold several receipts |
| `receipts` | `receipt_id` | `event_id`, `payer_user_id`; `tax_cents`, `fees_cents`, `tip_percent`, `tip_cents`, `total_cents` (printed total = items + tax + fees, before tip) |
| `line_items` | `item_id` | `receipt_id`, `description`, `price_cents`, `position` |
| `participants` | (`contact_id`, `event_id`) | `paid_method_id` is **NULL while unpaid**; set = paid, and records how |
| `item_assignments` | (`contact_id`, `item_id`) | `share_cents` per person per item |

Amount owed is **not stored**; it is computed from `item_assignments` plus a proportional share of tax + fees + tip (largest-remainder rounding so totals match to the cent). See `owedByContact()` and `calc()`.

## Security rules (Row Level Security): read before adding any write

The browser uses the public **anon** key, so RLS is the only protection. On startup the app signs in with Supabase **anonymous sign-in** (session kept in **cookies** by `public/session.js`, passed to `createClient` as `IOYA_AUTH_OPTIONS`) and calls `ensure_my_user()`, which creates the caller's `users` row and "You" contact if missing. Signed-in requests run as the Postgres role **`authenticated`**, not `anon`, so every policy and grant must cover `authenticated`. Current rules (`private-data.sql`, also at the bottom of `schema.sql`):

- **anon (no session) gets nothing**: no SELECT policies and no function grants. Everything below is for `authenticated` only.
- authenticated can **SELECT only their own rows**. "Own" is defined through `app_user_id()` (the caller's `users` row, NULL when signed out) and the `SECURITY DEFINER` helpers `owns_contact`, `owns_group`, `owns_event`, `owns_receipt`, `owns_item`: own `users` row, `contacts.user_id`, `friend_groups.user_id`, group members where both the group and the contact are yours, receipts you paid, and events/line items/participants/assignments hanging off those receipts. `payment_methods` is readable by everyone signed in.
- they can **UPDATE only `participants.paid_method_id`**, and only on their own events ("Mark as paid").
- they can add/edit/delete contacts and groups **only** through `SECURITY DEFINER` functions: `save_contact(p_contact_id, p_first_name, p_last_name, p_phone, p_methods jsonb)`, `delete_contact(p_contact_id)`, `save_group(p_group_id, p_name, p_contact_ids integer[])` (null id = create; the array is the full member list and replaces the old one; returns the group_id) and `delete_group(p_group_id)` (keeps the contacts). All act only on the caller's own rows. The profile is changed only through `save_my_profile(p_first_name, p_last_name, p_phone)` (`profile.sql`), which updates `users` and the "You" contact in one transaction (never update one without the other) and refuses a profile that exactly matches another contact. Direct INSERT/UPDATE/DELETE on tables is revoked. `delete_contact` refuses contacts who are on a past split.
- New tables need RLS enabled and an "own rows" SELECT policy for `authenticated`, or they will either leak or return nothing.
- **Admin pages** (`public/admin.html`): each table is one entry in `TABLES` (`load`, `columns`, `filters`, `search`, `view`, `form`, `check`, `save`, `errField`, `canDelete`, `deleteText`, `del`; optional `canEdit`, `name` for the toast, `sql` for the file named in "needs an update", `live` for fields that redraw the form); the list, search, sort, add/edit dialog, red errors, delete confirmation and toasts are shared. To add a table, add its entry and an `admin-<table>.sql` with `admin_list_<table>()` / `admin_save_…()` / `admin_delete_…()` functions that start with `IF NOT is_admin() THEN RAISE …`. Users (`admin-users.sql`): deleting a user removes their splits first (receipts have no ON DELETE CASCADE to users), then the users row (contacts, groups, payment accounts cascade); their Supabase login stays. A login's email can't be changed by an admin; admins can't delete themselves or un-admin themselves; guests can't be admins. Contacts, Groups and Payment Methods (`admin-records.sql`): the forms pick from `REF` (users, payment methods, contacts) loaded with the list; owner dropdowns use `ownerField()` and are locked on Edit (the database refuses owner changes too). A user's "You" contact can't be edited or deleted there (`canEdit`/`canDelete`), and neither can a new contact copy the owner's name + phone. Group members must be the owner's contacts. The six built-in payment methods are matched **by name** in the app, so they can't be renamed or deleted; added ones are shown in the app as plain text fields, and can be deleted only when no `contacts_payment_method` or `participants.paid_method_id` uses them. `admin_save_payment_method` picks the next id itself (older files inserted ids directly). Splits (`admin-splits.sql`): one row per event; only one-receipt events are editable (`canEdit`). The form adds `read` (item rows `data-item`/`data-k`/`data-person`, paid dropdowns `data-paid`), `onInput` (redraws only `#split-live`, the totals and people list, so typing keeps focus) and the `additem`/`rmitem` actions. `admin_save_split` computes the even shares itself (leftover cents to the first people, matching `evenShares()`), always adds the payer's "You" contact as a participant, and never marks the payer paid. `owedFor()` in admin.html must stay the same rule as `owedByContact()` in app.html.
- **Admins** (`admin-login.sql`): `users.is_admin` marks admins; `is_admin()` is true only for a logged-in, non-guest account whose row has it. Nobody can change `is_admin` from the browser (direct UPDATE is revoked). Every admin database function must start by checking `is_admin()` and raise an error otherwise. The landing page and `/admin` only *hide* admin buttons; never rely on that. `users.user_email` is unique (ignoring capitals) and is set by `ensure_my_user()` from `auth.users.email`.
- **Storage** (`avatars.sql`): the only bucket is `avatars` (public, JPEG only, 1 MB max). Policies on `storage.objects` let `authenticated` users read, upload, replace and delete only files in a folder named after their own `auth.uid()`; uploading and replacing also require a saved profile (`auth.jwt() ->> 'is_anonymous'` is false), and so does `set_my_avatar()` with a photo. Public links work without a policy; that is intended for profile photos only. A new bucket needs its own folder-scoped policies.

**Any new feature that writes data needs a database change first.** The preferred pattern is a new `SECURITY DEFINER` function (validated, one transaction, acting on `app_user_id()`) granted to `authenticated` only, not broad table grants. To ship it:

1. Write the SQL in a new file, `supabase/<feature>.sql`, written so it is safe to run more than once (`CREATE OR REPLACE`, `IF NOT EXISTS`).
2. Append the same SQL to `supabase/schema.sql` so fresh setups get it.
3. **A human must run it** in Supabase → SQL Editor. You cannot do it with the anon key. Tell your human exactly what to paste.
4. Check it from the app before calling it done. (A bare `curl` with the anon key now sees nothing; it needs a signed-in user's access token.)

Never run `schema.sql` against the shared project without the team agreeing. It drops every table and all real data.

## How `public/app.html` (the app) is organized

Single global state, string-template rendering, event delegation. No framework.

- **State:** `S` holds data loaded from Supabase plus the current `view` and the in-progress split `draft`. `ui` holds transient UI state (open sheet, toast, flags). Only `S.view` and `S.draft` are saved to `localStorage` (`ioya-draft-v1`).
- **Accounts and Profile:** `S.me` is the user's name/phone; `S.account` is `{email, guest, since}` from the Supabase Auth session (`readAccount()`). The `profile` sheet (`profileSheet()`) opens in **view mode** (initials avatar, name, phone, email + Verified badge or Guest badge, member since, stats, Account box); the pencil button opens edit mode. The step is `null` (view), `edit`, `email`, `code`, `password` or `signout`. The mode is `create` (guest → profile, "Step n of 4": edit → `auth.updateUser({email})` → `verifyOtp` type `email_change` (same user id and data) → `password` step → `updateUser({password})`), `signin` (email + password → `signInWithPassword`, then `S.userId = null` and `loadAll()`), `reset` (Forgot password: `resetPasswordForEmail` → `verifyOtp` type `recovery`, which logs in → `loadAll()` → `password` step), `change` (logged-in → `password` step), or `null` (plain edit). `savePassword()` checks `CHECK.password` (8–72 characters) and `CHECK.password2` (must match); passwords are never trimmed (`PASSWORD_FIELDS`). Guests see **Create profile** plus a small "Already have a profile? Log in" link; logged-in users see their email, **Change password** and **Log out**. Log out calls `signOut({scope:'local'})` then `IOYA_CLEAR_LOGIN_COOKIES()`. `/app?start=login|create|reset` (links from the landing page) opens that step. Validation: `CHECK[field]` returns the exact message shown in red under that field (`.ferr`, `.field.invalid`, `aria-invalid`); `liveCheck()` clears it while typing without re-rendering; database/auth errors go under the matching field (`errField()`) or into a red `.alert` at the top. Email codes, never magic links (links open in the wrong browser on phones). Guest data is never merged into a saved profile. **Profile pictures** (`avatars.sql`): **saved profiles only** (`S.account.guest` sees a "Create a profile…" note instead; the database refuses guests too). In edit mode, `photoPicker()` shows the circle plus Add/Change/Adjust/Remove photo. `choosePhoto()` checks the file (`photoProblem()`: image type, at most 20 MB), decodes it with `createImageBitmap`, and opens the adjuster (`state.crop`, drawn by `cropEditor()` instead of the form). In the adjuster, `c.x`/`c.y` are the photo's top-left inside the `CROP` (260 px) square and `c.zoom` is 1–4; `clampCrop()` keeps the circle covered and `zoomCrop()` zooms around a point. Drag, pinch (pointer events), wheel, the `cropzoom` slider and arrow/+/- keys update it through `applyCrop()` without re-rendering. `finishCrop()` cuts the circle's square from the full-size bitmap as a JPEG of at most 400×400. The result waits in `state.photo` (`undefined` = unchanged, `null` = remove, `{blob, url, source}` = new; `source` lets **Adjust** reopen it) until **Save**. `releasePhoto()`/`releaseCrop()` free the memory. `saveProfile()` then calls `savePhoto()`: it uploads to `avatars/<auth user id>/<random uuid>.jpg` (a new name every time, so caches never show an old photo), calls `set_my_avatar(path)` (which returns the old path), and deletes the old file. Photo errors go under the photo (`e.field = 'photo'`, `photoErr()`). `faceHTML(url)` draws initials with the photo on top, used on the profile card and in edit mode; the Profile tab icon uses `.tab-face`. A photo that fails to load is hidden by a capture-phase `error` listener, so the initials show. The bucket is public on purpose (the planned profile QR page shows the photo to people who aren't signed in); never put anything but profile photos in it. **Payment accounts** (`profile-payment-accounts.sql`, `payment-preference.sql`) are on the Profile tab: `profilePaymentAccounts()` shows linked apps (`linkedMethods()`, preferred first with a star, `showAccount()` formats `@venmo` and `+1…` phones as `(801) 555-1234`) or an empty state, and the editor (`step:'payments'`, `paymentDraft`, `prefDraft` radios). `payerAccountProblem(method, value)` returns the exact red message and must agree with `payerAccountValid()` (a test checks this) and with `save_my_payment_accounts()`; change all three together. `S.paymentPreferred` comes from `get_my_payment_preference()` (missing function = no star, not an error); `preferredMethod()` ignores it if that app was unlinked. `methodFor()` tries your preferred app first only when the contact has no preferred app of their own. Guests may link payment apps (needed to request money).
- **Loading:** `loadAll()` first runs `signIn()` (anonymous sign-in + `ensure_my_user()`, sets `S.userId`), then fetches users, payment methods, contacts (`CONTACT_SELECT`), groups and events (nested receipts → line_items → item_assignments, plus participants) and rebuilds `S`. `normContact()` normalizes a contact row.
- **Views:** `V.home`, `V.history`, `V.contacts`, and the split flow `V.scan → V.scanning → V.review → V.people → V.assign → V.summary → V.sent` return HTML strings. `render()` draws the current view, tab bar, sheets and toast.
- **Live regions:** `LIVE[name]` functions fill `[data-live="name"]` elements via `refresh()`, so totals can update while the user types without re-rendering (which would steal focus).
- **Bottom sheets:** `sheetHTML()` switches on `ui.sheet.type` (`profile`, `contact`, `group`, `req`, `receipt`, `confirm`). The `receipt` sheet (History → "View full receipt split") is built by `receiptSplitDetail()`.
- **Search and filters:** History and Contacts share `findBar(k, ...)` (search box + filter chips). State is `ui[k + 'q']` / `ui[k + 'f']` (`k` is `'h'` or `'c'`); the lists are live regions (`hlist`, `clist`) so typing doesn't lose focus. Reuse it for any new searchable list.
- **Actions:** clicks on any `[data-act="x"]` element call `A.x(dataset, element)`. Inputs with `data-in="..."` are handled in the single `input` listener. Add new buttons the same way.
- **Writes:** `setPaid()` (participants update), `saveContact()` / `deleteContact()` and `saveGroup()` / `deleteGroup()` (RPCs). Pattern: set `ui.saving`, call Supabase, check `error` with the `need()` helper, update `S` from **what Supabase returned**, then `toast()`. On error, keep the user's typed input and show the message.
- **Split math:** `calc(draft)` handles per-person pre-tax shares, proportional tax/tip/fees, unassigned items and the receipt-total mismatch check. All in cents.

Conventions to keep:
- Escape every user-provided string with `esc()` before putting it in HTML.
- IDs from the database are numbers; the UI compares them as **strings** (they come back from `data-*` attributes). Convert at the boundary (`String(id)` / `Number(id)`).
- Colors and fonts are CSS custom properties in `:root`, with light and dark values. Use the tokens, not hard-coded colors.
- `.screen > *` has `flex-shrink: 0` on purpose, so long lists scroll instead of being clipped. Don't remove it.
- Keep visible states for loading, empty, error and invalid input; the course grades them.

**Receipt scanning:** Take photo opens an in-page camera on secure origins; HTTP phone LAN URLs and unsupported devices use the native picker. Upload photo accepts an image. Tesseract.js 7 reads it locally in a browser worker; `parseReceiptText()` creates editable candidates. Review against the photo: the parser handles English receipts with explicit dollar prices, not every layout. Cancellation/errors preserve the earlier draft. Photos stay in memory, not Supabase or localStorage. There is no built-in sample receipt: later split screens with an empty draft redirect to Check the items (`go()`), and old saved drafts marked `fromSample` are dropped on load. Don't add preloaded data.

The real camera stream is transient in `cameraSession`; never store streams/device IDs in the draft or Notion. Request video only, prefer the rear camera, and start on Start split (a user action). Keep Resume current split separate and preserve its draft. Use a portrait preview with compact bottom controls. Nick now wants captures to match the visible preview: `cameraPreviewCrop()` matches the stream aspect then the centered object-fit:cover area, using geometry captured on the shutter tap. Both still and video captures go through `cameraFrameBlob()` before OCR; do not silently fall back to an uncropped image on crop/decode failure. Release temporary still-image URLs even on cancellation. Native-picker images/uploads retain their own framing. Nick corrected his earlier always-on light preference: keep preview light off; use still flash or a brief supported torch pulse only at capture, with a manual off control and native fallback. Stop tracks on capture, close, navigation, hidden tab and unload, including late permission/capture results. Turn a pulsed torch off on success/failure before OCR or retry. Do not restore simulated preview/scanner animations.

`shortReceiptName()` performs local conservative name cleanup on new OCR drafts or explicit Shorten item names: removes obvious long numeric/product codes, expands common abbreviations, retains up to three words and keeps unknown all-code labels rather than guessing products. Preserve meaningful short numbers and every price/ID/assignment. Original changed labels live only in transient `ui.originalNames`, with review/restore controls until refresh; do not persist raw OCR/source labels, transmit them to an AI service or retroactively alter user names without an action. Chosen editable item names continue using normal draft storage.

`scripts/start-https-preview.ps1` prepares temporary Cloudflare HTTPS access restricted to one exact email. It fails closed if `--allowed-mail` is unavailable and isolates tunnel configuration. Obtain explicit approval before an agent starts this externally reachable preview under the publishing rule below. Never use an unprotected public tunnel for the shared team app, or commit executable binaries, sign-in codes or `.env` values. Phone camera/flash capability still needs real-device verification; mocked camera tests are not hardware evidence.

**Draft tips:** `tipMode` is null (unselected), `percent`, or `amount`. `tipPct` holds a selected preset; `tipInput` holds the raw custom dollar input so invalid edits remain visible. `tipState()` validates and converts money; `calc()` allocates its cents proportionally. No tip is added by default. Invalid custom amounts must block both Review → People and Send. `normalizeTipDraft()` clears old tip choices once while preserving all receipt work; explicit new choices persist. This is local draft behavior, not a database migration or new-split persistence.

Empty reads, missing totals and items that do not reconcile with the printed total trigger one retry in single-column mode with skew correction and Sauvola thresholding. `preferReceiptRead()` selects one complete result by reconciliation; do not merge item arrays across readings, since repeated products are valid. Failed reads expose escaped OCR text in a collapsible panel. Keep that raw text transient in `ui.scanText`, never in the saved draft, logs, shared data or Notion; distinguish no readable text from no parsed prices.

Groups are owned through `friend_groups.user_id`; the database returns only the user's own groups, including empty ones, so `loadAll()` doesn't filter them.

**Payment requests:** `requestTarget()` validates one debtor contact, `paymentRequest()` builds a provider handoff and `preparedRequests()` snapshots exact shares/notes. Venmo uses a best-effort charge link; PayPal opens Request with copyable details; Zelle requests are completed in the bank's app; SMS opens a draft. `requestCard()` supplies clipboard/manual details. History reminders use the same handoff. Never infer sent/paid from navigation, copying, timers or returning to the page: there is no provider callback. Do not make a PayPal.Me link with the debtor's account (that would pay the wrong person). `V.sent` hides stale snapshots after edits. Return home preserves the draft; new splits are not saved to History yet. Legacy simulated results are discarded. No SQL/provider credentials are needed. Send no real requests during agent testing.

**Group editing:** Contacts has New group and editable group bubbles. `openGroup()` snapshots name/members into `ui.sheet.draft`; `groupSheet()` and `groupMembers()` render the editor/search. `saveGroup()` calls the existing RPC and reads back the row through `groupFromRow()`. A returned ID is kept after readback failure to avoid duplicate creates. `deleteGroup()` requires the in-sheet confirmation and preserves contacts/history/drafts. Errors retain form state; saving blocks duplicate submissions, and responses for a different account are ignored. No new SQL is needed. `test/groups.test.js` covers these flows with isolated data. The team's exported ERD still needs its human-owned group-ownership update below.

Additional draft request methods are Cash App (`cashapp`, $cashtag/email/U.S. phone, minimum $1), Apple Cash (`applecash`, uses `phone`, Messages draft plus native Apple Cash Request instructions) and Cash (`cash`, no electronic contact/link). Apple Cash is not Apple Pay merchant checkout, and an SMS draft is not an Apple Cash request. Cash App's provider-created request links may accept Apple Pay/Google Pay; never synthesize a pay-the-debtor $cashtag link. No lookup rows or SQL were changed: Cash App details live in the local split; the saved Contacts editor still reflects `S.payMethods` from Supabase. Keep physical-device verification separate from software checks.

## Group editor database contract and maintenance

Contacts now supports creating, editing and deleting groups. **The existing database functions are already live on the shared Supabase project** (`supabase/private-data.sql`), according to the team's setup record. Do not write new SQL, table grants or policies for this feature, and do not ask your human to run any SQL. If something seems to need a database change, stop and ask Jackson first. Isolated software/preview checks do not independently verify the live deployment.

**What already exists in the database**

- `friend_groups.user_id`: the owner of each group. The security rules return only the signed-in user's own groups (empty ones too), and `group_members` rows only where both the group and the contact are the user's.
- `save_group(p_group_id integer, p_name text, p_contact_ids integer[])` returns the group's id.
  - `p_group_id = null` creates a group; a number edits that group.
  - `p_contact_ids` is the **complete** member list. It replaces the old list; it is not "add these". An empty array `[]` is allowed (an empty group). Duplicates are ignored.
  - It trims the name and refuses a blank one. It refuses contacts that aren't the user's, and groups that aren't the user's. Error messages are written for users: "Add a group name.", "One of those contacts no longer exists. Refresh the page and try again.", "That group no longer exists."
- `delete_group(p_group_id integer)` deletes the group and its member list. The contacts themselves are kept. Groups aren't linked to past splits, so deleting one never changes History.
- Deleting a contact already removes them from every group (the database does it, and `deleteContact()` updates `S.groups`).

**Frontend steps (`public/app.html`)**

1. Call the functions from the browser, following the same pattern as `saveContact()` / `deleteContact()`:

   ```js
   const id = need(await sb.rpc('save_group', {p_group_id: groupId ? Number(groupId) : null, p_name: name, p_contact_ids: memberIds.map(Number)}));
   const row = need(await sb.from('friend_groups').select('group_id, group_name, group_members(contact_id)').eq('group_id', id).single());
   ```

   Then update `S.groups` from `row` (shape: `{id:String, name, members:[String contact ids]}`, same as `loadAll()`), close the sheet and `toast()`. For delete: `need(await sb.rpc('delete_group', {p_group_id: Number(groupId)}))`, then remove it from `S.groups`.
2. Group bubbles and New group on Contacts use `data-act="sheet" data-s="group"`, routed through `openGroup()`. Keep the group name, member picker and search in the group sheet. Use `data-act` / `A.x` for buttons, `esc()` for names and the existing CSS tokens. Preserve checkbox focus when updating the selected count; searching must not discard hidden selections.
3. Keep the visible states the course grades: saving (`ui.saving`, disabled buttons), errors shown in the sheet with the user's typed name and selections kept, an empty state when there are no groups yet, and a confirm step before delete (the `confirm` sheet type exists).
4. The user's own "You" contact is not in `S.contacts`, so it can't be picked as a member. Keep it that way unless the team decides otherwise.
5. Keep the README and in-app feature descriptions consistent with the editor; group changes are saved through the existing RPCs, not directly to tables.

**Update the ERD (required; the README's ERD section is graded)**

The database now has a column the team's ERD doesn't show yet. Your human (not the AI) updates the diagram, because the team owns it:

1. In the ERD tool the team used, add **`UserID` (FK → `Users.UserID`) to `Friend_Groups`**, with a **one-to-many** line from Users to Friend_Groups (one user owns many groups; each group has exactly one owner, required).
2. Export it again over **`docs/ioya-erd.pdf`** and **`docs/ioya-erd.png`** (the README shows the PNG).
3. In `README.md` → ERD:
   - add the row `| Users → Friend_Groups | one-to-many | \`Friend_Groups.UserID\` |` to the "Relationships and cardinality" table;
   - in the **Accounts** paragraph, remove `friend_groups.user_id` from the list of columns that are "not in the ERD yet" (`users.auth_user_id` stays there unless the team adds it too).
4. In this file's Data model table, remove "(not in the ERD yet)" from the `friend_groups` row.

**Testing the group editor**

- Add tests in `test/accounts.test.js` style (the fake Supabase there already takes a `groups` option) for: creating a group shows it, editing replaces the members, deleting removes it, and an error keeps what was typed.
- In the app: create a group with 2 test contacts, refresh (it must still be there), edit its name and members, refresh again, then delete it. Also try a blank name and check the error. Check the rows in Supabase's Table Editor (`friend_groups.user_id` should be your guest's `user_id`). Delete your test data afterwards.
- Run `npm test` and the normal click-through in "Testing your change" below.
- Before the PR, update the AI disclosure list with what the AI built.

## Testing your change

`npm test` runs the automated tests (receipt parsing, the split flow, payment requests, profile and login, the landing page, the admin pages and the login cookies) against fake data; it never touches Supabase, and it does not replace browser/real-phone checks. All tests must pass before a PR. Before handing work back:

1. Check the script parses (or just load the page and check the browser console for errors).
2. Run `npm start`, open http://localhost:3001/app, and click through what you changed **and** Home → History → Contacts → one split flow. If you touched the landing page or admin pages, also check http://localhost:3001 (log in and out) and http://localhost:3001/admin.
3. For data changes: do it, **refresh the page**, confirm it persisted, and check the row in Supabase's Table Editor. Undo test data afterwards (for example, delete the test contact, or "Mark as unpaid").
4. Check both a phone width (Chrome DevTools device toolbar) and a laptop width.

## Git workflow

The team works on **short-lived branches, one per task**, and merges into `main` through pull requests. `main` holds the graded app and README, so it must always run. Don't commit directly to `main`; GitHub is set to require a pull request for it.

**For each task:**

1. Start from the latest `main`:

   ```bash
   git switch main
   git pull
   ```

2. Create a branch named after the task (lowercase, hyphens), not after the person:

   ```bash
   git switch -c history-search-bar
   ```

3. Make the change, test it (see "Testing your change"), and commit in small steps with plain, descriptive messages.
4. Before pushing, bring in anything merged to `main` since you started, and fix any conflicts locally:

   ```bash
   git fetch origin
   git merge origin/main
   ```

5. **Ask your human before pushing.** Then push the branch:

   ```bash
   git push -u origin history-search-bar
   ```

6. Open a pull request into `main` (GitHub shows a "Compare & pull request" button after the push, or use `gh pr create` if the GitHub CLI is installed). In the description, say what changed, how you tested it, and whether any SQL must be run in Supabase. Ask a teammate to look at it or run it.
7. After it is merged, delete the branch and switch back:

   ```bash
   git switch main
   git pull
   git branch -d history-search-bar
   ```

**Rules:**

- Keep branches small and merge them within a day or two. Almost everything is in one file (`public/app.html`), so long-running branches turn into painful merge conflicts. Tell the team before starting a large change to a shared area.
- When resolving a conflict, keep both teammates' work unless your human says otherwise, then re-test the app before committing the merge.
- Never commit `.env`, keys, or `node_modules` (all in `.gitignore`). Before committing, check that `git diff --cached` contains no Supabase URL or key.
- **Ask your human before every `git push`**, before opening or merging a pull request, and before anything else that leaves their computer. Never force-push (`git push --force`) or rewrite history on `main`.
- **Do not add AI co-author or "Generated with" lines** to commits or PRs unless your human explicitly asks; the team wants work attributed to the teammate only.
- If you change setup steps, the data model, or how the vertical slice works, update `README.md` too (it is graded and must keep these sections: App Summary, ERD, Tech Stack, How to Get It Running, Verifying the Vertical Slice).

## Course rules (important)

This is graded coursework.
- Some assignments require the **testing and written analysis to be done by the students themselves** (for example, the Design Readiness Review: keyboard, screen reader and Lighthouse testing). You may explain how to do something or fix code, but do not write findings, test results or narrative for those assignments.
- Submissions need an **AI disclosure statement**. Help your human keep track of what you built or changed for them so they can disclose it accurately.
