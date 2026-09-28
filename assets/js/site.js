/* Logic Nerds: site script */

/* Checkout links.
   Paste each payment link (Stripe Payment Link, Lemon Squeezy, Gumroad, etc.)
   between the quotes. Every button on the site with a matching data-buy value
   picks it up. Buttons with an empty link stay visible but inactive. */
var BUY_LINKS = {
  "pipeline-health": "",
  "win-loss-velocity": "",
  "leads-top-of-funnel": "",
  "accounts-activity": "",
  "all-four": ""
};

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
