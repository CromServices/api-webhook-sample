/** Firm theme, hard-pinned to the immutable crom-shared v1.0.2 tag (light by default, dark by system setting). */
export const THEME_CSS_URL =
  "https://cdn.jsdelivr.net/gh/CromServices/crom-shared@v1.0.2/theme.css";

/**
 * Crom header, inlined from crom-shared v1.0.2 snippets/header.html (no-JS copy
 * of header.js). Only change: the logo folder is the pinned v1.0.2 copy
 * (the header.js data-logo-base / CROM_LOGO_BASE override), so it can't drift.
 * Ink logo on light, white logo on dark, swapped by <picture> + prefers-color-scheme.
 * The example-project pill is left off. The only sample marker is the page title.
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
  <p class="crom-footer__line">Crom Services · Australia</p>
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

/**
 * GET / landing page. Public copy is outcome-only for business owners;
 * the technical detail lives in the README. Static text: it never echoes request data.
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
    <p class="crom-eyebrow">Crom Services · Australia</p>
    <h1 class="crom-h1">Connect your systems</h1>
    <p class="crom-lead">Your website and business tools pass details to each other on their own, and only genuine requests get through.</p>
  </section>
  <section class="crom-card" style="margin-top: 32px;">
    <h2 class="crom-h3">How it works</h2>
    <ol>
      <li>Your shop, booking tool or form sends a short message each time something happens.</li>
      <li>Each message carries a seal made with a key only your systems share.</li>
      <li>This connection checks the seal first. A good seal is accepted straight away. A missing or broken seal is refused, and nothing is passed on.</li>
    </ol>
  </section>
  <section class="crom-card" style="margin-top: 24px;">
    <h2 class="crom-h3">What you get</h2>
    <ul>
      <li>A new booking, order or enquiry reaches the right tool straight away, with no copying and pasting.</li>
      <li>Anything that didn't come from your own systems is turned away, so forged or altered requests never get in.</li>
      <li>One small connection, scoped to the job, tested and handed over.</li>
    </ul>
  </section>
  <p class="crom-note" style="margin-top: 24px;">This page holds no real data.</p>
${CROM_FOOTER}
</main>
</body>
</html>
`;
}
