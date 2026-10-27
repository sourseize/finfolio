/**
 * Central clock for the application.
 *
 * All "what is today" decisions on the server go through `now()` so that the
 * regression suite (and the seeded demo user) can freeze time by setting the
 * `FINFOLIO_NOW` environment variable, e.g. `FINFOLIO_NOW=2026-10-25`.
 *
 * When the variable is unset, the real system clock is used.
 */

let override: Date | null = null;

function parseOverride(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`FINFOLIO_NOW is not a valid date: "${raw}"`);
  }
  return d;
}

/** Programmatic override (used by tests). Pass `null` to clear. */
export function setClock(date: Date | string | null): void {
  override = date === null ? null : (typeof date === 'string' ? parseOverride(date) : date);
}

/** The programmatic override currently in force (null when none). Use with `setClock` to save/restore. */
export function getClockOverride(): Date | null {
  return override ? new Date(override.getTime()) : null;
}

/** Current time, honouring `setClock()` first, then `FINFOLIO_NOW`, then the system clock. */
export function now(): Date {
  if (override) return new Date(override.getTime());
  const env = parseOverride(process.env.FINFOLIO_NOW);
  return env ?? new Date();
}

/** ISO timestamp of `now()`. */
export function nowIso(): string {
  return now().toISOString();
}

/** `YYYY-MM-DD` of `now()` (UTC). */
export function today(): string {
  return now().toISOString().slice(0, 10);
}

/** True when the clock is frozen (by env var or `setClock`). */
export function isClockFrozen(): boolean {
  return override !== null || !!process.env.FINFOLIO_NOW;
}
