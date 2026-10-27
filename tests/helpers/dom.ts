/**
 * A deliberately small DOM implementation — just enough to run FinFolio's
 * vanilla-JS pages headlessly inside `node:vm` without any dependency.
 *
 * Supported: innerHTML parsing/serialising, getElementById, querySelector(All)
 * with tag / #id / .class / [attr] / [attr=value] / :checked / :not-needed
 * descendant combinators, classList, dataset, value/checked/disabled,
 * style objects, events with bubbling (click/change/input/submit), canvas
 * 2D-context stubs and layout stubs (getBoundingClientRect / offsetWidth).
 *
 * It is NOT a browser: no CSS, no layout, no rendering. The goal is to catch
 * runtime errors and verify that the data the API returns ends up in the HTML.
 */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, '\u00a0');
}
function encodeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class DomEvent {
  type: string;
  target: DomElement | null = null;
  currentTarget: DomElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  bubbles = true;
  constructor(type: string, public detail: Record<string, unknown> = {}) {
    this.type = type;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

export class DomNode {
  parentElement: DomElement | null = null;
  constructor(public nodeType: number) {}
  get textContent(): string { return ''; }
  set textContent(_v: string) { /* overridden */ }
  serialize(): string { return ''; }
  remove(): void {
    if (this.parentElement) {
      const idx = this.parentElement.childNodes.indexOf(this);
      if (idx !== -1) this.parentElement.childNodes.splice(idx, 1);
      this.parentElement = null;
    }
  }
}

export class DomText extends DomNode {
  constructor(public data: string) { super(3); }
  get textContent(): string { return this.data; }
  set textContent(v: string) { this.data = v; }
  serialize(): string { return encodeText(this.data); }
}

type Listener = (e: DomEvent) => unknown;

export class DomElement extends DomNode {
  tagName: string;
  attributes: Map<string, string> = new Map();
  childNodes: DomNode[] = [];
  style: Record<string, string> = {};
  private listeners: Map<string, Listener[]> = new Map();
  private _value: string | undefined;
  private _checked: boolean | undefined;
  readonly dataset: Record<string, string>;
  readonly classList: { add: (...c: string[]) => void; remove: (...c: string[]) => void; toggle: (c: string, force?: boolean) => boolean; contains: (c: string) => boolean };
  ownerDocument: DomDocument;

  constructor(tag: string, doc: DomDocument) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    const self = this;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, key: string) => self.getAttribute('data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase())) ?? undefined,
      set: (_t, key: string, value: string) => { self.setAttribute('data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), String(value)); return true; },
      has: (_t, key: string) => self.hasAttribute('data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase())),
    });
    this.classList = {
      add: (...c) => { const set = new Set(self.classNames()); c.forEach(x => set.add(x)); self.setAttribute('class', [...set].join(' ')); },
      remove: (...c) => { const set = new Set(self.classNames()); c.forEach(x => set.delete(x)); self.setAttribute('class', [...set].join(' ')); },
      toggle: (c, force) => { const has = self.classNames().includes(c); const want = force === undefined ? !has : force; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      contains: c => self.classNames().includes(c),
    };
  }

  // ── attributes ──
  classNames(): string[] { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  getAttribute(name: string): string | null { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'style') this.style = parseStyle(String(value));
  }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  get id(): string { return this.getAttribute('id') || ''; }
  set id(v: string) { this.setAttribute('id', v); }
  get className(): string { return this.getAttribute('class') || ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get disabled(): boolean { return this.hasAttribute('disabled'); }
  set disabled(v: boolean) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get href(): string { return this.getAttribute('href') || ''; }

  // ── form values ──
  get value(): string {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find(o => o.hasAttribute('selected')) || opts[0];
      return sel ? (sel.getAttribute('value') ?? sel.textContent) : '';
    }
    if (this.tagName === 'TEXTAREA') return this.textContent;
    return this.getAttribute('value') ?? '';
  }
  set value(v: string) { this._value = String(v); }
  get checked(): boolean { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v: boolean) { this._checked = !!v; }
  get options(): DomElement[] { return this.querySelectorAll('option'); }

  // ── tree ──
  get children(): DomElement[] { return this.childNodes.filter((n): n is DomElement => n instanceof DomElement); }
  get firstElementChild(): DomElement | null { return this.children[0] || null; }
  appendChild<T extends DomNode>(node: T): T {
    node.remove();
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes: (DomNode | string)[]): void { nodes.forEach(n => this.appendChild(typeof n === 'string' ? new DomText(n) : n)); }
  insertAdjacentHTML(position: string, html: string): void {
    const frag = parseHtml(html, this.ownerDocument);
    if (position === 'beforeend') frag.forEach(n => this.appendChild(n));
    else if (position === 'afterbegin') { frag.reverse().forEach(n => { n.remove(); n.parentElement = this; this.childNodes.unshift(n); }); }
    else throw new Error(`insertAdjacentHTML: unsupported position ${position}`);
  }
  contains(node: DomNode | null): boolean {
    let cur: DomNode | null = node;
    while (cur) { if (cur === this) return true; cur = cur.parentElement; }
    return false;
  }
  closest(selector: string): DomElement | null {
    let cur: DomElement | null = this;
    while (cur) { if (cur.matches(selector)) return cur; cur = cur.parentElement; }
    return null;
  }

  get innerHTML(): string { return this.childNodes.map(n => n.serialize()).join(''); }
  set innerHTML(html: string) {
    this.childNodes.forEach(n => (n.parentElement = null));
    this.childNodes = [];
    parseHtml(html, this.ownerDocument).forEach(n => this.appendChild(n));
  }
  get outerHTML(): string { return this.serialize(); }
  get textContent(): string { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v: string) {
    this.childNodes.forEach(n => (n.parentElement = null));
    this.childNodes = v === '' ? [] : [new DomText(String(v))];
    this.childNodes.forEach(n => (n.parentElement = this));
  }
  get innerText(): string { return this.textContent; }

  serialize(): string {
    const tag = this.tagName.toLowerCase();
    const attrs = [...this.attributes.entries()].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v.replace(/"/g, '&quot;')}"`)).join('');
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }

  // ── queries ──
  querySelectorAll(selector: string): DomElement[] {
    const out: DomElement[] = [];
    const alternatives = selector.split(',').map(s => s.trim()).filter(Boolean);
    const walk = (el: DomElement) => {
      for (const child of el.children) {
        if (alternatives.some(alt => matchesComplex(child, alt, this))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): DomElement | null { return this.querySelectorAll(selector)[0] || null; }
  getElementsByTagName(tag: string): DomElement[] { return this.querySelectorAll(tag); }
  matches(selector: string): boolean { return selector.split(',').some(alt => matchesComplex(this, alt.trim(), null)); }

  // ── events ──
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(f => f !== fn));
  }
  /** Dispatch with bubbling; returns the event. Listeners may be async — collect their promises in `event.detail.pending`. */
  dispatchEvent(event: DomEvent): boolean {
    event.target = event.target || this;
    const pending: Promise<unknown>[] = (event.detail.pending as Promise<unknown>[]) || [];
    event.detail.pending = pending;
    let cur: DomElement | null = this;
    while (cur && !event.propagationStopped) {
      event.currentTarget = cur;
      for (const fn of [...(cur.listeners.get(event.type) || [])]) {
        const r = fn.call(cur, event);
        if (r && typeof (r as Promise<unknown>).then === 'function') pending.push(r as Promise<unknown>);
      }
      if (!event.bubbles) break;
      cur = cur.parentElement;
    }
    return !event.defaultPrevented;
  }
  /**
   * Convenience: fire an event and wait for any async listeners — bounded by
   * `settleMs` so a handler that is itself waiting for user input (e.g. a
   * confirm dialog) cannot deadlock the test.
   */
  async fire(type: string, settleMs = 1500): Promise<DomEvent> {
    const ev = new DomEvent(type);
    this.dispatchEvent(ev);
    const pending = ev.detail.pending as Promise<unknown>[];
    await Promise.race([Promise.all(pending).catch(() => undefined), new Promise(r => setTimeout(r, settleMs))]);
    await flush();
    return ev;
  }
  click(): Promise<DomEvent> { return this.fire('click'); }
  focus(): void { /* no-op */ }
  select(): void { /* no-op */ }
  /** <dialog> support */
  returnValue = '';
  get open(): boolean { return this.hasAttribute('open'); }
  showModal(): void { this.setAttribute('open', ''); }
  show(): void { this.setAttribute('open', ''); }
  close(value?: string): void {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    const ev = new DomEvent('close');
    ev.bubbles = false;
    this.dispatchEvent(ev);
  }
  blur(): void { /* no-op */ }
  scrollIntoView(): void { /* no-op */ }

  // ── layout / canvas stubs ──
  getBoundingClientRect() { return { width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0 }; }
  get offsetWidth(): number { return 800; }
  get offsetHeight(): number { return 400; }
  get clientWidth(): number { return 800; }
  width = 0;
  height = 0;
  getContext(kind: string) {
    if (this.tagName !== 'CANVAS') return null;
    const calls: string[] = (this as any).__ctxCalls || ((this as any).__ctxCalls = []);
    const gradient = { addColorStop: () => undefined };
    return new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 6 });
        if (prop === 'canvas') return this;
        if (prop === '__calls') return calls;
        return (...args: unknown[]) => { calls.push(prop); return undefined; };
      },
      set: () => true,
    });
  }
}

function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  s.split(';').forEach(part => {
    const i = part.indexOf(':');
    if (i === -1) return;
    const key = part.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = part.slice(i + 1).trim();
  });
  return out;
}

// ── selector matching ───────────────────────────────────────────────────────

interface Compound { tag?: string; id?: string; classes: string[]; attrs: { name: string; value?: string }[]; pseudos: string[] }

function parseCompound(s: string): Compound {
  const c: Compound = { classes: [], attrs: [], pseudos: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:([\w-]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s))) {
    consumed += m[0].length;
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] ?? m[6] ?? m[7] });
    else if (m[8]) c.pseudos.push(m[8]);
  }
  if (consumed !== s.replace(/\s/g, '').length) throw new Error(`Unsupported selector: ${s}`);
  return c;
}

function matchesCompound(el: DomElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  const classes = el.classNames();
  if (!c.classes.every(cls => classes.includes(cls))) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const p of c.pseudos) {
    if (p === 'checked') { if (!el.checked) return false; }
    else if (p === 'disabled') { if (!el.disabled) return false; }
    else if (p === 'enabled') { if (el.disabled) return false; }
    else throw new Error(`Unsupported pseudo-class :${p}`);
  }
  return true;
}

/** Supports descendant (space) and child (>) combinators. `scope` limits ancestor search. */
function matchesComplex(el: DomElement, selector: string, scope: DomElement | null): boolean {
  const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean);
  const combinators: string[] = [];
  const re = /\s*>\s*|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(selector))) combinators.push(m[0].includes('>') ? '>' : ' ');
  let idx = parts.length - 1;
  if (!matchesCompound(el, parseCompound(parts[idx]))) return false;
  let cur: DomElement | null = el;
  while (idx > 0) {
    const comb = combinators[idx - 1];
    idx -= 1;
    const compound = parseCompound(parts[idx]);
    if (comb === '>') {
      cur = cur!.parentElement;
      if (!cur || cur === scope || !matchesCompound(cur, compound)) return false;
    } else {
      cur = cur!.parentElement;
      while (cur && cur !== scope && !matchesCompound(cur, compound)) cur = cur.parentElement;
      if (!cur || cur === scope) return false;
    }
  }
  return true;
}

// ── HTML parser ─────────────────────────────────────────────────────────────

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

export function parseHtml(html: string, doc: DomDocument): DomNode[] {
  const root = new DomElement('#fragment', doc);
  const stack: DomElement[] = [root];
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { stack[stack.length - 1].appendChild(new DomText(decodeEntities(html.slice(i)))); break; }
    if (lt > i) stack[stack.length - 1].appendChild(new DomText(decodeEntities(html.slice(i, lt))));
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt); i = end === -1 ? len : end + 3; continue; }
    const gt = findTagEnd(html, lt);
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName === name) { stack.length = s; break; }
      }
      continue;
    }
    if (raw.startsWith('!')) continue; // doctype
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-zA-Z][\w-]*)/.exec(body);
    if (!nameMatch) { stack[stack.length - 1].appendChild(new DomText('<' + raw + '>')); continue; }
    const tag = nameMatch[1].toLowerCase();
    const el = new DomElement(tag, doc);
    const attrRe = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    attrRe.lastIndex = nameMatch[0].length;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(body))) {
      if (!a[1]) continue;
      el.setAttribute(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    stack[stack.length - 1].appendChild(el);
    if (selfClosing || VOID_TAGS.has(tag)) continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}>`, i);
      const text = close === -1 ? html.slice(i) : html.slice(i, close);
      el.appendChild(new DomText(decodeEntities(text)));
      i = close === -1 ? len : close + tag.length + 3;
      continue;
    }
    stack.push(el);
  }
  return root.childNodes.map(n => { n.parentElement = null; return n; });
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return html.length;
}

// ── document / window ───────────────────────────────────────────────────────

export class DomDocument {
  documentElement: DomElement;
  body: DomElement;
  head: DomElement;
  private listeners: Map<string, Listener[]> = new Map();
  constructor() {
    this.documentElement = new DomElement('html', this);
    this.head = new DomElement('head', this);
    this.body = new DomElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): DomElement { return new DomElement(tag, this); }
  createTextNode(text: string): DomText { return new DomText(text); }
  getElementById(id: string): DomElement | null { return this.documentElement.querySelector(`#${id}`); }
  querySelector(sel: string): DomElement | null { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string): DomElement[] { return this.documentElement.querySelectorAll(sel); }
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  dispatch(type: string): void { (this.listeners.get(type) || []).forEach(fn => fn(new DomEvent(type))); }
  get activeElement(): DomElement { return this.body; }
}

export class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

/** Let pending microtasks and zero-delay timers run. */
export async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}
