/**
 * The side-by-side report as a PDF: five A4 pages laid out with src/pdf/writer.ts.
 * Light colours for paper; charts are drawn as vectors from the same report
 * the Compare page shows. Pure: report in, bytes out.
 */
import { A4, PdfDocument, hex, textWidth, truncateText, type Page, type Rgb } from '../pdf/writer.js';
import type { ComparisonReport, MetricRow } from './engine.js';
import type { WhatIfPoint } from '../routes/compare.js';

export interface PdfReportInput {
  report: ComparisonReport;
  /** What the sliders were set to and what they produced, when the user moved them. */
  whatIf?: { extraSaving: number; extraInvesting: number; result: { base: WhatIfPoint; both: WhatIfPoint } } | null;
  /** ISO timestamp for the footer and the PDF metadata. */
  generatedAt: string;
}

const C = {
  ink: hex('#1a1a2e'),
  muted: hex('#6b7280'),
  light: hex('#9ca3af'),
  grid: hex('#e5e7eb'),
  panel: hex('#f3f4f6'),
  panelBorder: hex('#d1d5db'),
  mine: hex('#0077b6'),
  theirs: hex('#6d3fd1'),
  mineSoft: hex('#cfe9f6'),
  theirsSoft: hex('#e4daf9'),
  green: hex('#15803d'),
  orange: hex('#c2410c'),
  white: hex('#ffffff'),
};
const PALETTE = ['#0077b6', '#15803d', '#dc2626', '#d97706', '#6d3fd1', '#ca8a04', '#4f46e5', '#0891b2', '#ea580c', '#65a30d', '#64748b', '#db2777'].map(hex);

const M = 40; // margin
const W = A4.width - 2 * M;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string | null | undefined) => (key ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : '—');
const dateLabel = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

