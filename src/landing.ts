import type { StarterConfig } from "./config.ts";

/** Firm theme, hard-pinned to the crom-shared v1.0.0 release (light by default, dark by system setting). */
export const THEME_CSS_URL =
  "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.0/theme.css";

export const DOCS_URL = "https://cromservices.github.io/api-webhook-sample/";
export const SOURCE_URL = "https://github.com/CromServices/api-webhook-sample";

/**
 * Crom footer and credit, inlined verbatim from crom-shared v1.0.0
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** GET / landing page. Static text only; it never echoes request data. */
export function landingPage(config: StarterConfig): string {
  const name = escapeHtml(config.name);
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · Crom Services</title>
<meta name="description" content="${escapeHtml(config.description)}">
<link rel="stylesheet" href="${THEME_CSS_URL}">
</head>
<body>
<main class="crom-shell">
  <section style="padding: 56px 0 8px;">
    <p class="crom-eyebrow">Crom Services · Australia · public sample</p>
    <h1 class="crom-h1">API webhook sample</h1>
    <p class="crom-lead">A scoped Express webhook receiver. <code>POST /webhook</code> checks an HMAC-SHA256 signature in the <code>X-Signature-256</code> header against the raw request body, and replies <code>200</code> when it matches or <code>401</code> when it is missing or wrong.</p>
    <p class="crom-note">For illustration only. It holds no real data and stores nothing; the shared secret is a published demo value, not a client secret.</p>
  </section>
  <section class="crom-card" style="margin-top: 32px;">
    <h2 class="crom-h3">Try it</h2>
    <ul>
      <li><a href="/health">/health</a>: liveness check, returns <code>{"ok":true}</code></li>
      <li><a href="${DOCS_URL}">Docs</a>: copy-paste curl for a signed request and the 401 cases</li>
      <li><a href="${SOURCE_URL}">Source on GitHub</a></li>
    </ul>
  </section>
${CROM_FOOTER}
</main>
</body>
</html>
`;
}
