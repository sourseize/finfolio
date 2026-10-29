import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, match: RegExpMatchArray, body?: any) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  handler: Handler;
  auth: boolean;
}

/** Largest accepted request body (statement uploads are base64 inside JSON). Override with FINFOLIO_MAX_BODY_MB. */
export const MAX_BODY_BYTES = Math.max(1, parseInt(process.env.FINFOLIO_MAX_BODY_MB || '25', 10) || 25) * 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() { super('Request body too large'); }
}

export class Router {
  private routes: Route[] = [];
  private sessions: Map<string, { userId: string; expires: number }> = new Map();

  get(pattern: string, handler: Handler, auth = true) {
    this.addRoute('GET', pattern, handler, auth);
  }

  post(pattern: string, handler: Handler, auth = true) {
    this.addRoute('POST', pattern, handler, auth);
  }

  put(pattern: string, handler: Handler, auth = true) {
    this.addRoute('PUT', pattern, handler, auth);
  }

  delete(pattern: string, handler: Handler, auth = true) {
    this.addRoute('DELETE', pattern, handler, auth);
  }

  private addRoute(method: string, pattern: string, handler: Handler, auth: boolean) {
    // Convert /api/users/:id → regex with named groups via numbered groups
    const paramNames: string[] = [];
    const regexStr = pattern.replace(/:([a-zA-Z_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${regexStr}$`),
      params: paramNames,
      handler,
      auth,
    });
  }

  createSessionToken(userId: string): string {
    const token = crypto.randomUUID();
    this.sessions.set(token, {
      userId,
      expires: Date.now() + 24 * 60 * 60 * 1000, // 24h
    });
    return token;
  }

  getSessionUser(token: string): string | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expires) {
      this.sessions.delete(token);
      return null;
    }
    return session.userId;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Serve static files
    if (!pathname.startsWith('/api/')) {
      return this.serveStatic(req, res, pathname);
    }

    // Parse JSON body
    let body: any = undefined;
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await this.parseBody(req);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: `Request body too large (limit ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB)` }));
          return;
        }
        throw err;
      }
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      // Auth check
      if (route.auth) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const token = authHeader.slice(7);
        const userId = this.getSessionUser(token);
        if (!userId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session expired' }));
          return;
        }
        // Attach userId to request
        (req as any).userId = userId;
      }

      try {
        await route.handler(req, res, match, body);
      } catch (err: any) {
        console.error('Handler error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async parseBody(req: http.IncomingMessage): Promise<any> {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let failed = false;
      req.on('data', (chunk: Buffer) => {
        if (failed) return;
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          failed = true;
          reject(new BodyTooLarge());
          req.resume(); // drain what is left so the connection can close cleanly
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (failed) return;
        const raw = Buffer.concat(chunks).toString();
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', reject);
    });
  }

  private mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let filePath = path.join(process.cwd(), 'public', pathname === '/' ? 'index.html' : pathname);

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        await fs.stat(filePath);
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = this.mimeTypes[ext] || 'application/octet-stream';
      const content = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      // SPA fallback: serve index.html for any non-API route
      try {
        const fallback = path.join(process.cwd(), 'public', 'index.html');
        const content = await fs.readFile(fallback);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    }
  }
}

export const router = new Router();
