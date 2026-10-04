/*
 * logicnerds-orders
 *
 * Receives Stripe webhooks for completed checkouts on logicnerds.net and
 * emails the buyer their install links, plus a sale notice to Logic Nerds.
 *
 * Only requests signed by Stripe are accepted. Emails go out through Resend.
 *
 * Secrets (set with `wrangler secret put` or in the Cloudflare dashboard):
 *   STRIPE_SECRET_KEY      restricted key: read access to Checkout Sessions and Products
 *   STRIPE_WEBHOOK_SECRET  the endpoint's signing secret (whsec_...)
 *   RESEND_API_KEY
 *
 * Variables (wrangler.toml or the Cloudflare dashboard):
 *   ORDERS_FROM            e.g. "Logic Nerds <orders@logicnerds.net>"
 *   REPLY_TO               where buyer replies go
 *   NOTIFY_TO              where sale notices go
 *   SITE_URL               https://www.logicnerds.net
 *   LINK_PIPELINE_HEALTH, LINK_WIN_LOSS_VELOCITY,
 *   LINK_LEADS_TOP_OF_FUNNEL, LINK_ACCOUNTS_ACTIVITY
 *                          package install links. If any link a buyer needs is
 *                          missing, the buyer email is held and the sale notice
 *                          says to send the links by hand.
 */

const PACKS = {
  "pipeline-health": { name: "Pipeline Health", linkVar: "LINK_PIPELINE_HEALTH", flows: 0 },
  "win-loss-velocity": { name: "Win/Loss & Velocity", linkVar: "LINK_WIN_LOSS_VELOCITY", flows: 0 },
  "leads-top-of-funnel": { name: "Leads & Top of Funnel", linkVar: "LINK_LEADS_TOP_OF_FUNNEL", flows: 1 },
  "accounts-activity": { name: "Accounts & Activity", linkVar: "LINK_ACCOUNTS_ACTIVITY", flows: 0 },
};
const BUNDLES = { "all-four": Object.keys(PACKS) };

const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });

    const payload = await request.text();
    const verified = await verifyStripeSignature(
      payload,
      request.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET
    );
    if (!verified) return new Response("Invalid signature", { status: 400 });

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return new Response("Bad payload", { status: 400 });
    }
    if (!HANDLED_EVENTS.has(event.type)) return new Response("Ignored", { status: 200 });

    const session = event.data && event.data.object;
    // "no_payment_required" covers 100%-off promo codes.
    if (!session || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) {
      return new Response("Not paid yet", { status: 200 });
    }

    try {
      await handlePaidSession(session, env);
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Order handling failed", session.id, err && err.stack ? err.stack : err);
      // 500 makes Stripe retry. Resend idempotency keys stop duplicate emails.
      return new Response("Error", { status: 500 });
    }
  },
};

async function handlePaidSession(session, env) {
  const siteKeys = await getSiteKeys(session.id, env);
  const packKeys = [];
  const unknown = [];
  for (const key of siteKeys) {
    if (PACKS[key]) packKeys.push(key);
    else if (BUNDLES[key]) packKeys.push(...BUNDLES[key]);
    else unknown.push(key);
  }
  const packs = [...new Set(packKeys)].map((key) => ({
    key,
    ...PACKS[key],
    link: (env[PACKS[key].linkVar] || "").trim(),
  }));

  const details = session.customer_details || {};
  const order = {
    id: session.id,
    email: details.email || session.customer_email || "",
    name: details.name || "",
    company: details.business_name || "",
    edition: customFieldLabel(session, "sfedition"),
    amount: formatMoney(session.amount_total, session.currency),
    packs,
    unknown,
  };

  const missingLinks = packs.filter((p) => !p.link);
  const canSendBuyer = order.email && packs.length > 0 && missingLinks.length === 0;

  if (canSendBuyer) {
    await sendEmail(env, {
      idempotencyKey: `buyer-${session.id}`,
      to: order.email,
      replyTo: env.REPLY_TO,
      subject: packs.length > 1 ? "Your Logic Nerds report packs" : `Your ${packs[0].name} report pack`,
      ...buyerEmail(order, env),
    });
  }

  await sendEmail(env, {
    idempotencyKey: `notify-${session.id}`,
    to: env.NOTIFY_TO,
    replyTo: order.email || undefined,
    subject: `${canSendBuyer ? "Sale" : "ACTION NEEDED: sale"}: ${packs.map((p) => p.name).join(", ") || siteKeys.join(", ") || "unknown product"}${order.company ? ` (${order.company})` : ""}`,
    ...notifyEmail(order, { canSendBuyer, missingLinks }),
  });
}

/* ---------- Stripe ---------- */

