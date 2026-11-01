/**
 * Privacy scan for exported snapshots: walks a JSON value and reports every
 * key or string that must never leave the app.
 */

/** Keys that only ever carry identifiers or personal free text. */
export const FORBIDDEN_KEYS = new Set([
  'id', 'userId', 'accountId', 'investmentId', 'rewardId', 'batchId', 'externalId', 'fingerprint', 'headerSignature',
  'username', 'passwordHash', 'password', 'token', 'birthDate', 'description', 'rawDescription', 'notes', 'note', 'tags', 'import',
  'matchedFrom', 'filename', 'fileHash', 'createdAt', 'updatedAt',
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface PrivacyFinding {
  path: string;
  reason: string;
}

/**
 * @param forbiddenText strings that identify the person (username, account names, addresses, employer …);
 *                      matched case-insensitively as substrings of every string value.
 */
export function scanPrivacy(value: unknown, forbiddenText: string[] = [], path = '$'): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  const needles = forbiddenText.map(s => s.toLowerCase());
  const visit = (v: unknown, p: string) => {
    if (typeof v === 'string') {
      if (UUID.test(v)) out.push({ path: p, reason: `looks like a UUID: ${v}` });
      const low = v.toLowerCase();
      for (const n of needles) if (n && low.includes(n)) out.push({ path: p, reason: `contains "${n}"` });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(k)) out.push({ path: `${p}.${k}`, reason: `forbidden key "${k}"` });
        if (UUID.test(k)) out.push({ path: `${p}.${k}`, reason: 'key looks like a UUID' });
        visit(x, `${p}.${k}`);
      }
    }
  };
  visit(value, path);
  return out;
}
