// ── Helpers ──
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

/** Compact money for chart axes: $1.2M, $850K, -$3.4K. */
function formatCompact(amount, currency = 'USD') {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' ';
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return `${sign}${sym}${abs.toFixed(0)}`;
}

/** Category semantics (mirrors the server): transfers are never income/spending; 'Investment' expenses are saving. */
const TRANSFER_CATEGORY = 'Transfer';
const INVESTMENT_CATEGORY = 'Investment';
/** Imported rows nothing recognises land here; re-categorise from the transactions list. */
const UNCATEGORIZED_CATEGORY = 'Uncategorized';
/** Mirrors TRANSACTION_CATEGORIES on the server. */
const TRANSACTION_CATEGORIES = ['Food & Dining','Transportation','Housing','Utilities','Entertainment','Shopping','Healthcare','Education','Salary','Freelance',INVESTMENT_CATEGORY,'Gift',TRANSFER_CATEGORY,'Other',UNCATEGORIZED_CATEGORY];
function isIncomeTxn(t) { return t.type === 'income' && t.category !== TRANSFER_CATEGORY; }
function isSpendingTxn(t) { return t.type === 'expense' && t.category !== TRANSFER_CATEGORY && t.category !== INVESTMENT_CATEGORY; }
function isTransferTxn(t) { return t.category === TRANSFER_CATEGORY || (t.type === 'expense' && t.category === INVESTMENT_CATEGORY); }

/** True when an account's balance represents money owed. */
function isLiabilityAccount(account) {
  return account.type === 'credit';
}

/**
 * Render an account balance consistently across pages.
 * Credit accounts hold the amount owed as a positive number → shown in red with "owed";
 * a negative credit balance is an overpayment in your favour → shown as a credit.
 * Returns { text, cls, note } where cls is a `.card-value` modifier ('', 'red', 'green').
 */
function describeAccountBalance(account) {
  const amount = formatCurrency(Math.abs(account.balance), account.currency);
  if (!isLiabilityAccount(account)) {
    return { text: formatCurrency(account.balance, account.currency), cls: account.balance < 0 ? 'red' : '', note: '' };
  }
  if (account.balance > 0) return { text: amount, cls: 'red', note: 'amount owed' };
  if (account.balance < 0) return { text: amount, cls: 'green', note: 'credit in your favour' };
  return { text: amount, cls: '', note: 'nothing owed' };
}

