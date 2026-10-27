/**
 * Test harness: boots the real FinFolio HTTP server in-process against a
 * throw-away data directory and exposes a small typed HTTP client.
 *
 * Usage:
 *   const app = await launch();            // fresh empty DB, frozen clock
 *   const { token } = await app.register('alice', 'pw');
 *   const res = await app.get('/api/accounts', token);
 *   await app.close();
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server.js';
import { setClock } from '../../src/util/clock.js';
import { db } from '../../src/db/database.js';

/** Fixed "today" used by the whole regression suite (matches the seeded demo user). */
export const TEST_NOW = '2026-10-25T12:00:00.000Z';
export const TEST_TODAY = TEST_NOW.slice(0, 10);

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestApp {
  baseUrl: string;
  dataDir: string;
  request<T = any>(method: string, apiPath: string, body?: unknown, token?: string): Promise<ApiResponse<T>>;
  get<T = any>(apiPath: string, token?: string): Promise<ApiResponse<T>>;
  post<T = any>(apiPath: string, body?: unknown, token?: string): Promise<ApiResponse<T>>;
  put<T = any>(apiPath: string, body?: unknown, token?: string): Promise<ApiResponse<T>>;
  del<T = any>(apiPath: string, token?: string): Promise<ApiResponse<T>>;
  register(username: string, password: string): Promise<{ token: string; user: { id: string; username: string } }>;
  login(username: string, password: string): Promise<{ token: string; user: { id: string; username: string } }>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Override the frozen clock; pass `null` to use the real clock. Default: TEST_NOW. */
  now?: string | null;
  /** Reuse an existing data directory instead of a fresh temp dir. */
  dataDir?: string;
}

export async function launch(opts: LaunchOptions = {}): Promise<TestApp> {
  setClock(opts.now === undefined ? TEST_NOW : opts.now);

  const ownsDir = !opts.dataDir;
  const dataDir = opts.dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'finfolio-test-')));

  const running: RunningServer = await startServer({ port: 0, dataDir, quiet: true });
  if (ownsDir) await db.reset();

  async function request<T = any>(method: string, apiPath: string, body?: unknown, token?: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(running.baseUrl + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body (static files) – leave as text */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  async function auth(endpoint: string, username: string, password: string) {
    const res = await request<{ token: string; user: { id: string; username: string } }>('POST', endpoint, { username, password });
    if (res.status !== 200) throw new Error(`${endpoint} failed (${res.status}): ${JSON.stringify(res.body)}`);
    return res.body;
  }

  return {
    baseUrl: running.baseUrl,
    dataDir,
    request,
    get: (p, t) => request('GET', p, undefined, t),
    post: (p, b, t) => request('POST', p, b, t),
    put: (p, b, t) => request('PUT', p, b, t),
    del: (p, t) => request('DELETE', p, undefined, t),
    register: (u, p) => auth('/api/auth/register', u, p),
    login: (u, p) => auth('/api/auth/login', u, p),
    close: async () => {
      await running.close();
      setClock(null);
      if (ownsDir) await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
