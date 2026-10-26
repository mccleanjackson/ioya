# AGENTS.md: guide for AI coding assistants working on IOYA

This file is for AI assistants (Claude Code, Copilot, Cursor, Codex, etc.) helping a member of the IOYA team. Read it fully before making changes. The human-facing setup guide is [README.md](README.md); this file adds the context an assistant needs to work safely.

## What IOYA is

IOYA is a bill-splitting web app built by a four-person student team (Jackson, Tye, Nick, Tanner) for BYU IS 401. The payer scans a receipt, assigns line items to friends (shared items split evenly), tax/tip/fees are split in proportion to what each person ordered, and the app tracks who has paid back. It is a class project with real grading constraints (see "Course rules" below).

## Stack (keep it this simple unless the team decides otherwise)

| Layer | What | Where |
|---|---|---|
| Frontend | One file of plain HTML, CSS and vanilla JavaScript. No framework, no build step. | `public/index.html` |
| Data + API | Supabase (hosted PostgreSQL + auto REST API), called with `supabase-js` v2 loaded from jsDelivr | `supabase/*.sql` |
| Web server | Node 18+ / Express 5, ~25 lines. Serves `public/` and `GET /config.js`, which injects the Supabase URL and anon key from `.env` so they are never committed. | `server.js` |

