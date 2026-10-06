import { CROM_FOOTER, CROM_HEADER, SOURCE_URL, THEME_CSS_URL } from "./landing.ts";
import { historyLines, present, triageFrom, type TriageView, type View } from "./present.ts";
import { STORY } from "./story.ts";
import type { Picture, Snapshot } from "./store.ts";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nav(): string {
  return `<p style="display:flex;flex-wrap:wrap;gap:16px;margin:16px 0 0;">${STORY.nav
    .map((item) => `<a href="${item.href}">${esc(item.label)}</a>`)
    .join("")}</p>`;
}

function shell(opts: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${THEME_CSS_URL}">
</head>
<body>
${CROM_HEADER}
<main class="crom-shell">
${opts.body}
<p style="margin-top:24px;"><a href="${SOURCE_URL}">${esc(STORY.code)}</a></p>
${CROM_FOOTER}
</main>
</body>
</html>`;
}

function rows(view: View): string {
  if (view.orders.length === 0 && view.extras.length === 0 && view.products.length === 0) {
    return "";
  }
  const orders = view.orders
    .map((row) => {
      const box = row.soft
        ? "background:var(--soft);border-radius:12px;padding:8px 10px;margin-top:8px;"
        : "padding:8px 0;border-top:1px solid var(--border);";
      return `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;${box}"><div><div style="font-weight:500;">${esc(row.text)}</div><div class="crom-small">${esc(row.when)}</div></div><span class="crom-chip">${esc(row.label)}</span></div>`;
    })
    .join("");
  const products = view.products
    .map(
      (line) =>
        `<p class="crom-note" style="margin:8px 0 0;">${esc(line)}</p>`,
    )
    .join("");
  const extras = view.extras
    .map((row) => `<p style="margin:10px 0 0;">${esc(row.text)}</p>`)
    .join("");
  return `${orders}${products}${extras}`;
}

function column(title: string, view: View): string {
  return `<section style="border:1px solid var(--border);border-radius:12px;padding:16px;"><h2 class="crom-h3">${esc(title)}</h2><p style="font-weight:600;margin:12px 0 0;">${esc(view.headline)}</p>${rows(view)}</section>`;
}

export function homePage(picture: Picture): string {
  const view = present(picture);
  return shell({
    title: `${STORY.h1} · Crom Services`,
    body: `<section style="padding:16px 0 0;">
    <p class="crom-eyebrow">Crom Services · Australia</p>
    <h1 class="crom-h1">${esc(STORY.h1)}</h1>
    <p class="crom-lead">${esc(STORY.lead)}</p>
    ${nav()}
  </section>
  <section class="crom-card" style="margin-top:24px;">
    <p style="font-weight:600;margin:0;">${esc(view.headline)}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:16px;">
      ${column(STORY.shop, { ...view, products: [], extras: [] })}
      ${column(STORY.stock, view)}
    </div>
  </section>`,
  });
}