export function money(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString('en-US')}`;
  }
}
const compact = (n: number) => (Math.abs(n) >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);
const pct = (f: number | string | null, digits = 0) => (typeof f === 'number' ? `${(f * 100).toFixed(digits)}%` : '—');

export function metricValue(v: number | string | null, unit: MetricRow['unit'], currency: string): string {
  if (v === null || v === undefined) return '—';
  switch (unit) {
    case 'money': return money(v as number, currency);
    case 'percent': return pct(v, 1);
    case 'months': return `${(v as number).toFixed(1)} mo`;
    case 'years': return `${(v as number).toFixed(1)} yrs`;
    case 'age': return (v as number).toFixed(1);
    case 'month': return monthLabel(String(v));
    case 'bool': return v ? 'yes' : 'no';
    default: return Math.round(v as number).toLocaleString('en-US');
  }
}

export function metricDelta(m: MetricRow, currency: string): string {
  if (m.delta === null || m.delta === undefined || m.unit === 'bool') return '';
  const sign = m.delta > 0 ? '+' : m.delta < 0 ? '−' : '';
  const abs = Math.abs(m.delta);
  switch (m.unit) {
    case 'money': return `${sign}${money(abs, currency)}`;
    case 'percent': return `${sign}${(abs * 100).toFixed(1)} pp`;
    case 'months': return `${sign}${abs.toFixed(1)} mo`;
    case 'years': return `${sign}${abs.toFixed(1)} yrs`;
    case 'age': return `${sign}${abs.toFixed(1)}`;
    case 'month': return `${sign}${abs} mo`;
    default: return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
  }
}

// ── Page furniture ──────────────────────────────────────────────────────────

function header(page: Page, title: string, r: ComparisonReport): number {
  page.rect(0, 0, A4.width, 54, { fill: C.ink });
  page.text('FinFolio', M, 24, { size: 11, bold: true, color: C.white });
  page.text('Side by side', M + textWidth('FinFolio', 11, true) + 6, 24, { size: 11, color: hex('#bfdbfe') });
  page.text(title, M, 42, { size: 15, bold: true, color: C.white });
  page.text(`You vs ${r.labels.theirs}`, A4.width - M, 42, { size: 11, color: hex('#e0e7ff'), align: 'right', maxWidth: 260 });
  return 76;
}

function footer(page: Page, n: number, total: number, input: PdfReportInput): void {
  const r = input.report;
  const y = A4.height - 22;
  page.line(M, y - 10, A4.width - M, y - 10, { color: C.grid, width: 0.5 });
  page.text(`Generated ${input.generatedAt.slice(0, 10)} · your figures as of ${r.asOf.mine} · ${r.labels.theirs}'s as of ${r.asOf.theirs} · nothing from ${r.labels.theirs}'s snapshot was stored`, M, y, { size: 7.5, color: C.muted, maxWidth: W - 60 });
  page.text(`${n} / ${total}`, A4.width - M, y, { size: 7.5, color: C.muted, align: 'right' });
}

function sectionTitle(page: Page, y: number, text: string, sub?: string): number {
  page.text(text, M, y, { size: 12, bold: true, color: C.ink });
  if (sub) page.text(sub, A4.width - M, y, { size: 8, color: C.muted, align: 'right', maxWidth: 300 });
  page.line(M, y + 6, A4.width - M, y + 6, { color: C.grid, width: 0.5 });
  return y + 20;
}

function legend(page: Page, x: number, y: number, items: { label: string; color: Rgb; dash?: boolean }[]): void {
  let xx = x;
  for (const it of items) {
    page.line(xx, y - 3, xx + 14, y - 3, { color: it.color, width: 2, dash: it.dash ? [2, 2] : undefined });
    page.text(it.label, xx + 18, y, { size: 8, color: C.muted });
    xx += 18 + textWidth(it.label, 8) + 14;
  }
}

// ── Charts ──────────────────────────────────────────────────────────────────

interface LineDataset { data: (number | null)[]; color: Rgb; dash?: number[]; width?: number }

function lineChart(page: Page, x: number, y: number, w: number, h: number, labels: string[], datasets: LineDataset[], opts: { yFormat?: (v: number) => string; markers?: { index: number; label: string; color: Rgb }[]; xEvery?: number } = {}): void {
  const pad = { top: 10, bottom: 22, left: 46, right: 8 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const all = datasets.flatMap(d => d.data.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  if (!all.length || labels.length < 2) { page.text('No data', x + w / 2, y + h / 2, { size: 9, color: C.muted, align: 'center' }); return; }
  let max = Math.max(0, ...all);
  let min = Math.min(0, ...all);
  if (max === min) { max += 1; min -= 1; }
  const padY = (max - min) * 0.06;
  max += padY;
  if (min < 0) min -= padY;
  const yFormat = opts.yFormat ?? compact;
  const X = (i: number) => x + pad.left + (cw / (labels.length - 1)) * i;
  const Y = (v: number) => y + pad.top + ch - ((v - min) / (max - min)) * ch;
  for (let i = 0; i <= 4; i++) {
    const v = max - ((max - min) / 4) * i;
    page.line(x + pad.left, Y(v), x + w - pad.right, Y(v), { color: C.grid, width: 0.5 });
    page.text(yFormat(v), x + pad.left - 6, Y(v) + 2.5, { size: 7, color: C.muted, align: 'right' });
  }
  if (min < 0) page.line(x + pad.left, Y(0), x + w - pad.right, Y(0), { color: C.light, width: 0.5, dash: [2, 2] });
  (opts.markers ?? []).forEach((m, mi) => {
    if (m.index < 0 || m.index >= labels.length) return;
    const mx = X(m.index);
    page.line(mx, y + pad.top, mx, y + pad.top + ch, { color: m.color, width: 0.6, dash: [2, 2] });
    const right = mx > x + w * 0.75;
    page.text(m.label, mx + (right ? -3 : 3), y + pad.top + 8 + mi * 10, { size: 7, color: m.color, align: right ? 'right' : 'left' });
  });
  for (const d of datasets) {
    let run: [number, number][] = [];
    const flush = () => { if (run.length > 1) page.polyline(run, { color: d.color, width: d.width ?? 1.5, dash: d.dash }); run = []; };
    d.data.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) run.push([X(i), Y(v)]); else flush(); });
    flush();
  }
  const every = opts.xEvery ?? Math.max(1, Math.ceil(labels.length / 8));
  const last = labels.length - 1;
  labels.forEach((l, i) => {
    const regular = i % every === 0;
    const isLast = i === last && last % every !== 0 && last - Math.floor(last / every) * every >= every / 2;
    if (!regular && !isLast) return;
    page.text(l, X(i), y + h - 6, { size: 7, color: C.muted, align: 'center' });
  });
}

function doughnut(page: Page, cx: number, cy: number, r: number, values: number[], colors: Rgb[], centre: string): void {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) { page.text('No spending', cx, cy + 3, { size: 8, color: C.muted, align: 'center' }); return; }
  let a = 0;
  values.forEach((v, i) => {
    if (v <= 0) return;
    const slice = (v / total) * Math.PI * 2;
    page.ringSlice(cx, cy, r, r * 0.6, a, a + slice, colors[i % colors.length]);
    a += slice;
  });
  page.text(centre, cx, cy + 3, { size: 8, bold: true, color: C.ink, align: 'center' });
}

function progressBar(page: Page, x: number, y: number, w: number, fraction: number, color: Rgb): void {
  page.rect(x, y, w, 5, { fill: C.grid });
  page.rect(x, y, w * Math.max(0, Math.min(1, fraction)), 5, { fill: color });
}

// ── Pages ───────────────────────────────────────────────────────────────────

function pageCover(doc: PdfDocument, input: PdfReportInput): void {
  const r = input.report;
  const them = r.labels.theirs;
  const page = doc.addPage();
  let y = header(page, 'How you compare', r);

  page.text(`You (age ${r.profile.mine.age}, ${r.currency.mine}, as of ${dateLabel(r.asOf.mine)})  vs  ${them} (age ${r.profile.theirs.age}, ${r.currency.theirs}, as of ${dateLabel(r.asOf.theirs)})`, M, y, { size: 9, color: C.muted, maxWidth: W });
  y += 22;

  // Scoreboard
  page.rect(M, y, W, 70, { fill: C.panel, stroke: C.panelBorder, lineWidth: 0.5 });
  page.text('SCOREBOARD', M + 12, y + 16, { size: 8, bold: true, color: C.muted });
  page.text(`${r.score.scored} metrics scored · income, spending and portfolio size are shown but never scored`, A4.width - M - 12, y + 16, { size: 7.5, color: C.muted, align: 'right' });
  page.text(`You lead on ${r.score.mine}`, M + 12, y + 40, { size: 16, bold: true, color: C.mine });
  page.text(`${r.score.ties} tie${r.score.ties === 1 ? '' : 's'}`, A4.width / 2, y + 40, { size: 10, color: C.muted, align: 'center' });
  page.text(`${them} leads on ${r.score.theirs}`, A4.width - M - 12, y + 40, { size: 16, bold: true, color: C.theirs, align: 'right', maxWidth: 240 });
  const barY = y + 52;
  page.rect(M + 12, barY, W - 24, 8, { fill: C.theirsSoft });
  if (r.score.scored) page.rect(M + 12, barY, (W - 24) * (r.score.mine / r.score.scored), 8, { fill: C.mine });
  y += 84;

  // Headline figures: 3 × 2 boxes
  const keys = ['netWorth', 'savingsRate', 'investingRate', 'cashMonths', 'fiDate', 'badgesUnlocked'];
  const boxes = keys.map(k => r.metrics.find(m => m.key === k)!).filter(Boolean);
  const bw = (W - 20) / 3;
  boxes.forEach((m, i) => {
    const bx = M + (i % 3) * (bw + 10);
    const by = y + Math.floor(i / 3) * 58;
    const edge = m.leader === 'mine' ? C.green : m.leader === 'theirs' ? C.orange : C.panelBorder;
    page.rect(bx, by, bw, 50, { fill: C.white, stroke: edge, lineWidth: 0.8 });
    page.text(m.label.toUpperCase(), bx + 8, by + 13, { size: 6.5, color: C.muted, maxWidth: bw - 16 });
    page.text(metricValue(m.mine, m.unit, r.currency.mine), bx + 8, by + 30, { size: 12, bold: true, color: C.mine, maxWidth: bw - 16 });
    page.text(metricValue(m.theirs, m.unit, r.currency.theirs), bx + 8, by + 43, { size: 9.5, color: C.theirs, maxWidth: bw - 16 });
  });
  y += 58 * 2 + 6;
  legend(page, M, y, [{ label: 'You', color: C.mine }, { label: them, color: C.theirs }, { label: 'green edge: you lead', color: C.green }, { label: 'orange edge: they lead', color: C.orange }]);
  y += 18;

  if (r.warnings.length) {
    const lines = r.warnings.length;
    page.rect(M, y, W, 12 + lines * 12, { fill: hex('#fff7ed'), stroke: hex('#fdba74'), lineWidth: 0.5 });
    let wy = y + 13;
    for (const w of r.warnings) { page.text(`! ${w}`, M + 8, wy, { size: 8, color: C.orange, maxWidth: W - 16 }); wy += 12; }
    y += 12 + lines * 12 + 10;
  }

  y = sectionTitle(page, y + 4, 'What this says');
  for (const i of r.insights) {
    const mark = i.tone === 'lead' ? '+' : i.tone === 'behind' ? '–' : '•';
    const color = i.tone === 'lead' ? C.green : i.tone === 'behind' ? C.orange : C.muted;
    page.text(mark, M + 2, y, { size: 9, bold: true, color });
    y = page.paragraph(i.text, M + 14, y, W - 14, { size: 9, color: C.ink, lineHeight: 12 }) + 3;
    if (y > A4.height - 60) break;
  }
}

function pageMetrics(doc: PdfDocument, input: PdfReportInput): void {
  const r = input.report;
  const them = r.labels.theirs;
  const page = doc.addPage();
  let y = header(page, 'All metrics', r);
  const groups: [string, string][] = [
    ['position', 'Where you stand'], ['cashflow', 'Cash flow (last 12 months)'], ['investments', 'Investments'],
    ['goals', 'Goals'], ['motivation', 'Habits & rewards'], ['outlook', 'Outlook on current habits'],
  ];
  const col = { metric: M, you: M + 270, them: M + 350, delta: M + 430, leads: M + 440 };
  page.text('Metric', col.metric, y, { size: 7.5, bold: true, color: C.muted });
  page.text('You', col.you, y, { size: 7.5, bold: true, color: C.mine, align: 'right' });
  page.text(them, col.them, y, { size: 7.5, bold: true, color: C.theirs, align: 'right', maxWidth: 80 });
  page.text('Delta', col.delta, y, { size: 7.5, bold: true, color: C.muted, align: 'right' });
  page.text('Leads', col.leads, y, { size: 7.5, bold: true, color: C.muted });
  y += 6;
  page.line(M, y, A4.width - M, y, { color: C.panelBorder, width: 0.5 });
  y += 12;
  for (const [group, title] of groups) {
    page.text(title.toUpperCase(), M, y, { size: 7, bold: true, color: C.muted });
    y += 11;
    for (const m of r.metrics.filter(x => x.group === group)) {
      if (m.leader === 'mine') page.rect(M - 4, y - 8, 2, 11, { fill: C.green });
      if (m.leader === 'theirs') page.rect(M - 4, y - 8, 2, 11, { fill: C.orange });
      page.text(m.label, col.metric, y, { size: 8.5, color: C.ink, maxWidth: 215 });
      page.text(metricValue(m.mine, m.unit, r.currency.mine), col.you, y, { size: 8.5, color: C.mine, align: 'right' });
      page.text(metricValue(m.theirs, m.unit, r.currency.theirs), col.them, y, { size: 8.5, color: C.theirs, align: 'right' });
      page.text(metricDelta(m, r.currency.mine), col.delta, y, { size: 8, color: C.muted, align: 'right' });
      const lead = m.leader === 'mine' ? 'you' : m.leader === 'theirs' ? them : m.leader === 'tie' ? 'tie' : '';
      if (lead) page.text(lead, col.leads, y, { size: 8, color: m.leader === 'mine' ? C.green : m.leader === 'theirs' ? C.orange : C.muted, maxWidth: A4.width - M - col.leads });
      else if (m.note) page.text(m.note, col.leads, y, { size: 6.5, color: C.light, maxWidth: A4.width - M - col.leads });
      page.line(M, y + 3.5, A4.width - M, y + 3.5, { color: C.grid, width: 0.3 });
      y += 12.5;
    }
    y += 4;
  }
}

function pageCashflow(doc: PdfDocument, input: PdfReportInput): void {
  const r = input.report;
  const them = r.labels.theirs;
  const page = doc.addPage();
  let y = header(page, 'Cash flow & spending', r);
  y = sectionTitle(page, y, 'Spending and income by month', 'aligned by calendar month');
  const labels = r.series.map(p => `${MONTHS[Number(p.month.slice(5, 7)) - 1]} '${p.month.slice(2, 4)}`);
  lineChart(page, M, y, W, 190, labels, [
    { data: r.series.map(p => p.mine?.spending ?? null), color: C.mine, width: 1.6 },
    { data: r.series.map(p => p.theirs?.spending ?? null), color: C.theirs, width: 1.6 },
    { data: r.series.map(p => p.mine?.income ?? null), color: C.mine, dash: [3, 2], width: 1 },
    { data: r.series.map(p => p.theirs?.income ?? null), color: C.theirs, dash: [3, 2], width: 1 },
  ], { xEvery: Math.max(1, Math.ceil(labels.length / 8)) });
  y += 196;
  legend(page, M, y, [
    { label: 'Your spending', color: C.mine }, { label: `${them}'s spending`, color: C.theirs },
    { label: 'Your income', color: C.mine, dash: true }, { label: `${them}'s income`, color: C.theirs, dash: true },
  ]);
  y += 24;

  y = sectionTitle(page, y, 'Spending mix', 'share of spending — comparable across incomes and currencies');
  const cats = r.spending;
  const colors = cats.map((_, i) => PALETTE[i % PALETTE.length]);
  const mineVals = cats.map(c => c.mine?.monthly ?? 0);
  const theirsVals = cats.map(c => c.theirs?.monthly ?? 0);
  const r0 = 52;
  doughnut(page, M + 70, y + 70, r0, mineVals, colors, 'You');
  doughnut(page, A4.width - M - 70, y + 70, r0, theirsVals, colors, truncateText(them, 8, 60, true));
  // Category table between the doughnuts
  const tx = M + 150;
  const tw = W - 300;
  let ty = y + 8;
  page.text('Category', tx + 12, ty, { size: 7, bold: true, color: C.muted });
  page.text('You', tx + tw - 95, ty, { size: 7, bold: true, color: C.mine, align: 'right' });
  page.text(them, tx + tw - 45, ty, { size: 7, bold: true, color: C.theirs, align: 'right', maxWidth: 48 });
  page.text('diff', tx + tw, ty, { size: 7, bold: true, color: C.muted, align: 'right' });
  ty += 11;
  cats.slice(0, 12).forEach((c, i) => {
    page.rect(tx, ty - 6, 7, 7, { fill: colors[i] });
    page.text(c.category, tx + 12, ty, { size: 7.5, color: C.ink, maxWidth: tw - 160 });
    page.text(c.mine ? pct(c.mine.share) : '—', tx + tw - 95, ty, { size: 7.5, color: C.mine, align: 'right' });
    page.text(c.theirs ? pct(c.theirs.share) : '—', tx + tw - 45, ty, { size: 7.5, color: C.theirs, align: 'right' });
    page.text(`${c.shareDelta > 0 ? '+' : c.shareDelta < 0 ? '−' : ''}${Math.abs(Math.round(c.shareDelta * 100))} pp`, tx + tw, ty, { size: 7.5, color: C.muted, align: 'right' });
    ty += 10.5;
  });
  y += 150;

  // Monthly averages line
  const by = (k: string) => r.metrics.find(m => m.key === k)!;
  const avg = [by('monthlyIncome'), by('monthlyExpenses'), by('monthlySaved'), by('monthlyInvested')];
  page.rect(M, y, W, 40, { fill: C.panel, stroke: C.panelBorder, lineWidth: 0.5 });
  const cw = W / avg.length;
  avg.forEach((m, i) => {
    const x = M + cw * i + 10;
    page.text(m.label.toUpperCase(), x, y + 13, { size: 6.5, color: C.muted });
    page.text(`${metricValue(m.mine, m.unit, r.currency.mine)}`, x, y + 26, { size: 9, bold: true, color: C.mine });
    page.text(`${metricValue(m.theirs, m.unit, r.currency.theirs)}`, x, y + 36, { size: 8, color: C.theirs });
  });
}