Port: **3001** (3000 is used by another project on Jackson's machine).

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

4. Start the server, then open http://localhost:3001:

   ```bash
   npm start
   ```

   `npm run dev` restarts on file changes. If it exits with "Missing SUPABASE_URL or SUPABASE_ANON_KEY", `.env` is missing or misnamed.

5. The team shares **one** Supabase project. Anything saved from the app (contacts, "Mark as paid") is real shared data that teammates see. Test with obviously fake names and clean up after yourself.

## Repository layout

```
server.js                   Express: static files + /config.js (reads .env)
public/index.html           The entire frontend (~1,150 lines)
supabase/schema.sql         Creates all 11 tables, RLS policies and the contact functions. DROPS tables first.
supabase/seed.sql           Sample rows for every table (run after schema.sql)
supabase/contacts-sync.sql  Migration that adds save_contact/delete_contact to an older project
docs/ioya-erd.pdf / .png    The team's ERD (the source of truth for the data model)
README.md                   Human setup guide + course deliverable (graded; keep its 5 sections)
.env.example                Template for .env
```

## Data model

The schema follows the team's ERD (`docs/ioya-erd.pdf`). ERD names are PascalCase; the database uses snake_case (`Users.UserFirstName` → `users.user_first_name`). Money is **always integer cents** (`1959` = $19.59).

| Table | Key | Notes |
|---|---|---|
| `users` | `user_id` | No login yet: the app always acts as `user_id = 1` ("Demo Payer"). |
| `contacts` | `contact_id` | `user_id` FK. The payer also has a contact row with the **same first name, last name and phone** as their `users` row; the app finds it by that match and shows it as "You". Don't break that match. |
| `friend_groups` / `group_members` | `group_id` / (`group_id`, `contact_id`) | Groups ↔ contacts, many-to-many |
| `payment_methods` | `pay_method_id` | Lookup: 1 Venmo, 2 PayPal, 3 Zelle, 4 Cash |
| `contacts_payment_method` | (`contact_id`, `pay_method_id`) | Username per method; `is_preferred` (at most one per contact, enforced by a partial unique index) |
| `events` | `event_id` | One outing; can hold several receipts |
| `receipts` | `receipt_id` | `event_id`, `payer_user_id`; `tax_cents`, `fees_cents`, `tip_percent`, `tip_cents`, `total_cents` (printed total = items + tax + fees, before tip) |
| `line_items` | `item_id` | `receipt_id`, `description`, `price_cents`, `position` |
| `participants` | (`contact_id`, `event_id`) | `paid_method_id` is **NULL while unpaid**; set = paid, and records how |
| `item_assignments` | (`contact_id`, `item_id`) | `share_cents` per person per item |

Amount owed is **not stored**; it is computed from `item_assignments` plus a proportional share of tax + fees + tip (largest-remainder rounding so totals match to the cent). See `owedByContact()` and `calc()`.

## Security rules (Row Level Security): read before adding any write

The browser uses the public **anon** key, so RLS is the only protection. Current rules (defined at the bottom of `schema.sql` and in `contacts-sync.sql`):

- anon can **SELECT** every table;
- anon can **UPDATE only `participants.paid_method_id`** (the "Mark as paid" button);
- anon can add/edit/delete contacts **only** through two `SECURITY DEFINER` functions: `save_contact(p_contact_id, p_first_name, p_last_name, p_phone, p_methods jsonb)` and `delete_contact(p_contact_id)`. Direct INSERT/DELETE on tables is revoked. `delete_contact` refuses contacts who are on a past split.

**Any new feature that writes data needs a database change first.** The preferred pattern is a new `SECURITY DEFINER` function (validated, one transaction) granted to `anon`, not broad table grants. To ship it:

1. Write the SQL in a new file, `supabase/<feature>.sql`, written so it is safe to run more than once (`CREATE OR REPLACE`, `IF NOT EXISTS`).
2. Append the same SQL to `supabase/schema.sql` so fresh setups get it.
3. **A human must run it** in Supabase → SQL Editor. You cannot do it with the anon key. Tell your human exactly what to paste.
4. Check it from the app (or `curl` the REST API with the anon key) before calling it done.

Never run `schema.sql` against the shared project without the team agreeing. It drops every table and all real data.

## How `public/index.html` is organized

Single global state, string-template rendering, event delegation. No framework.

- **State:** `S` holds data loaded from Supabase plus the current `view` and the in-progress split `draft`. `ui` holds transient UI state (open sheet, toast, flags). Only `S.view` and `S.draft` are saved to `localStorage` (`ioya-draft-v1`).
- **Loading:** `loadAll()` fetches users, payment methods, contacts (`CONTACT_SELECT`), groups and events (nested receipts → line_items → item_assignments, plus participants) and rebuilds `S`. `normContact()` normalizes a contact row.
- **Views:** `V.home`, `V.history`, `V.contacts`, and the split flow `V.scan → V.scanning → V.review → V.people → V.assign → V.summary → V.sent` return HTML strings. `render()` draws the current view, tab bar, sheets and toast.
- **Live regions:** `LIVE[name]` functions fill `[data-live="name"]` elements via `refresh()`, so totals can update while the user types without re-rendering (which would steal focus).
- **Bottom sheets:** `sheetHTML()` switches on `ui.sheet.type` (`profile`, `contact`, `group`, `req`, `confirm`).
- **Actions:** clicks on any `[data-act="x"]` element call `A.x(dataset, element)`. Inputs with `data-in="..."` are handled in the single `input` listener. Add new buttons the same way.
- **Writes:** `setPaid()` (participants update), `saveContact()` / `deleteContact()` (RPCs). Pattern: set `ui.saving`, call Supabase, check `error` with the `need()` helper, update `S` from **what Supabase returned**, then `toast()`. On error, keep the user's typed input and show the message.
- **Split math:** `calc(draft)` handles per-person pre-tax shares, proportional tax/tip/fees, unassigned items and the receipt-total mismatch check. All in cents.

Conventions to keep:
- Escape every user-provided string with `esc()` before putting it in HTML.
- IDs from the database are numbers; the UI compares them as **strings** (they come back from `data-*` attributes). Convert at the boundary (`String(id)` / `Number(id)`).
- Colors and fonts are CSS custom properties in `:root`, with light and dark values. Use the tokens, not hard-coded colors.
- `.screen > *` has `flex-shrink: 0` on purpose, so long lists scroll instead of being clipped. Don't remove it.
- Keep visible states for loading, empty, error and invalid input; the course grades them.

**What is simulated (not real yet):** receipt scanning/OCR (the shutter loads `SAMPLE`), sending Venmo/SMS/PayPal requests and reminders, and saving a new split (Done shows "New splits are not saved yet"). Groups can only be edited in the Supabase dashboard.

## Testing your change

There is no automated test suite. Before handing work back:

1. Check the script parses (or just load the page and check the browser console for errors).
2. Run `npm start`, open http://localhost:3001, and click through what you changed **and** Home → History → Contacts → one split flow.
3. For data changes: do it, **refresh the page**, confirm it persisted, and check the row in Supabase's Table Editor. Undo test data afterwards (for example, delete the test contact, or "Mark as unpaid").
4. Check both a phone width (Chrome DevTools device toolbar) and a laptop width.

## Git workflow

- `git pull` before starting. Almost everything is in one file (`public/index.html`), so merge conflicts are likely. Keep changes small and focused, and commit often.
- Never commit `.env`, keys, or `node_modules` (all in `.gitignore`). Before committing, check that `git diff --cached` contains no Supabase URL or key.
- **Ask your human before every `git push`**, and before anything else that leaves their computer.
- Write plain, descriptive commit messages. **Do not add AI co-author or "Generated with" lines** to commits or PRs unless your human explicitly asks; the team wants commits attributed to the teammate only.
- If you change setup steps, the data model, or how the vertical slice works, update `README.md` too (it is graded and must keep these sections: App Summary, ERD, Tech Stack, How to Get It Running, Verifying the Vertical Slice).

## Course rules (important)

This is graded coursework.
- Some assignments require the **testing and written analysis to be done by the students themselves** (for example, the Design Readiness Review: keyboard, screen reader and Lighthouse testing). You may explain how to do something or fix code, but do not write findings, test results or narrative for those assignments.
- Submissions need an **AI disclosure statement**. Help your human keep track of what you built or changed for them so they can disclose it accurately.