export function shopPage(picture: Picture): string {
  const view = present(picture);
  const options = picture.products
    .map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`)
    .join("");
  return shell({
    title: `${STORY.shop} · Crom Services`,
    body: `<section style="padding:16px 0 0;">
    <h1 class="crom-h2">${esc(STORY.shop)}</h1>
    ${nav()}
    <form method="post" action="/shop/orders" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:16px;">
      <label style="display:flex;flex-direction:column;gap:4px;">${esc(STORY.product)}
        <select name="product">${options}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;">${esc(STORY.quantity)}
        <input name="qty" type="number" min="1" max="20" value="1">
      </label>
      <button class="crom-btn" type="submit">${esc(STORY.place)}</button>
    </form>
  </section>
  <section class="crom-card" style="margin-top:24px;">
    <p style="font-weight:600;margin:0;">${esc(view.headline)}</p>
    ${rows(view)}
  </section>`,
  });
}

export function stockPage(picture: Picture): string {
  const view = present(picture);
  return shell({
    title: `${STORY.stock} · Crom Services`,
    body: `<section style="padding:16px 0 0;">
    <h1 class="crom-h2">${esc(STORY.stock)}</h1>
    ${nav()}
  </section>
  <section class="crom-card" style="margin-top:24px;">
    <p style="font-weight:600;margin:0;">${esc(view.headline)}</p>
    ${rows({ ...view, extras: view.extras })}
  </section>`,
  });
}

export function historyPage(picture: Picture): string {
  const lines = historyLines(picture);
  const body =
    lines.length === 0
      ? `<p class="crom-note" style="margin:12px 0 0;">${esc(STORY.historyEmpty)}</p>`
      : lines.map((line) => `<p style="margin:12px 0 0;padding-top:12px;border-top:1px solid var(--border);">${esc(line)}</p>`).join("");
  return shell({
    title: `${STORY.history} · Crom Services`,
    body: `<section style="padding:16px 0 0;">
    <h1 class="crom-h2">${esc(STORY.history)}</h1>
    ${nav()}
  </section>
  <section class="crom-card" style="margin-top:24px;">
    ${body}
  </section>`,
  });
}

function shot(snapshot: Snapshot | null): View {
  if (!snapshot) {
    return { headline: STORY.none, orders: [], products: [], extras: [] };
  }
  return present(snapshot);
}

function triageBlock(title: string, body: string): string {
  return `<section style="margin-top:18px;"><h2 class="crom-h3">${esc(title)}</h2>${body}</section>`;
}

function triageBody(view: TriageView): string {
  const found =
    view.found.length === 0
      ? `<p style="margin:8px 0 0;">${esc(STORY.nothingFound)}</p>`
      : view.found
          .map((item) => {
            const orders = item.orders
              .map((line) => `<p class="crom-note" style="margin:4px 0 0;">${esc(line)}</p>`)
              .join("");
            return `<p style="margin:10px 0 0;font-weight:600;">${esc(item.summary)}</p>${orders}`;
          })
          .join("");
  const fixed =
    view.fixed.length === 0
      ? ""
      : triageBlock(
          STORY.fixedTitle,
          view.fixed
            .map((line, index) => `<p style="margin:8px 0 0;">${index + 1}. ${esc(line)}</p>`)
            .join(""),
        );
  const later = view.later
    ? triageBlock(STORY.laterTitle, `<p style="margin:8px 0 0;">${esc(view.later)}</p>`)
    : "";
  return `${triageBlock(STORY.triageTitle, `<p style="margin:8px 0 0;font-weight:600;">${esc(view.checked)}</p>`)}
    ${triageBlock(STORY.foundTitle, found)}
    ${fixed}
    ${later}`;
}

export function demoPage(
  before: Snapshot | null,
  after: Snapshot | null,
  view: "side" | "triage" = "side",
): string {
  if (view === "triage") {
    return shell({
      title: `${STORY.triageTitle} · Crom Services`,
      body: `<section style="padding:16px 0 0;">
    <p class="crom-eyebrow">Crom Services · Australia</p>
    <h1 class="crom-h2">${esc(STORY.triageTitle)}</h1>
    <p class="crom-note" style="margin:12px 0 0;">${esc(STORY.demo)}</p>
    ${nav()}
    <p style="margin:12px 0 0;"><a href="/demo">${esc(STORY.sideBySide)}</a></p>
  </section>
  <section class="crom-card" style="margin-top:20px;">
    ${triageBody(triageFrom(before))}
  </section>`,
    });
  }
  return shell({
    title: `${STORY.sideBySide} · Crom Services`,
    body: `<section style="padding:16px 0 0;">
    <p class="crom-eyebrow">Crom Services · Australia</p>
    <h1 class="crom-h2">${esc(STORY.sideBySide)}</h1>
    <p class="crom-note" style="margin:12px 0 0;">${esc(STORY.demo)}</p>
    ${nav()}
    <p style="margin:12px 0 0;"><a href="/demo?view=triage">${esc(STORY.triageTitle)}</a></p>
  </section>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:24px;">
    ${column(STORY.before, shot(before))}
    ${column(STORY.after, shot(after))}
  </div>`,
  });
}
