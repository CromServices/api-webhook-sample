/** Firm theme, hard-pinned to the immutable crom-shared v1.0.2 tag (light by default, dark by system setting). */
export const THEME_CSS_URL =
  "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/theme.css";

export const SOURCE_URL = "https://github.com/CromServices/api-webhook-sample";

/**
 * Crom header, inlined from crom-shared v1.0.2 snippets/header.html (no-JS copy
 * of header.js). Only change: the logo folder is the pinned v1.0.2 copy
 * (the header.js data-logo-base / CROM_LOGO_BASE override), so it can't drift.
 * Ink logo on light, white logo on dark, swapped by <picture> + prefers-color-scheme.
 */
export const CROM_HEADER = `
<header class="crom-header">
  <div class="crom-header__inner">
    <a class="crom-brand" href="https://cromservices.com.au/" rel="noopener noreferrer" aria-label="Crom Services home">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/brand/logo/crom-logo-v26-white.png">
        <img class="crom-logo" src="https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/brand/logo/crom-logo-v26-ink.png" width="526" height="481" alt="Crom Services" />
      </picture>
    </a>
    <span class="crom-tag">Sample · example project</span>
  </div>
</header>
`;

/**
 * Crom footer and credit, inlined verbatim from crom-shared v1.0.2
 * snippets/footer.html (no-JS copy of footer.js, so no layout shift).
 * theme.css shows the light or dark credit to match the visitor's system.
 */
export const CROM_FOOTER = `
<footer class="crom-footer">
  <p class="crom-footer__line">Crom Services · Australia · <a href="mailto:cromservices@gmail.com">cromservices@gmail.com</a></p>
  <div class="crom-footer__credit">
    <span class="crom-when-light">
      <a href="https://cromservices.com.au" target="_blank" rel="noopener noreferrer"
         aria-label="Built by Crom Services"
         style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#4a5752;font-family:Inter,system-ui,sans-serif;font-size:12px;font-weight:500;line-height:1;">
        <img src="https://cromservices.com.au/brand/credit/crom-credit-mark-ink@1x.png"
             srcset="https://cromservices.com.au/brand/credit/crom-credit-mark-ink@1x.png 1x, https://cromservices.com.au/brand/credit/crom-credit-mark-ink@2x.png 2x, https://cromservices.com.au/brand/credit/crom-credit-mark-ink@3x.png 3x"
             width="34" height="18" alt="" style="display:block;height:18px;width:auto;">
        <span>Built by Crom Services</span>
      </a>
    </span>
    <span class="crom-when-dark">
      <a href="https://cromservices.com.au" target="_blank" rel="noopener noreferrer"
         aria-label="Built by Crom Services"
         style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:#cdd6d1;font-family:Inter,system-ui,sans-serif;font-size:12px;font-weight:500;line-height:1;">
        <img src="https://cromservices.com.au/brand/credit/crom-credit-mark-white@1x.png"
             srcset="https://cromservices.com.au/brand/credit/crom-credit-mark-white@1x.png 1x, https://cromservices.com.au/brand/credit/crom-credit-mark-white@2x.png 2x, https://cromservices.com.au/brand/credit/crom-credit-mark-white@3x.png 3x"
             width="34" height="18" alt="" style="display:block;height:18px;width:auto;">
        <span>Built by Crom Services</span>
      </a>
    </span>
  </div>
</footer>
`;

type SampleBooking = {
  name: string;
  slot: string;
  service: string;
};

type BoardRow = SampleBooking & { step: 0 | 1 | 2 };

/** Sample studio bookings already on the board. Steps: 0 website, 1 on its way, 2 in the diary. */
const BOARD_ROWS: BoardRow[] = [
  { name: "Alex", slot: "Tue 10:00 am", service: "Cut and colour", step: 2 },
  { name: "Sam", slot: "Tue 11:30 am", service: "Blow dry", step: 2 },
  { name: "Riley", slot: "Tue 2:00 pm", service: "Trim", step: 1 },
  { name: "Jordan", slot: "Wed 9:15 am", service: "Colour", step: 0 },
];