function pageOutlook(doc: PdfDocument, input: PdfReportInput): void {
  const r = input.report;
  const them = r.labels.theirs;
  const page = doc.addPage();
  let y = header(page, 'Outlook on current habits', r);
  y = sectionTitle(page, y, 'Projected net worth by age', 'nominal · aligned by age, so different ages line up');
  const markers: { index: number; label: string; color: Rgb }[] = [];
  const idx = (age: number) => r.projection.findIndex(p => p.age === age);
  if (idx(r.profile.mine.retirementAge) >= 0) markers.push({ index: idx(r.profile.mine.retirementAge), label: `you retire at ${r.profile.mine.retirementAge}`, color: C.mine });
  if (idx(r.profile.theirs.retirementAge) >= 0 && r.profile.theirs.retirementAge !== r.profile.mine.retirementAge) markers.push({ index: idx(r.profile.theirs.retirementAge), label: `${them} retires at ${r.profile.theirs.retirementAge}`, color: C.theirs });
  lineChart(page, M, y, W, 200, r.projection.map(p => String(p.age)), [
    { data: r.projection.map(p => p.mine), color: C.mine, width: 1.8 },
    { data: r.projection.map(p => p.theirs), color: C.theirs, width: 1.8 },
  ], { markers, xEvery: Math.max(1, Math.ceil(r.projection.length / 10)) });
  y += 206;
  legend(page, M, y, [{ label: 'You', color: C.mine }, { label: them, color: C.theirs }]);
  y += 24;

  y = sectionTitle(page, y, 'Financial independence & runway');
  const rows = ['fiNumber', 'fiProgress', 'fiDate', 'fiAge', 'yearsToFi', 'fiByRetirement', 'cashMonths', 'totalRunway', 'netWorthAtRetirement', 'successProbability']
    .map(k => r.metrics.find(m => m.key === k)!).filter(Boolean);
  const half = Math.ceil(rows.length / 2);
  const colW = (W - 20) / 2;
  rows.forEach((m, i) => {
    const cx = M + (i < half ? 0 : colW + 20);
    const cy = y + (i % half) * 15;
    page.text(m.label, cx, cy, { size: 8, color: C.ink, maxWidth: colW - 130 });
    page.text(metricValue(m.mine, m.unit, r.currency.mine), cx + colW - 65, cy, { size: 8.5, bold: true, color: C.mine, align: 'right' });
    page.text(metricValue(m.theirs, m.unit, r.currency.theirs), cx + colW, cy, { size: 8.5, color: C.theirs, align: 'right' });
    page.line(cx, cy + 4, cx + colW, cy + 4, { color: C.grid, width: 0.3 });
  });
  y += half * 15 + 14;

  const wi = input.whatIf;
  if (wi && (wi.extraSaving > 0 || wi.extraInvesting > 0)) {
    y = sectionTitle(page, y, 'What if you did a bit more?', `save +${money(wi.extraSaving, r.currency.mine)} and invest +${money(wi.extraInvesting, r.currency.mine)} a month`);
    page.rect(M, y - 4, W, 92, { fill: hex('#f0fdf4'), stroke: hex('#86efac'), lineWidth: 0.5 });
    const cols = [M + 10, M + 250, M + 360, M + 470];
    page.text('', cols[0], y + 10);
    page.text('You now', cols[1], y + 10, { size: 7.5, bold: true, color: C.muted, align: 'right' });
    page.text('You, doing more', cols[2], y + 10, { size: 7.5, bold: true, color: C.green, align: 'right' });
    page.text(them, cols[3], y + 10, { size: 7.5, bold: true, color: C.theirs, align: 'right', maxWidth: 100 });
    const theirsBy = Object.fromEntries(r.metrics.map(m => [m.key, m]));
    const lines: [string, keyof WhatIfPoint, (v: any) => string][] = [
      ['Savings rate', 'savingsRate', v => pct(v)],
      ['FI date', 'fiDate', v => (v ? monthLabel(v) : 'not in sight')],
      ['Age at FI', 'fiAge', v => (typeof v === 'number' ? v.toFixed(1) : '—')],
      ['Months of spending in cash', 'cashMonths', v => (typeof v === 'number' ? `${v.toFixed(1)} mo` : '—')],
      ['Net worth at retirement', 'netWorthAtRetirement', v => money(v, r.currency.mine)],
    ];
    let ly = y + 24;
    for (const [label, key, fmt] of lines) {
      page.text(label, cols[0], ly, { size: 8, color: C.ink });
      page.text(fmt(wi.result.base[key]), cols[1], ly, { size: 8, color: C.muted, align: 'right' });
      const changed = JSON.stringify(wi.result.base[key]) !== JSON.stringify(wi.result.both[key]);
      page.text(fmt(wi.result.both[key]), cols[2], ly, { size: 8, bold: changed, color: changed ? C.green : C.ink, align: 'right' });
      page.text(fmt(theirsBy[key]?.theirs ?? null), cols[3], ly, { size: 8, color: C.theirs, align: 'right' });
      ly += 12.5;
    }
    y += 100;
  }
}

