/**
 * Environment variables, with the pre-rename names still honoured.
 *
 * The project was called token-harness and its variables were TH_*. Everything
 * is MPH_* now, but a shell, a script or a systemd unit set up under the old
 * name must keep working, so every lookup falls back. New code should only ever
 * use the MPH_ name.
 */
export function mphEnv(name: string, e: NodeJS.ProcessEnv = process.env): string | undefined {
  return e[`MPH_${name}`] ?? e[`TH_${name}`];
}
