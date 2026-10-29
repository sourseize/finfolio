// ── Badge icons: hand-drawn inline SVG, no image files, no icon fonts ──
// Every icon is a 24×24 line drawing using currentColor, so CSS decides the colour
// (gold / green when unlocked, grey when locked). Total < 4 KB.

const BADGE_SVG = {
  footprint: '<ellipse cx="10" cy="13" rx="4" ry="6"/><circle cx="6" cy="6" r="1.4"/><circle cx="9.5" cy="4.5" r="1.4"/><circle cx="13" cy="5" r="1.4"/><circle cx="16" cy="7" r="1.2"/><path d="M7 19.5c1.5 1.5 4.5 1.5 6 0"/>',
  hundred: '<circle cx="12" cy="12" r="9.5"/><text x="12" y="15.5" text-anchor="middle" font-size="8.5" font-weight="700" font-family="inherit" fill="currentColor" stroke="none">100</text>',
  thousand: '<path d="M12 2.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 8.8l6.1-.7z"/><text x="12" y="14.5" text-anchor="middle" font-size="6" font-weight="700" font-family="inherit" fill="currentColor" stroke="none">1K</text>',
  flame: '<path d="M12 21c-4 0-7-2.8-7-6.5 0-3.2 2.2-5 3.2-7.5.6 1.5 1.3 2.3 2.3 3 0-3 1-5.5 3.5-8 0 3 1.5 4.5 3.2 6.3C18.7 10 19 12 19 14.5 19 18.2 16 21 12 21z"/><path d="M12 21c-1.7 0-3-1.3-3-3 0-1.5 1.2-2.3 1.6-3.4.6.9 1.4 1.2 1.4 2.4.5-.7.7-1.4.6-2.4 1.5 1.3 2.4 2.3 2.4 3.4 0 1.7-1.3 3-3 3z"/>',
  bolt: '<path d="M13.5 2 5 13.5h6L10.5 22 19 10.5h-6z"/>',
  gift: '<rect x="3" y="9" width="18" height="4"/><path d="M5 13v8h14v-8M12 9v12"/><path d="M12 9c-2.5 0-5-1.2-5-3.2C7 4.2 9 3.5 10.2 4.6 11.4 5.7 12 7.5 12 9zm0 0c2.5 0 5-1.2 5-3.2 0-1.6-2-2.3-3.2-1.2C12.6 5.7 12 7.5 12 9z"/>',
  brick: '<rect x="3" y="14" width="8" height="5"/><rect x="11" y="14" width="10" height="5"/><rect x="7" y="9" width="10" height="5"/><rect x="3" y="9" width="4" height="5"/><rect x="17" y="9" width="4" height="5"/><rect x="3" y="4" width="8" height="5"/><rect x="11" y="4" width="10" height="5"/>',
  seedling: '<path d="M12 21v-8"/><path d="M12 13c0-3.5-2.5-6-6-6 0 3.5 2.5 6 6 6z"/><path d="M12 11c0-3 2-5.5 5.5-5.5C17.5 8.5 15.5 11 12 11z"/>',
  sprout: '<path d="M12 21V9"/><path d="M12 15c-1-4-4-5.5-7.5-5.5C5 13.5 8 15 12 15z"/><path d="M12 12c1-4 4-5.5 7.5-5.5C19 10.5 16 12 12 12z"/><path d="M12 9c0-3 1.5-5 3.5-6.5C15.5 5 14.5 7.5 12 9z"/>',
  tree: '<path d="M12 2.5 6 10h3l-4 6h5v5.5h4V16h5l-4-6h3z"/>',
  mountain: '<path d="M2 20 9 7l3 5 2-3 8 11z"/><path d="M9 7l1.5 2.5L12 8l1 1.5"/>',
  flag: '<path d="M5 22V3"/><path d="M5 4h13l-3 4 3 4H5"/>',
  arrow: '<circle cx="12" cy="12" r="9.5"/><path d="M15.5 12h-7"/><path d="M11.5 9l-3 3 3 3"/><path d="M12 5.5v2M12 16.5v2"/>',
};

/** An inline SVG for a badge icon. */
function badgeSvg(icon, size = 28) {
  const body = BADGE_SVG[icon] || BADGE_SVG.footprint;
  return `<svg class="badge-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Colour family per badge: FI badges grow green, streaks burn orange, the rest are gold. */
function badgeTone(b) {
  if (b.id.startsWith('fi-') || b.id === 'closer') return 'green';
  if (b.id === 'on-fire' || b.id === 'unstoppable') return 'orange';
  return 'gold';
}

/** A badge tile: unlocked in colour with its date, locked grey with how to earn it. */
function badgeTile(b, opts = {}) {
  const unlocked = !!b.unlockedOn;
  const size = opts.size || 28;
  const title = unlocked ? `${b.name} — ${b.detail || b.description} · ${formatDate(b.unlockedOn)}` : `${b.name} — ${b.description}`;
  return `
    <div class="badge-tile ${unlocked ? 'unlocked' : 'locked'} tone-${badgeTone(b)}" data-id="${b.id}" title="${escapeHtml(title)}">
      ${badgeSvg(b.icon, size)}
      ${opts.compact ? '' : `<span class="badge-name">${escapeHtml(b.name)}</span><span class="badge-sub">${escapeHtml(unlocked ? formatDate(b.unlockedOn) : b.description)}</span>`}
    </div>`;
}
