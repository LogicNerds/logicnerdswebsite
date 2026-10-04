/* Logic Nerds: site script */

/* Checkout links.
   Stripe Payment Links, one per product. To change a price, create a new
   payment link in Stripe and paste its URL here. Every button on the site with a matching data-buy value
   picks it up. Buttons with an empty link stay visible but inactive. */
var BUY_LINKS = {
  "pipeline-health": "https://buy.stripe.com/6oUbIU3cMdzI5z98TT28800",
  "win-loss-velocity": "https://buy.stripe.com/00w5kw8x60MW7Hhfih28801",
  "leads-top-of-funnel": "https://buy.stripe.com/6oU5kw00A67g9Pp6LL28802",
  "accounts-activity": "https://buy.stripe.com/eVq14g14E8fo0eP6LL28803",
  "all-four": "https://buy.stripe.com/8x228kaFe1R01iT9XX28804"
};

/* Analytics events (Google Analytics 4).
   buy_click: a buy button, with the product key
   book_call_click: any link to the booking calendar
   email_click: any mailto link
   purchase_page: the post-checkout /thanks/ page (Stripe sends buyers here after paying) */
(function () {
  function track(name, params) {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  }
  if (location.pathname.indexOf("/thanks") === 0) {
    track("purchase_page", { has_session: /[?&]session_id=/.test(location.search) });
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (a.hasAttribute("data-buy")) {
      track("buy_click", { product: a.getAttribute("data-buy"), page: location.pathname });
    } else if (href.indexOf("calendar.app.google") !== -1) {
      track("book_call_click", { page: location.pathname });
    } else if (href.indexOf("mailto:") === 0) {
      track("email_click", { page: location.pathname });
    }
  });
})();

(function () {
  // Buy buttons
  var buttons = document.querySelectorAll("[data-buy]");
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    var url = BUY_LINKS[btn.getAttribute("data-buy")];
    if (url) {
      btn.setAttribute("href", url);
    } else {
      btn.classList.add("is-pending");
      btn.setAttribute("aria-disabled", "true");
      btn.setAttribute("title", "Checkout isn't open yet");
      btn.addEventListener("click", function (e) { e.preventDefault(); });
    }
  }

  // Mobile menu
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  function setOpen(open) {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  toggle.addEventListener("click", function () {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
})();
