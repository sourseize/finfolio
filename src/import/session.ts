/**
 * In-memory preview sessions. A preview keeps the uploaded bytes so the
 * mapping/account can be changed without re-uploading, and so commit works
 * from what the user actually saw. Sessions belong to one user and expire.
 */
import crypto from 'node:crypto';
import type { PreviewResult } from './engine.js';
import type { CsvMappingOverrides } from './types.js';

export interface PreviewOptions {
  localeHint?: string;
  includePending?: boolean;
  /** CSV / generic JSON overrides per file index. */
  mappings?: Record<number, CsvMappingOverrides>;
}

export interface PreviewSession {
  id: string;
  userId: string;
  accountId: string;
  files: { name: string; bytes: Buffer }[];
  options: PreviewOptions;
  result: PreviewResult;
  createdAt: number;
  expiresAt: number;
}

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 5;

const sessions = new Map<string, PreviewSession>();

function purge(now = Date.now()): void {
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}

export function createSession(data: Omit<PreviewSession, 'id' | 'createdAt' | 'expiresAt'>, now = Date.now()): PreviewSession {
  purge(now);
  // keep memory bounded: drop the oldest sessions of this user beyond the cap
  const mine = [...sessions.values()].filter(s => s.userId === data.userId).sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= MAX_SESSIONS_PER_USER) sessions.delete(mine.shift()!.id);
  const session: PreviewSession = { ...data, id: crypto.randomUUID(), createdAt: now, expiresAt: now + PREVIEW_TTL_MS };
  sessions.set(session.id, session);
  return session;
}

/** Replace the result/options of an existing session (re-preview) and extend its life. */
export function updateSession(session: PreviewSession, patch: Partial<Pick<PreviewSession, 'accountId' | 'options' | 'result'>>, now = Date.now()): PreviewSession {
  Object.assign(session, patch, { expiresAt: now + PREVIEW_TTL_MS });
  return session;
}

/** Returns the session only if it exists, belongs to the user and has not expired. */
export function getSession(id: string, userId: string, now = Date.now()): PreviewSession | undefined {
  purge(now);
  const s = sessions.get(id);
  return s && s.userId === userId ? s : undefined;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

/** Test hook. */
export function _resetSessions(): void {
  sessions.clear();
}
