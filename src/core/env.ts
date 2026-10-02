/**
 * Environment variables. Every one is MPH_*; `mphEnv("OPENAI_BASE_URL")` reads
 * MPH_OPENAI_BASE_URL. The indirection exists so the prefix is declared once
 * rather than spelled out at thirty call sites.
 */
export function mphEnv(name: string, e: NodeJS.ProcessEnv = process.env): string | undefined {
  return e[`MPH_${name}`];
}
