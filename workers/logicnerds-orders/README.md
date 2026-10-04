# logicnerds-orders

Cloudflare Worker that emails report pack buyers their install links after a Stripe checkout, and sends Logic Nerds a sale notice.

- Accepts only Stripe-signed webhooks (`checkout.session.completed`, `checkout.session.async_payment_succeeded`).
- Reads the order's products from Stripe (`site_key` metadata on each product): a single pack gets 1 install link, the four-pack bundle gets 4.
- Sends through Resend with idempotency keys, so Stripe retries never send duplicates.
- If an install link isn't set yet, the buyer email is held and the sale notice says "ACTION NEEDED" so the links can be sent by hand.

## Settings

| Name | Type | Value |
|---|---|---|
| STRIPE_SECRET_KEY | secret | Restricted key, read: Checkout Sessions, Products |
| STRIPE_WEBHOOK_SECRET | secret | Signing secret from the Stripe webhook endpoint |
| RESEND_API_KEY | secret | Same key the old mailer used |
| ORDERS_FROM, REPLY_TO, NOTIFY_TO, SITE_URL | vars | In wrangler.toml |
| LINK_PIPELINE_HEALTH, LINK_WIN_LOSS_VELOCITY, LINK_LEADS_TOP_OF_FUNNEL, LINK_ACCOUNTS_ACTIVITY | vars | Package install links, set in the Cloudflare dashboard |

## Deploy

```
cd workers/logicnerds-orders
npx wrangler deploy
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
```