async function getSiteKeys(sessionId, env) {
  const url =
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items` +
    `?limit=100&expand[]=data.price.product`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe line items ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const keys = [];
  for (const item of body.data || []) {
    const product = item.price && item.price.product;
    const key = product && product.metadata && product.metadata.site_key;
    if (key) keys.push(key);
  }
  return keys;
}

export async function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300) {
  if (!header || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function customFieldLabel(session, key) {
  const field = (session.custom_fields || []).find((f) => f.key === key);
  if (!field || !field.dropdown) return "";
  const value = field.dropdown.value;
  const option = (field.dropdown.options || []).find((o) => o.value === value);
  return option ? option.label : value || "";
}

/* ---------- Resend ---------- */

async function sendEmail(env, { idempotencyKey, to, replyTo, subject, html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: env.ORDERS_FROM,
      to: [to],
      reply_to: replyTo || undefined,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/* ---------- Email content ---------- */

function buyerEmail(order, env) {
  const site = (env.SITE_URL || "https://www.logicnerds.net").replace(/\/$/, "");
  const first = order.name ? order.name.split(" ")[0] : "";
  const hasFlow = order.packs.some((p) => p.flows > 0);
  const multi = order.packs.length > 1;

  const packHtml = order.packs
    .map(
      (p) => `
      <tr><td style="padding:14px 0;border-top:1px solid #e2e5ea">
        <strong style="font-size:15px">${esc(p.name)}</strong><br>
        <a href="${esc(p.link)}" style="color:#1f5fa8">Install link</a>
        &nbsp;&middot;&nbsp;
        <a href="${esc(`${site}/guides/${p.key}/`)}" style="color:#1f5fa8">Action guide</a>
      </td></tr>`
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b2f36;line-height:1.55">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e5ea;border-radius:4px">
  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 16px;font-size:18px;font-weight:600">Thanks for your order${first ? `, ${esc(first)}` : ""}.</p>
    <p style="margin:0 0 16px">Here ${multi ? "are your install links" : "is your install link"}. Each pack also has an action guide on what to do with what the reports show.</p>
    <table role="presentation" width="100%">${packHtml}</table>
  </td></tr>
  <tr><td style="padding:8px 28px 28px">
    <p style="margin:16px 0 8px;font-weight:600">Before you install</p>
    <ul style="margin:0 0 16px;padding-left:20px">
      <li>Read the <a href="${esc(`${site}/install/`)}" style="color:#1f5fa8">install guide</a>. Each pack takes about 30 minutes to install and set up.</li>
      <li>Log in as a user who can install packages, usually a System Administrator.</li>
      <li>If you have a sandbox, install there first. Change login.salesforce.com in the link to test.salesforce.com.</li>
      ${hasFlow ? `<li>Leads &amp; Top of Funnel adds 1 record-triggered flow. Check you have room first: <a href="${esc(`${site}/install/#flows`)}" style="color:#1f5fa8">how to check</a>.</li>` : ""}
    </ul>
    <p style="margin:0 0 8px">Questions about installing are answered by email for 30 days. Just reply to this email. Every pack has a 30-day money-back guarantee: <a href="${esc(`${site}/policies/#refunds`)}" style="color:#1f5fa8">refund policy</a>.</p>
    <p style="margin:16px 0 0;color:#6b7280;font-size:13px">Logic Nerds &middot; ${esc(site.replace(/^https?:\/\//, ""))}</p>
  </td></tr>
  </table></body></html>`;

  const text = [
    `Thanks for your order${first ? `, ${first}` : ""}.`,
    "",
    multi ? "Here are your install links:" : "Here is your install link:",
    "",
    ...order.packs.flatMap((p) => [p.name, `  Install link: ${p.link}`, `  Action guide: ${site}/guides/${p.key}/`, ""]),
    "Before you install:",
    `- Read the install guide: ${site}/install/ (about 30 minutes per pack)`,
    "- Log in as a user who can install packages, usually a System Administrator.",
    "- If you have a sandbox, install there first. Change login.salesforce.com in the link to test.salesforce.com.",
    ...(hasFlow ? [`- Leads & Top of Funnel adds 1 record-triggered flow. Check you have room first: ${site}/install/#flows`] : []),
    "",
    "Questions about installing are answered by email for 30 days. Just reply to this email.",
    `Every pack has a 30-day money-back guarantee: ${site}/policies/#refunds`,
    "",
    "Logic Nerds",
  ].join("\n");

  return { html, text };
}

function notifyEmail(order, { canSendBuyer, missingLinks }) {
  const rows = [
    ["Products", order.packs.map((p) => p.name).join(", ") || "none recognized"],
    ["Amount", order.amount],
    ["Buyer", order.name],
    ["Email", order.email],
    ["Company", order.company],
    ["Salesforce edition", order.edition],
    ["Checkout session", order.id],
  ];
  const problems = [];
  if (!canSendBuyer) {
    if (!order.email) problems.push("No buyer email on the checkout session.");
    if (order.packs.length === 0) problems.push("No recognized product on this order.");
    if (missingLinks.length) {
      problems.push(`Install link not set for: ${missingLinks.map((p) => p.name).join(", ")}. The buyer email was NOT sent. Send the links by hand.`);
    }
  }
  if (order.unknown.length) problems.push(`Unrecognized product keys: ${order.unknown.join(", ")}`);

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b2f36;line-height:1.5">
  ${problems.length ? `<p style="background:#fff3cd;padding:10px 12px;border-radius:3px"><strong>Action needed</strong><br>${problems.map(esc).join("<br>")}</p>` : `<p>The buyer has been emailed their install links.</p>`}
  <table cellpadding="4">${rows.map(([k, v]) => `<tr><td style="color:#6b7280">${esc(k)}</td><td>${esc(v || "-")}</td></tr>`).join("")}</table>
  </body></html>`;

  const text = [
    ...(problems.length ? ["ACTION NEEDED", ...problems, ""] : ["The buyer has been emailed their install links.", ""]),
    ...rows.map(([k, v]) => `${k}: ${v || "-"}`),
  ].join("\n");

  return { html, text };
}

function formatMoney(amount, currency) {
  if (typeof amount !== "number") return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency || ""}`.trim();
  }
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
