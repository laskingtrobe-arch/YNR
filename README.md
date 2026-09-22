# YnR — Young & Reckless

Hand-painted, one-of-one streetwear out of Mpape, Abuja.

This repository holds the online shop: the customer-facing storefront, the
back end that runs it, and the admin panel the shop is managed from.

## Layout

```
storefront/          The shop customers see
  index.html           Markup only. Five views: home, product, checkout,
                       order confirmation, contact
  css/store.css        All styling. Design tokens live in :root
  js/
    config.js          API location, WhatsApp number, storage keys
    util.js            Escaping, money formatting, image URLs
    api.js             The one place that talks to the server
    catalogue.js       Shop grid and product detail
    bag.js             Bag, persisted across visits
    checkout.js        Checkout form, order placement, payment handoff
    forms.js           Contact and newsletter
    app.js             View switching, DOM wiring, boot
  assets/products/     Product photography

server/              The back end (Node + Express + Postgres, on Neon)
  src/
    routes/            Public API, orders, payments, admin
    services/          Paystack, mail, holds, audit
    middleware/        Auth, rate limiting, errors, security headers
    lib/               Shared helpers
    db.js              Schema
    config.js          Environment
  public/admin/        Admin panel
  test/smoke.js        End-to-end tests
  seed.js              Loads the starting catalogue
  create-admin.js      Creates the admin account

docs/                Written documentation
  YnR-Backend-Manual.pdf    Plain-English build manual
  YnR-Backend-Manual.docx
```

## Running it locally

Two processes: the API, and a static server for the storefront.

**1. The back end**

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm run create-admin you@youremail.com
npm start
```

API on http://localhost:4000, admin panel at http://localhost:4000/admin.

**2. The storefront**

Any static server pointed at `storefront/` will do:

```bash
cd storefront && python -m http.server 3020
```

Then open http://localhost:3020.

The storefront finds the API automatically on localhost. In production both
are served from the same origin, so it uses `/api`. Override with
`window.YNR_API` if you need something else.

## Deploying

The shop needs two things running: a place to serve the storefront, and a
place to run the back end that remembers products, orders and stock. This is
the part that was missing — the storefront alone is an empty shop with no
catalogue and no working checkout.

There are two ways to do this. Pick one.

### Option A — one service, simplest

As of this commit, the Express server can serve the storefront itself, so
the whole shop (API, admin panel, storefront) runs as a single deployment on
one origin. No second host, no CORS, nothing to wire together.

**Render**, using the `render.yaml` already in this repo:

1. Create a Neon project and copy its Postgres connection string (shown
   directly on the project dashboard). Free tier is fine to start.
2. Push this repo to GitHub (already done).
3. On [render.com](https://render.com), New → Blueprint → pick this repo.
   Render reads `render.yaml` automatically.
4. It will ask for `DATABASE_URL` (paste the Neon string from step 1),
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OWNER_EMAIL` — fill these in.
   `PAYSTACK_SECRET_KEY` and `SMTP_URL` can be left blank for now; the shop
   works on WhatsApp-confirmed orders without them.
5. Deploy. The database is already durable on Neon; the persistent disk
   `render.yaml` requests is for uploaded product photos, so those survive
   every future redeploy too. **This is the part a plain free-tier host
   usually gets wrong.**
6. On first boot the server seeds the starting catalogue and creates the
   admin account from those env vars automatically — there is no shell step.
   Sign in at `https://<your-render-url>/admin`, then delete
   `ADMIN_PASSWORD` from Render's environment settings so it is not sitting
   there in plain text.

Any host that gives you a persistent disk and runs a long-lived Node process
works the same way: Railway, Fly.io, a VPS. The included `Dockerfile` covers
those.

### Option B — storefront on Vercel, back end elsewhere

If you want to keep the existing Vercel deployment for the storefront:

1. Deploy `server/` to Render (steps above) or similar. Note the URL it
   gives you, e.g. `https://ynr-shop.onrender.com`.
2. Add this to `vercel.json` so the storefront's `/api` calls are
   transparently sent to that server — no CORS, and no change needed to any
   JavaScript file:

   ```json
   "rewrites": [
     { "source": "/api/:path*", "destination": "https://ynr-shop.onrender.com/api/:path*" }
   ]
   ```
3. Redeploy the Vercel project so it picks up the change.
4. Set `SITE_URL` in the back end's environment to the Vercel URL, or the
   browser's CORS check will block every request.

### Why the back end still does not go on Vercel itself

The database is Postgres on Neon now, a real network service — the kind
of thing Vercel's serverless functions talk to all the time, and no longer a
reason on its own to rule Vercel out.

What still rules it out is uploads. Vercel's filesystem is read-only outside
of `/tmp`, and `/tmp` is wiped between invocations, but this server saves
uploaded product photos straight to local disk (`UPLOADS_DIR`). On Vercel
every photo would be gone on the next deploy, or sooner. That is the one
remaining piece: move uploads to object storage (Vercel Blob, or an
S3-compatible store like Cloudflare R2) and there is nothing left holding
this to a persistent-disk host. Until then, Option A or B's `server/`
deployment is where it needs to run.

## Tests

```bash
cd server && npm test
```

43 end-to-end checks against a throwaway database, covering the one-of-one
hold race, webhook signature rejection, payment fulfilment and admin auth.

## How the shop works

Every piece is one-of-one. There is exactly one of each, so the back end
takes a short hold on a piece while someone is checking out, and releases it
if they wander off. Sold pieces stay on the site and switch to accepting
repaint requests.

Checkout records the order **before** handing the customer to Paystack or
WhatsApp, so an order always exists as a record even if payment never
completes. Prices are frozen onto the order at the moment it is placed.

Delivery inside Abuja is a flat fee. Everywhere else is quoted by hand on
WhatsApp, so card payment is deliberately unavailable for those orders until
a total is agreed.

See `docs/YnR-Backend-Manual.pdf` for the full explanation, written for
non-programmers.

## Not built yet

- Server-side image resizing, so large photos load slowly on mobile data
- A real mail transport: mail is recorded in an outbox table but not sent
- Refunds through the API (refund in the Paystack dashboard, then update the
  order in admin)
- Open Graph tags and a favicon, so shared links preview properly