/** Later sample bookings that take a row once the diary has caught up. */
const LATER_BOOKINGS: SampleBooking[] = [
  { name: "Casey", slot: "Wed 1:00 pm", service: "Treatment" },
  { name: "Morgan", slot: "Thu 9:45 am", service: "Restyle" },
  { name: "Alex", slot: "Tue 10:00 am", service: "Cut and colour" },
  { name: "Sam", slot: "Tue 11:30 am", service: "Blow dry" },
  { name: "Riley", slot: "Tue 2:00 pm", service: "Trim" },
  { name: "Jordan", slot: "Wed 9:15 am", service: "Colour" },
];

const ROW_GRID =
  "display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);gap:8px 16px;align-items:center;";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bookingRow(row: BoardRow): string {
  const arrived = row.step >= 2;
  const state = arrived ? "In the diary" : row.step === 1 ? "On its way" : "On the website";
  const name = esc(row.name);
  const slot = esc(row.slot);
  const service = esc(row.service);
  const detail = `${service} · ${name}`;
  const diarySlot = arrived ? slot : "Not there yet";
  const diaryDetail = arrived ? detail : "&#160;";
  const diaryColor = arrived ? "" : "color:var(--muted);";
  const rowBg = row.step === 1 ? "background:var(--soft);" : "";
  return `<div role="row" data-step="${row.step}" data-name="${name}" data-slot="${slot}" data-service="${service}" style="${ROW_GRID}${rowBg}padding:14px 0;border-bottom:1px solid var(--border);">
      <div>
        <div data-slot-line style="font-weight:500;">${slot}</div>
        <div class="crom-small" data-service-line>${detail}</div>
      </div>
      <div aria-hidden="true" style="color:var(--muted);font-weight:500;">→</div>
      <div data-diary>
        <div data-diary-slot style="font-weight:500;${diaryColor}">${diarySlot}</div>
        <div class="crom-small" data-diary-service>${diaryDetail}</div>
      </div>
      <div style="grid-column:1 / -1;"><span class="crom-chip" data-state>${state}</span></div>
    </div>`;
}

/**
 * Moves sample rows on the page: website → on its way → in the diary.
 * Stays still when the visitor prefers less motion. Wording stays outcome-only.
 */
function bookingScript(pool: SampleBooking[]): string {
  const data = JSON.stringify(pool.map((row) => [row.name, row.slot, row.service]));
  return `<script>
(function () {
  var board = document.getElementById("booking-sync");
  if (!board) return;
  var latest = document.getElementById("booking-latest");
  var pool = ${data};
  var next = 0;

  function paint(row) {
    var step = Number(row.getAttribute("data-step"));
    var name = row.getAttribute("data-name") || "";
    var slot = row.getAttribute("data-slot") || "";
    var service = row.getAttribute("data-service") || "";
    var slotLine = row.querySelector("[data-slot-line]");
    var serviceLine = row.querySelector("[data-service-line]");
    var diarySlot = row.querySelector("[data-diary-slot]");
    var diaryService = row.querySelector("[data-diary-service]");
    var state = row.querySelector("[data-state]");
    if (!slotLine || !serviceLine || !diarySlot || !diaryService || !state) return;
    var detail = service + " · " + name;
    slotLine.textContent = slot;
    serviceLine.textContent = detail;
    if (step >= 2) {
      row.style.background = "";
      diarySlot.textContent = slot;
      diarySlot.style.color = "";
      diaryService.textContent = detail;
      state.textContent = "In the diary";
      if (latest) latest.textContent = "Latest: " + name + ", " + slot + ", is in the diary.";
    } else if (step === 1) {
      row.style.background = "var(--soft)";
      diarySlot.textContent = "Not there yet";
      diarySlot.style.color = "var(--muted)";
      diaryService.textContent = "\\u00a0";
      state.textContent = "On its way";
      if (latest) latest.textContent = "Latest: " + name + ", " + slot + ", is on its way.";
    } else {
      row.style.background = "";
      diarySlot.textContent = "Not there yet";
      diarySlot.style.color = "var(--muted)";
      diaryService.textContent = "\\u00a0";
      state.textContent = "On the website";
      if (latest) latest.textContent = "Latest: " + name + ", " + slot + ", is on the website.";
    }
  }

  function tick() {
    var list = board.querySelectorAll("[data-step]");
    var open = null;
    var i;
    for (i = 0; i < list.length; i++) {
      if (Number(list[i].getAttribute("data-step")) < 2) {
        open = list[i];
        break;
      }
    }
    if (!open) {
      open = list[0];
      var used = {};
      for (i = 0; i < list.length; i++) used[list[i].getAttribute("data-name")] = true;
      var item = null;
      var guard = 0;
      while (guard < pool.length) {
        var candidate = pool[next % pool.length];
        next = next + 1;
        guard = guard + 1;
        if (!used[candidate[0]]) {
          item = candidate;
          break;
        }
      }
      if (!item) item = pool[0];
      open.setAttribute("data-name", item[0]);
      open.setAttribute("data-slot", item[1]);
      open.setAttribute("data-service", item[2]);
      open.setAttribute("data-step", "0");
      if (open.parentNode) open.parentNode.appendChild(open);
    } else {
      open.setAttribute("data-step", String(Number(open.getAttribute("data-step")) + 1));
    }
    paint(open);
  }

  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!motion.matches) window.setInterval(tick, 1800);
})();
</script>`;
}

