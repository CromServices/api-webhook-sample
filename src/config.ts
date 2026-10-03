import { readFileSync } from "node:fs";

/**
 * Per-project settings, read from the `starter.config` block in package.json.
 * Edit package.json, not this file, when you reuse the template.
 */
export type StarterConfig = {
  name: string;
  description: string;
  liveUrl: string;
};

const FALLBACK: StarterConfig = {
  name: "crom-ts-api-starter",
  description: "TypeScript API",
  liveUrl: "",
};

export function loadStarterConfig(): StarterConfig {
  try {
    // package.json sits one level above both src/ (tsx) and dist/ (compiled).
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { starter?: { config?: Partial<StarterConfig> } };
    return { ...FALLBACK, ...(pkg.starter?.config ?? {}) };
  } catch {
    return FALLBACK;
  }
}
