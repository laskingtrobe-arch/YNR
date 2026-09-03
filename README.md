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

server/              The back end (Node + Express + SQLite)
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
