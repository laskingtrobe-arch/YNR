# YnR Back End

Catalogue, one-of-one stock control, orders, Paystack checkout, and an admin
panel for the YnR storefront.

Node 22+, Postgres (via a connection string — this was built against Supabase,
but connects the standard way, so any Postgres works).

## Quick start

```bash
cd server
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Supabase connection string
# (Project Settings -> Database -> Connection string -> URI)
npm run seed                       # loads the 6 existing pieces + delivery zones
npm run create-admin you@email.com # prints a generated password once
npm start
```

- API: http://localhost:4000
- Admin: http://localhost:4000/admin
- Health: http://localhost:4000/api/health

```bash
npm test
```

Runs an end-to-end smoke test against `pg-mem`, an in-memory Postgres-compatible
engine (dev dependency only, never used outside this harness): 43 checks
covering the hold race, webhook signatures, payment fulfilment and admin auth.
No real database needed to run it.

## How the important parts work

### One-of-one stock
Every piece exists once, so two people must never both be told yes. A hold is
taken with a single conditional `UPDATE`, so the check and the claim cannot
interleave. Holds expire after `HOLD_MINUTES` (default 30) and a sweeper
returns abandoned pieces to the shop every minute.

A held piece still appears in the shop. Only checkout is blocked, so a second
customer can still enquire.

### Orders are recorded before the handoff
The order row is written **before** the customer is sent to WhatsApp or
Paystack. Line items store a frozen copy of name, size and price, so changing a
product's price later never rewrites historic orders.

Money is stored as an integer number of kobo everywhere. There are no floats in
any currency column.

### Payment
`POST /api/payments/init` reads the amount **from the database**, never from the
browser, then asks Paystack for a checkout URL.

The webhook at `POST /api/payments/webhook`:

1. Is mounted with `express.raw()` **before** the JSON body parser. Paystack
   signs the exact bytes it sent, so re-serialising the body would break every
   signature check.
2. Verifies the `x-paystack-signature` header as an HMAC **SHA512** (not SHA256)
   of the raw body using the secret key, compared in constant time.
3. Only then records the event under its dedupe key. Rejected requests are
   logged under a throwaway key, so a forged webhook cannot claim a real
   order's key and block the genuine one that follows.
4. Re-verifies the amount directly with Paystack before granting value, and
   refuses to fulfil an underpayment.

Replayed webhooks are safe: fulfilment is idempotent.

### Mock payments
`PAYSTACK_MODE=mock` lets the whole checkout be exercised with no keys and no
real money. It is forced off when `NODE_ENV=production`, so it cannot ship by
accident.

### Mail
With no `SMTP_URL`, mail is written to the `mail_outbox` table and logged rather
than silently dropped. Wiring a real transport is one function in
`src/services/index.js`.

### Database
Postgres, connected with a plain connection string rather than the Supabase
SDK — nothing here is Supabase-specific beyond where `DATABASE_URL` points, so
any Postgres works. `src/db.js` exposes `get`/`all`/`run`, async equivalents of
the query shapes used throughout the routes, plus `transaction(fn)`: runs `fn`
against one dedicated connection wrapped in `BEGIN`/`COMMIT`, rolling back
automatically if it throws. Anything that touches a one-of-one hold alongside
another write — placing an order, cancelling one — goes through it, because a
hold taken on a different connection than the rest of that unit of work would
not be undone by that transaction's rollback.

## API

### Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/products` | Catalogue, `?category=tees` |
| GET | `/api/products/:slug` | One piece plus related |
| GET | `/api/categories` | Categories |
| GET | `/api/delivery-zones` | Zones and fees |
| POST | `/api/orders` | Create an order, returns reference + WhatsApp link |
| GET | `/api/orders/:reference` | Customer order lookup, no account needed |
| POST | `/api/payments/init` | Start a Paystack checkout |
| POST | `/api/payments/webhook` | Paystack webhook (signed) |
| GET | `/api/payments/callback` | Browser return after payment |
| POST | `/api/contact` | Contact form |
| POST | `/api/newsletter` | Subscribe (double opt-in) |
| GET | `/api/newsletter/confirm` | Confirm subscription |
| GET | `/api/newsletter/unsubscribe` | Unsubscribe |
| POST | `/api/repaint` | Request a repaint of a sold piece |

### Admin (session cookie required)
`POST /api/admin/login` · `POST /api/admin/logout` · `GET /api/admin/me` ·
`GET /api/admin/stats` · `GET|POST /api/admin/products` ·
`PATCH|DELETE /api/admin/products/:id` · `POST /api/admin/products/:id/status` ·
`POST /api/admin/products/:id/images` · `DELETE /api/admin/images/:id` ·
`GET /api/admin/orders` · `PATCH /api/admin/orders/:id` ·
`GET /api/admin/messages` · `GET /api/admin/subscribers` ·
`GET /api/admin/repaints` · `GET /api/admin/audit` · `POST /api/admin/broadcast`

## Going live

1. Set `NODE_ENV=production`, a real `DATABASE_URL`, and a `SESSION_SECRET`.
   The server refuses to boot without any of these three — a missing database
   or a forgeable session cookie are not conditions to run in.
2. Paystack is not required to boot. Register the business with CAC and get a
   Paystack account approved when ready — this alone can take days to weeks —
   and the shop takes orders and confirms them on WhatsApp until then. Once
   approved, set `PAYSTACK_SECRET_KEY` and remove `PAYSTACK_MODE=mock`.
3. Point the Paystack dashboard webhook at
   `https://your-domain/api/payments/webhook`.
4. Configure `SMTP_URL` and add SPF, DKIM and DMARC records, or order emails
   will land in spam.
5. Serve over HTTPS. Session cookies set `secure` in production and will not be
   sent over plain HTTP.
6. Back up `uploads/` on a schedule. The database is on Supabase, which takes
   its own backups — check the plan's retention window, and consider Point in
   Time Recovery if the shop's order history needs a tighter one.

## Not built yet

Deliberately left out, in rough priority order:

- Server-side image resizing (`sharp`). Uploads are validated and stored at
  original size, so large photos will be slow on mobile data.
- Real SMTP transport. The outbox records mail but nothing sends it.
- Refunds through the API. Refund in the Paystack dashboard, then set the
  order's payment status in admin.
- Per-size stock, if a piece ever becomes several physical garments.
- Moving uploads to Supabase Storage. They are still local disk (see
  `UPLOADS_DIR`), which is the one thing still keeping this off a fully
  serverless host — everything else the database now needs is already a
  network call.