/**
 * GET / landing page. Public copy is outcome-only for business owners;
 * the technical detail lives in the README. Static text: it never echoes request data.
 * The booking board is sample studio data only, drawn on the page.
 */
export function landingPage(): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your systems · Crom Services</title>
<meta name="description" content="Your website and business tools pass details to each other on their own, and only genuine requests get through.">
<link rel="stylesheet" href="${THEME_CSS_URL}">
</head>
<body>
${CROM_HEADER}
<main class="crom-shell">
  <section style="padding: 56px 0 8px;">
    <p class="crom-eyebrow">Crom Services · Australia · working example</p>
    <h1 class="crom-h1">Connect your systems</h1>
    <p class="crom-lead">Your website and business tools pass details to each other on their own, and only genuine requests get through.</p>
  </section>
  <section class="crom-card" id="booking-sync" aria-labelledby="booking-sync-title" style="margin-top: 32px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <h2 class="crom-h3" id="booking-sync-title">From the website to the diary</h2>
      <span class="crom-chip"><span class="crom-dot" style="margin-right:8px;" aria-hidden="true"></span>Sample</span>
    </div>
    <p class="crom-note" style="margin:12px 0 0;">A new booking shows up in the studio diary on its own. Nothing here is a real client.</p>
    <p class="crom-small" id="booking-latest" aria-live="polite" style="margin:8px 0 0;">Latest: Riley, Tue 2:00 pm, is on its way.</p>
    <div style="margin-top:20px;">
      <div role="table" aria-label="Sample bookings moving from the website into the studio diary" style="max-width:760px;">
        <div role="row" style="${ROW_GRID}padding:0 0 8px;border-bottom:1px solid var(--border);">
          <span class="crom-small" role="columnheader">Website</span>
          <span aria-hidden="true"></span>
          <span class="crom-small" role="columnheader">Studio diary</span>
        </div>
        ${BOARD_ROWS.map(bookingRow).join("\n")}
      </div>
    </div>
  </section>
  <section class="crom-card" style="margin-top: 20px;">
    <h2 class="crom-h3">What you get</h2>
    <ul>
      <li>A new booking, order or enquiry reaches the right tool straight away, with no copying and pasting.</li>
      <li>Anything that didn't come from your own systems is turned away, so fake or altered requests never get in.</li>
      <li>One small connection, scoped to the job, tested and handed over.</li>
    </ul>
  </section>
  <p class="crom-note" style="margin-top: 24px;">This page is a working example. It holds no real data.</p>
  <p><a href="${SOURCE_URL}">See the code on GitHub</a></p>
${CROM_FOOTER}
</main>
${bookingScript(LATER_BOOKINGS)}
</body>
</html>
`;
}
