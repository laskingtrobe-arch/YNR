# YnR Back End

Catalogue, one-of-one stock control, orders, Paystack checkout, and an admin
panel for the YnR storefront.

Node 22+ (uses the built-in `node:sqlite`, so there is no native module to
compile and no database server to run).

## Quick start

```bash
cd server
npm install
cp .env.example .env
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

Runs an end-to-end smoke test against a throwaway database: 43 checks covering
the hold race, webhook signatures, payment fulfilment and admin auth.

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

1. Register the business with CAC and get a Paystack account approved. This
   takes days to weeks and gates everything else about payment.
2. Set `NODE_ENV=production`, a real `PAYSTACK_SECRET_KEY`, and a
   `SESSION_SECRET`. The server refuses to boot without them.
3. Remove `PAYSTACK_MODE=mock`.
4. Point the Paystack dashboard webhook at
   `https://your-domain/api/payments/webhook`.
5. Configure `SMTP_URL` and add SPF, DKIM and DMARC records, or order emails
   will land in spam.
6. Serve over HTTPS. Session cookies set `secure` in production and will not be
   sent over plain HTTP.
7. Back up `data/ynr.db` and `uploads/` on a schedule, and test a restore.

## Not built yet

Deliberately left out, in rough priority order:

- Server-side image resizing (`sharp`). Uploads are validated and stored at
  original size, so large photos will be slow on mobile data.
- Real SMTP transport. The outbox records mail but nothing sends it.
- Refunds through the API. Refund in the Paystack dashboard, then set the
  order's payment status in admin.
- Per-size stock, if a piece ever becomes several physical garments.
- Server-side image resizing, noted above, is the main gap for mobile data.
