/**
 * Headless "browser": loads public/js/*.js into a node:vm context backed by the
 * mini-DOM in ./dom.ts, with `fetch` pointed at an in-process FinFolio server.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DomDocument, DomElement, MemoryStorage, flush } from './dom.js';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

/** Script load order must match public/index.html. */
export function scriptOrderFromIndexHtml(): string[] {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  return [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map(m => m[1]);
}

export interface Browser {
  window: any;
  document: DomDocument;
  App: any;
  API: any;
  /** Errors thrown inside event handlers / unhandled promise rejections captured by the harness. */
  errors: Error[];
  /** Console output captured from the page. */
  logs: { level: string; args: unknown[] }[];
  /** Navigate via the app shell and wait for the page to settle. */
  goto(page: string): Promise<DomElement>;
  /** Resolve an element or throw with a helpful message. */
  $(selector: string): DomElement;
  $$(selector: string): DomElement[];
  text(): string;
  /** Wait until a predicate holds (polling) or time out. */
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>;
}

export interface BrowserOptions {
  baseUrl: string;
  token?: string;
  /** Extra scripts to skip (by file name). */
  skip?: string[];
}

export function createBrowser(opts: BrowserOptions): Browser {
  const document = new DomDocument();
  const localStorage = new MemoryStorage();
  if (opts.token) localStorage.setItem('token', opts.token);
  const errors: Error[] = [];
  const logs: Browser['logs'] = [];

  const sandbox: any = {
    document,
    localStorage,
    console: {
      log: (...args: unknown[]) => logs.push({ level: 'log', args }),
      warn: (...args: unknown[]) => logs.push({ level: 'warn', args }),
      error: (...args: unknown[]) => { logs.push({ level: 'error', args }); },
      info: (...args: unknown[]) => logs.push({ level: 'info', args }),
    },
    fetch: (url: string, init?: RequestInit) => fetch(url.startsWith('http') ? url : opts.baseUrl + url, init),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Intl, Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, Promise, Error, RegExp, URLSearchParams, URL,
    parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent, structuredClone,
    confirm: () => true,
    prompt: (_msg: string, def?: string) => def ?? 'Scenario',
    alert: () => undefined,
    devicePixelRatio: 1,
    location: { hash: '', href: opts.baseUrl + '/', reload: () => undefined },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    navigator: { userAgent: 'finfolio-test' },
    HTMLElement: DomElement,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const windowListeners = new Map<string, ((e: unknown) => void)[]>();
  sandbox.addEventListener = (type: string, fn: (e: unknown) => void) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type)!.push(fn);
  };
  sandbox.dispatchEvent = (e: { type: string }) => (windowListeners.get(e.type) || []).forEach(fn => fn(e));

  const context = vm.createContext(sandbox);
  const scripts = scriptOrderFromIndexHtml().filter(f => !(opts.skip || []).includes(f));
  for (const file of scripts) {
    const code = fs.readFileSync(path.join(PUBLIC_DIR, 'js', file), 'utf-8');
    vm.runInContext(code, context, { filename: `public/js/${file}` });
  }

  const onRejection = (reason: unknown) => { errors.push(reason instanceof Error ? reason : new Error(String(reason))); };
  process.on('unhandledRejection', onRejection);

  const get = (name: string) => vm.runInContext(name, context);
  const browser: Browser = {
    window: sandbox,
    document,
    get App() { return get('App'); },
    get API() { return get('API'); },
    errors,
    logs,
    async goto(page: string) {
      const App = get('App');
      if (!document.getElementById('page-content')) App.showApp();
      sandbox.location.hash = page;
      App.navigate(page);
      const content = document.getElementById('page-content')!;
      // Page renderers are async and not awaited by navigate(); wait until the loading placeholder is gone.
      await browser.waitFor(() => !/Loading/.test(content.textContent) || errors.length > 0, 8000);
      await flush(5);
      return content;
    },
    $(selector: string) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`No element matches "${selector}". Body text: ${document.body.textContent.slice(0, 300)}`);
      return el;
    },
    $$(selector: string) { return document.querySelectorAll(selector); },
    text() { return document.body.textContent.replace(/\s+/g, ' ').trim(); },
    async waitFor(pred, timeoutMs = 5000) {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
        await new Promise(r => setTimeout(r, 10));
      }
    },
  };
  return browser;
}

/** Open the app as a signed-in user and initialise the shell. */
export async function openApp(opts: BrowserOptions): Promise<Browser> {
  const b = createBrowser(opts);
  await b.App.init();
  await flush(3);
  return b;
}