/** 'YYYY-MM' → 'Sep 2042'. */
function formatPeriod(period) {
  if (!period) return '—';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Months → '2 yrs 3 mo'. */
function formatMonths(months) {
  if (months === null || months === undefined || !Number.isFinite(months)) return '—';
  const m = Math.round(months);
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (y === 0) return `${r} mo`;
  if (r === 0) return `${y} yr${y > 1 ? 's' : ''}`;
  return `${y} yr${y > 1 ? 's' : ''} ${r} mo`;
}

function formatPercent(fraction, digits = 0) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Simple Chart Library (no dependencies) ──
//
// Every chart goes through prepareCanvas(): the bitmap is sized from the
// element's real CSS width × devicePixelRatio, so lines and text stay crisp
// and the aspect ratio is never distorted by stylesheet rules.
const CHART_STYLE = {
  font: () => `12px ${(typeof getComputedStyle === 'function' && getComputedStyle(document.body).fontFamily) || 'system-ui, sans-serif'}`,
  fontSmall: () => `11px ${(typeof getComputedStyle === 'function' && getComputedStyle(document.body).fontFamily) || 'system-ui, sans-serif'}`,
  axis: 'rgba(224, 224, 255, 0.78)',
  axisMuted: 'rgba(224, 224, 255, 0.55)',
  grid: 'rgba(255, 255, 255, 0.08)',
  zero: 'rgba(255, 255, 255, 0.25)',
};

/**
 * Size a canvas for crisp rendering.
 *  - square: { size } → a centred square no wider than the parent
 *  - otherwise: full width of the element, height = width × ratio (clamped)
 * Returns { ctx, w, h } in CSS pixels; the context is pre-scaled for the DPR.
 */
function prepareCanvas(canvas, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const parentWidth = (canvas.parentElement && canvas.parentElement.clientWidth) || 600;
  canvas.style.display = 'block';
  let w, h;
  if (opts.size) {
    w = h = Math.max(120, Math.min(opts.size, parentWidth));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.margin = '0 auto';
  } else {
    canvas.style.width = '100%';
    canvas.style.margin = '';
    w = canvas.clientWidth || parentWidth;
    h = Math.max(opts.minHeight || 200, Math.min(opts.maxHeight || 440, Math.round(w * (opts.ratio || 0.45))));
    canvas.style.height = `${h}px`;
  }
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Horizontal grid lines with y-axis labels; returns the y() mapper. */
function drawYAxis(ctx, pad, w, h, minVal, maxVal, format) {
  const ch = h - pad.top - pad.bottom;
  const range = maxVal - minVal || 1;
  const y = v => pad.top + ch - ((v - minVal) / range) * ch;
  ctx.font = CHART_STYLE.fontSmall();
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = maxVal - (range / 4) * i;
    const yy = y(v);
    ctx.strokeStyle = CHART_STYLE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
    ctx.fillStyle = CHART_STYLE.axisMuted;
    ctx.textAlign = 'right';
    ctx.fillText(format(v), pad.left - 8, yy);
  }
  if (minVal < 0 && maxVal > 0) {
    ctx.strokeStyle = CHART_STYLE.zero;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(w - pad.right, y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  return y;
}

function drawXLabels(ctx, labels, x, h, pad, every = 1) {
  ctx.fillStyle = CHART_STYLE.axis;
  ctx.font = CHART_STYLE.font();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  labels.forEach((label, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    ctx.fillText(label, x(i), h - pad.bottom + 20);
  });
}

const Chart = {
  bar(canvas, labels, data) {
    if (!canvas || !data.length) return;
    const { ctx, w, h } = prepareCanvas(canvas, { ratio: 0.5, maxHeight: 320 });
    const pad = { top: 16, bottom: 40, left: 70, right: 16 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const maxVal = Math.max(0, ...data) * 1.15 || 1;
    const minVal = Math.min(0, ...data) * 1.15;
    const y = drawYAxis(ctx, pad, w, h, minVal, maxVal, formatCompact);
    const gap = cw / data.length;
    const barW = Math.min(gap * 0.6, 48);
    data.forEach((val, i) => {
      const x = pad.left + gap * i + (gap - barW) / 2;
      const top = y(Math.max(0, val));
      const bottom = y(Math.min(0, val));
      const grad = ctx.createLinearGradient(x, top, x, bottom);
      grad.addColorStop(0, val >= 0 ? '#00d4ff' : '#ff5252');
      grad.addColorStop(1, val >= 0 ? '#0090ff' : '#d32f2f');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, top, barW, Math.max(1, bottom - top), [4, 4, 0, 0]);
      ctx.fill();
    });
    const every = Math.max(1, Math.ceil(labels.length / 8));
    drawXLabels(ctx, labels.map(l => (String(l).length > 14 ? String(l).slice(0, 13) + '…' : l)), i => pad.left + gap * i + gap / 2, h, pad, every);
  },

  doughnut(canvas, labels, data, colors) {
    if (!canvas || !data.length) return;
    const { ctx, w: size } = prepareCanvas(canvas, { size: 260 });
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.42, innerR = outerR * 0.62;
    const total = data.reduce((s, v) => s + v, 0) || 1;
    let startAngle = -Math.PI / 2;
    const defColors = ['#00d4ff','#00e676','#ff5252','#ffab40','#b388ff','#ffd740','#7c4dff'];
    data.forEach((val, i) => {
      if (val === 0) return;
      const slice = (val / total) * Math.PI * 2;
      const color = colors && colors[i] ? colors[i] : defColors[i % defColors.length];
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, startAngle + slice);
      ctx.arc(cx, cy, innerR, startAngle + slice, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      // hairline gap between slices
      ctx.strokeStyle = 'rgba(22, 33, 62, 1)';
      ctx.lineWidth = 2;
      ctx.stroke();
      startAngle += slice;
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(224, 224, 255, 0.95)';
    ctx.font = `bold 16px ${(typeof getComputedStyle === 'function' && getComputedStyle(document.body).fontFamily) || 'sans-serif'}`;
    ctx.fillText(formatCompact(total), cx, cy - 8);
    ctx.fillStyle = CHART_STYLE.axisMuted;
    ctx.font = CHART_STYLE.fontSmall();
    ctx.fillText('Total', cx, cy + 12);
  },

  line(canvas, labels, datasets) {
    if (!canvas || !labels.length) return;
    const { ctx, w, h } = prepareCanvas(canvas, { ratio: 0.42, maxHeight: 340 });
    const pad = { top: 16, bottom: 40, left: 70, right: 16 };
    const cw = w - pad.left - pad.right;
    let allVals = [];
    datasets.forEach(ds => allVals = allVals.concat(ds.data));
    const maxVal = Math.max(0, ...allVals) * 1.12 || 1;
    const minVal = Math.min(0, ...allVals) * 1.12;
    const y = drawYAxis(ctx, pad, w, h, minVal, maxVal, formatCompact);
    const stepX = cw / (labels.length - 1 || 1);
    const x = i => pad.left + stepX * i;
    datasets.forEach(ds => {
      ctx.strokeStyle = ds.color || '#00d4ff';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ds.data.forEach((val, i) => (i === 0 ? ctx.moveTo(x(i), y(val)) : ctx.lineTo(x(i), y(val))));
      ctx.stroke();
      ds.data.forEach((val, i) => {
        ctx.fillStyle = ds.color || '#00d4ff';
        ctx.beginPath();
        ctx.arc(x(i), y(val), 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    drawXLabels(ctx, labels, x, h, pad, Math.max(1, Math.ceil(labels.length / 8)));
  },

  /**
   * Multi-series projection chart: handles negative values, optional shaded bands
   * (e.g. Monte Carlo P10–P90), dashed comparison lines and vertical markers.
   *
   * datasets: [{ label, data: number[], color, dash?: number[], width?, band?: { lower: number[], upper: number[] }, points?: boolean }]
   * options:  { heightRatio?, yFormat?, markers?: [{ index, label, color }], xLabelEvery? }
   */
  projection(canvas, labels, datasets, options = {}) {
    if (!canvas || !labels.length) return;
    const { ctx, w, h } = prepareCanvas(canvas, { ratio: options.heightRatio || 0.42, minHeight: 220, maxHeight: 440 });
    const pad = { top: 18, bottom: 40, left: 70, right: 16 };
    const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    const yFormat = options.yFormat || formatCompact;

    let all = [];
    datasets.forEach(ds => {
      all = all.concat(ds.data.filter(Number.isFinite));
      if (ds.band) all = all.concat(ds.band.lower.filter(Number.isFinite), ds.band.upper.filter(Number.isFinite));
    });
    if (!all.length) return;
    let maxVal = Math.max(0, ...all);
    let minVal = Math.min(0, ...all);
    if (maxVal === minVal) { maxVal += 1; minVal -= 1; }
    const padY = (maxVal - minVal) * 0.06;
    maxVal += padY;
    if (minVal < 0) minVal -= padY;
    const x = i => pad.left + (cw / (labels.length - 1 || 1)) * i;
    const y = drawYAxis(ctx, pad, w, h, minVal, maxVal, yFormat);

    // Bands first (behind lines)
    datasets.forEach(ds => {
      if (!ds.band) return;
      ctx.beginPath();
      ds.band.upper.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
      for (let i = ds.band.lower.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(ds.band.lower[i]));
      ctx.closePath();
      ctx.fillStyle = ds.band.color || hexToRgba(ds.color || '#00d4ff', 0.14);
      ctx.fill();
    });

    // Markers
    ctx.font = CHART_STYLE.fontSmall();
    ctx.textBaseline = 'alphabetic';
    (options.markers || []).forEach(m => {
      if (m.index === null || m.index === undefined || m.index < 0 || m.index > labels.length - 1) return;
      const xx = x(m.index);
      ctx.strokeStyle = m.color || 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(xx, pad.top); ctx.lineTo(xx, pad.top + ch); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color || CHART_STYLE.axis;
      ctx.textAlign = xx > w * 0.8 ? 'right' : 'left';
      ctx.fillText(m.label, xx + (xx > w * 0.8 ? -5 : 5), pad.top + 12);
    });

    // Lines
    datasets.forEach(ds => {
      ctx.strokeStyle = ds.color || '#00d4ff';
      ctx.lineWidth = ds.width || 2;
      ctx.lineJoin = 'round';
      ctx.setLineDash(ds.dash || []);
      ctx.beginPath();
      let started = false;
      ds.data.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (ds.points) {
        ds.data.forEach((v, i) => {
          if (!Number.isFinite(v)) return;
          ctx.fillStyle = ds.color || '#00d4ff';
          ctx.beginPath(); ctx.arc(x(i), y(v), 2.5, 0, Math.PI * 2); ctx.fill();
        });
      }
    });

    drawXLabels(ctx, labels, x, h, pad, options.xLabelEvery || Math.max(1, Math.ceil(labels.length / 10)));
  },
};

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}