function pageGoalsHabitsBadges(doc: PdfDocument, input: PdfReportInput): void {
  const r = input.report;
  const them = r.labels.theirs;
  const page = doc.addPage();
  let y = header(page, 'Goals, habits & badges', r);
  const colW = (W - 20) / 2;

  y = sectionTitle(page, y, 'Goals', `you ${r.goals.summary.mine.onTrack}/${r.goals.summary.mine.count} on track · ${them} ${r.goals.summary.theirs.onTrack}/${r.goals.summary.theirs.count}`);
  const goalCol = (x: number, who: string, goals: ComparisonReport['goals']['mine'], currency: string, color: Rgb, startY: number) => {
    let gy = startY;
    page.text(who, x, gy, { size: 8, bold: true, color, maxWidth: colW });
    gy += 12;
    if (!goals.length) { page.text('No goals', x, gy, { size: 8, color: C.muted }); return gy + 12; }
    for (const g of goals.slice(0, 8)) {
      page.text(g.name, x, gy, { size: 8, color: C.ink, maxWidth: colW - 70 });
      const status = g.status.replace('_', ' ');
      page.text(status, x + colW, gy, { size: 7, color: g.status === 'funded' || g.status === 'on_track' ? C.green : g.status === 'at_risk' ? C.orange : hex('#dc2626'), align: 'right' });
      progressBar(page, x, gy + 4, colW, g.progress, color);
      page.text(`${money(g.current, currency)} of ${money(g.target, currency)} · ${Math.round(g.progress * 100)}%${g.deadline ? ` · by ${dateLabel(g.deadline)}` : ''}`, x, gy + 18, { size: 6.5, color: C.muted, maxWidth: colW });
      gy += 30;
    }
    return gy;
  };
  const gEnd = Math.max(goalCol(M, 'You', r.goals.mine, r.currency.mine, C.mine, y), goalCol(M + colW + 20, them, r.goals.theirs, r.currency.theirs, C.theirs, y));
  y = gEnd + 6;

  y = sectionTitle(page, y, 'Habits');
  const habitCol = (x: number, who: string, habits: ComparisonReport['habits']['mine'], currency: string, color: Rgb, startY: number) => {
    let hy = startY;
    page.text(who, x, hy, { size: 8, bold: true, color, maxWidth: colW });
    hy += 12;
    if (!habits.length) { page.text('No habits yet', x, hy, { size: 8, color: C.muted }); return hy + 12; }
    for (const h of habits) {
      page.text(h.name, x, hy, { size: 8, color: C.ink, maxWidth: colW });
      page.text(`${h.kind === 'swap' ? `${h.category ?? ''} under ` : ''}${money(h.amount, currency)} ${h.cadence} · streak ${h.streak} (best ${h.bestStreak}) · hit ${h.periodsMet}/${h.periodsScored} · ${h.pointsEarned} pts`, x, hy + 10, { size: 6.5, color: C.muted, maxWidth: colW });
      hy += 22;
    }
    return hy;
  };
  y = Math.max(habitCol(M, 'You', r.habits.mine, r.currency.mine, C.mine, y), habitCol(M + colW + 20, them, r.habits.theirs, r.currency.theirs, C.theirs, y)) + 6;

  y = sectionTitle(page, y, 'Badges', `you ${r.badges.filter(b => b.mine).length} · ${them} ${r.badges.filter(b => b.theirs).length}`);
  const perRow = 4;
  const bw = (W - (perRow - 1) * 8) / perRow;
  r.badges.forEach((b, i) => {
    const bx = M + (i % perRow) * (bw + 8);
    const by = y + Math.floor(i / perRow) * 30;
    const any = !!(b.mine || b.theirs);
    page.rect(bx, by - 8, bw, 24, { fill: any ? C.white : C.panel, stroke: any ? C.panelBorder : C.grid, lineWidth: 0.5 });
    page.text(b.name, bx + 6, by + 2, { size: 7.5, bold: any, color: any ? C.ink : C.light, maxWidth: bw - 60 });
    page.circle(bx + bw - 34, by - 1, 3.5, { fill: b.mine ? C.mine : C.grid });
    page.circle(bx + bw - 14, by - 1, 3.5, { fill: b.theirs ? C.theirs : C.grid });
    page.text(`${b.mine ? dateLabel(b.mine).slice(-8) : ''}`, bx + 6, by + 11, { size: 5.5, color: C.mine, maxWidth: bw - 60 });
  });
  y += Math.ceil(r.badges.length / perRow) * 30 + 4;
  legend(page, M, y, [{ label: 'dot filled: you have it', color: C.mine }, { label: `dot filled: ${them} has it`, color: C.theirs }]);
}

/** Render the whole report. */
export function renderComparePdf(input: PdfReportInput): Buffer {
  const r = input.report;
  const doc = new PdfDocument({ title: `FinFolio — You vs ${r.labels.theirs}`, author: 'FinFolio', subject: 'Side-by-side comparison', createdAt: input.generatedAt });
  pageCover(doc, input);
  pageMetrics(doc, input);
  pageCashflow(doc, input);
  pageOutlook(doc, input);
  pageGoalsHabitsBadges(doc, input);
  doc.pages.forEach((p, i) => footer(p, i + 1, doc.pages.length, input));
  return doc.render();
}

/** File name for the download. */
export function comparePdfFileName(theirsLabel: string, date: string): string {
  const base = theirsLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'friend';
  return `finfolio-compare-${base}-${date}.pdf`;
}
