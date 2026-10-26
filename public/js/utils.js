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
const Chart = {
  bar(canvas, labels, data) {
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = (rect.width * 0.45) * dpr;
    canvas.style.height = `${rect.width * 0.45}px`;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.width * 0.45;
    const pad = { top: 20, bottom: 40, left: 60, right: 20 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const maxVal = Math.max(...data) * 1.15 || 1;
    const gap = cw / data.length;
    const barW = Math.min(gap * 0.6, 40);

    ctx.clearRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(maxVal - (maxVal / 4) * i), pad.left - 8, y + 3);
    }

    // Bars
    data.forEach((val, i) => {
      const x = pad.left + gap * i + (gap - barW) / 2;
      const barH = (val / maxVal) * ch;
      const y = pad.top + ch - barH;
      const grad = ctx.createLinearGradient(x, y, x, pad.top + ch);
      grad.addColorStop(0, '#00d4ff');
      grad.addColorStop(1, '#0090ff');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[i], x + barW / 2, pad.top + ch + 20);
    });
  },

  doughnut(canvas, labels, data, colors) {
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = Math.min(canvas.parentElement.offsetWidth || 250, 250);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.4, innerR = outerR * 0.6;
    const total = data.reduce((s, v) => s + v, 0) || 1;
    let startAngle = -Math.PI / 2;
    ctx.clearRect(0, 0, size, size);
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
      startAngle += slice;
    });
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatCurrency(total), cx, cy - 6);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px sans-serif';
    ctx.fillText('Total', cx, cy + 14);
  },

  line(canvas, labels, datasets) {
    if (!canvas || !labels.length) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = (rect.width * 0.4) * dpr;
    canvas.style.height = `${rect.width * 0.4}px`;
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.width * 0.4;
    const pad = { top: 20, bottom: 40, left: 60, right: 20 };
    const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    let allVals = [];
    datasets.forEach(ds => allVals = allVals.concat(ds.data));
    const maxVal = Math.max(...allVals) * 1.15 || 1;
    const minVal = Math.min(...allVals) * 0.85 || 0;
    const range = maxVal - minVal || 1;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatCurrency(maxVal - (maxVal - minVal) / 4 * i), pad.left - 8, y + 3);
    }
    const stepX = cw / (labels.length - 1 || 1);
    datasets.forEach(ds => {
      ctx.strokeStyle = ds.color || '#00d4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ds.data.forEach((val, i) => {
        const x = pad.left + stepX * i;
        const y = pad.top + ch - ((val - minVal) / range) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ds.data.forEach((val, i) => {
        const x = pad.left + stepX * i;
        const y = pad.top + ch - ((val - minVal) / range) * ch;
        ctx.fillStyle = ds.color || '#00d4ff';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((label, i) => ctx.fillText(label, pad.left + stepX * i, h - pad.bottom + 18));
  },
};
