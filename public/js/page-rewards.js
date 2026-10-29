// ── REWARDS: habits → points → rewards ──
//
// Two surfaces:
//   • App.renderRewardsCard(el) — the dashboard card (points bar, this period's habits, latest trail lines, "reward ready")
//   • App.renderRewards(el)     — the 🏅 Rewards page (reward list + claim, habit cards, full trail, the rule set)
// Both read GET /api/motivation; points are recomputed server-side from the transactions.

const HABIT_ICON = { save: '💰', invest: '📈', swap: '☕' };
const HABIT_VERB = { save: 'Save', invest: 'Invest', swap: 'Keep' };

/** Money without cents for the compact habit lines. */
function formatWhole(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function formatPoints(n) {
  return n.toLocaleString('en-US');
}

/** "Save $250 a week" / "Keep Food & Dining under $175 a week". */
function describeHabit(h) {
  const per = h.cadence === 'weekly' ? 'a week' : 'a month';
  if (h.kind === 'swap') return `Keep ${h.category} under ${formatWhole(h.amount)} ${per}`;
  return `${HABIT_VERB[h.kind]} ${formatWhole(h.amount)} ${per}`;
}

/** One line for the current period: "$900 of $900 · +50 pts" / "$164 of the $175 cap · 2 days left". */
function describeCurrent(h, today) {
  const p = h.current;
  const daysLeft = Math.max(0, Math.round((new Date(p.end + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000)) + 1;
  const left = p.completed ? '' : daysLeft <= 1 ? ' · last day' : ` · ${daysLeft} days left`;
  if (h.kind === 'swap') {
    return p.progress > p.target
      ? `${formatWhole(p.progress)} spent — over the ${formatWhole(p.target)} cap${left}`
      : `${formatWhole(p.progress)} of the ${formatWhole(p.target)} cap${left}`;
  }
  if (p.met) return `${formatWhole(p.progress)} of ${formatWhole(p.target)} · +${p.points} pts`;
  return `${formatWhole(p.progress)} of ${formatWhole(p.target)}${left}`;
}

function habitState(h) {
  const p = h.current;
  if (p.met) return 'met';
  if (h.kind === 'swap') return p.progress > p.target ? 'over' : 'track';
  return 'open';
}

function streakChip(h) {
  if (h.streak >= 2) return `<span class="chip streak" title="${h.streak} in a row${h.streak >= 4 ? ' — points doubled' : ''}">🔥 ${h.streak}</span>`;
  return '';
}

/** Dots strip of the last periods (oldest → newest). */
function periodDots(h) {
  return `<span class="dots">${h.recent.map(p => {
    const cls = p.met ? 'met' : p.completed ? 'miss' : 'open';
    const title = `${p.start} → ${p.end}: ${p.met ? `+${p.points}` : p.completed ? 'missed' : 'in progress'}`;
    return `<i class="dot ${cls}" title="${escapeHtml(title)}"></i>`;
  }).join('')}</span>`;
}

/**
 * The points bar fills towards the next reward you cannot afford yet (or the next
 * 100-step when the list is empty). Anything already affordable shows as "ready".
 */
function pointsBar(m) {
  const pts = m.points;
  const ready = m.rewards.filter(r => r.ready);
  const next = pts.nextReward;
  const pct = Math.round(pts.progress * 100);
  const headline = next
    ? `${formatPoints(pts.toNextReward)} more for <b>${escapeHtml(next.name)}</b> (${formatPoints(next.cost)})`
    : m.rewards.length ? 'Every reward on your list is within reach' : '';
  return `
    <div class="rewards-points">
      <div class="flex items-center justify-between" style="flex-wrap:wrap;gap:6px">
        <div><span class="rewards-big">${formatPoints(pts.balance)}</span> <span class="text-muted text-sm">points</span></div>
        <div class="text-sm text-muted">${headline}</div>
      </div>
      <div class="progress-bar mt-1 ${ready.length ? 'glow' : ''}"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="flex justify-between text-xs text-muted mt-1" style="flex-wrap:wrap;gap:6px">
        <span>${ready.length ? ready.map(r => `<span class="chip ready" title="within reach since ${formatDate(r.readySince)} (${r.readyDays} days)">🎁 ${escapeHtml(r.name)} ready</span>`).join(' ') : next ? `${pct}% of the way` : ''}</span>
        <span>${formatPoints(pts.earned)} earned · <a class="link enjoyed-link" href="#rewards" title="See every reward enjoyed">${formatPoints(pts.spent)} enjoyed${m.claims.length ? ` (${m.claims.length} reward${m.claims.length === 1 ? '' : 's'})` : ''}</a></span>
      </div>
      ${m.nudge ? `<div class="nudge mt-1">${nudgeText(m)}</div>` : ''}
    </div>`;
}

/**
 * The nudge, spelled out: everything within reach with how long it has been waiting,
 * the biggest treat on offer, and what banking would buy next. Changes with every day and every point.
 */
function nudgeText(m) {
  const ready = m.rewards.filter(r => r.ready);
  const biggest = ready[ready.length - 1];
  const list = ready.map(r => `<b>${escapeHtml(r.name)}</b> (${formatPoints(r.cost)} pts, since ${formatDate(r.readySince)} — ${r.readyDays} days)`).join(', ');
  const next = m.points.nextReward && m.points.nextReward.id ? ` Or keep banking: ${formatPoints(m.points.toNextReward)} more and <b>${escapeHtml(m.points.nextReward.name)}</b> is yours.` : '';
  return `🎉 With ${formatPoints(m.points.balance)} points you can treat yourself to ${list}. ${biggest ? `Go for <b>${escapeHtml(biggest.name)}</b> — you have earned it.` : ''}${next}`;
}

function ledgerLine(e) {
  const icon = e.kind === 'habit' ? '✔' : e.kind === 'miss' ? '✘' : e.kind === 'reward' ? '🎁' : '🏅';
  const pts = e.points > 0 ? `<span class="pts plus">+${e.points}</span>` : e.points < 0 ? `<span class="pts minus">${e.points}</span>` : `<span class="pts zero">0</span>`;
  return `
    <div class="trail-line ${e.kind}">
      <span class="trail-date">${formatDate(e.date)}</span>
      <span class="trail-icon">${icon}</span>
      <span class="trail-body"><span class="trail-title">${escapeHtml(e.title)}</span><span class="trail-detail">${escapeHtml(e.detail)}</span></span>
      ${pts}
      <span class="trail-balance" title="Points after this entry">${e.balance}</span>
    </div>`;
}

function habitRow(h, today) {
  const state = habitState(h);
  const mark = state === 'met' ? '✔' : state === 'over' ? '✘' : '○';
  return `
    <div class="habit-row ${state}" data-id="${h.id}">
      <span class="habit-mark">${mark}</span>
      <span class="habit-icon">${HABIT_ICON[h.kind]}</span>
      <span class="habit-body">
        <span class="habit-name">${escapeHtml(h.name)} ${streakChip(h)}</span>
        <span class="habit-sub">${escapeHtml(describeCurrent(h, today))}</span>
      </span>
      ${periodDots(h)}
    </div>`;
}

// ── Dashboard card ──
App.renderRewardsCard = async function(el) {
  if (!el) return;
  try {
    const m = await API.getMotivation();
    if (!m.enabled) {
      el.innerHTML = `
        <div class="card rewards-card">
          <div class="card-header"><span class="card-title">🏅 Habits & rewards</span><a href="#rewards" class="text-sm">Set up →</a></div>
          <div class="text-sm text-muted">Turn good money habits into a game: save or invest a target amount each week or month, keep a spending category under a cap, earn points, unlock rewards you choose. Two minutes to set up.</div>
          <a href="#rewards" class="btn btn-primary btn-sm mt-2" id="rewards-start">Start with a habit</a>
        </div>`;
      return;
    }
    const recent = m.ledger.slice(0, 5);
    const ready = m.rewards.filter(r => r.ready);
    el.innerHTML = `
      <div class="card rewards-card">
        <div class="card-header"><span class="card-title">🏅 Habits & rewards</span><a href="#rewards" class="text-sm">Rewards, habits & the full trail →</a></div>
        <div class="rewards-grid">
          <div>
            ${pointsBar(m)}
            ${ready.length ? `<a href="#rewards" class="reward-ready-banner mt-1" id="rewards-claim-link">🎁 <b>${escapeHtml(ready[ready.length - 1].name)}</b> is ready to claim →</a>` : ''}
            <div class="habit-list mt-2" id="rewards-habits">${m.habits.map(h => habitRow(h, m.today)).join('')}</div>
            <div class="badge-strip mt-2" id="rewards-badges" title="Badges — see them all on the Rewards page">${m.badges.map(b => badgeTile(b, { compact: true, size: 22 })).join('')}</div>
          </div>
          <div class="trail" id="rewards-recent">
            <div class="text-xs text-muted mb-1" style="text-transform:uppercase;letter-spacing:.06em">Latest</div>
            ${recent.length ? recent.map(ledgerLine).join('') : '<div class="text-sm text-muted">Nothing scored yet — the first completed week or month will show up here.</div>'}
          </div>
        </div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<div class="card rewards-card"><div class="text-muted text-sm">Rewards unavailable: ${escapeHtml(err.message)}</div></div>`;
  }
};

// ── Rewards page ──
App.renderRewards = async function(container) {
  container.innerHTML = '<div class="text-center text-muted mt-2">Loading rewards...</div>';
  try {
    const m = await API.getMotivation();
    this.rewardsPage = { data: m, filter: (this.rewardsPage && this.rewardsPage.filter) || 'all', shown: 30 };
    const rules = m.rules;
    const todayClaims = m.claims.filter(c => c.date === m.today);
    container.innerHTML = `
      <div class="page-header">
        <h1>🏅 Rewards</h1>
        <div class="flex gap-1">
          <button class="btn btn-secondary" id="add-habit-btn">+ New habit</button>
          <button class="btn btn-primary" id="add-reward-btn">+ New reward</button>
        </div>
      </div>
      <div class="text-sm text-muted mb-2">Hit a habit, earn points. Keep a ${rules.streakBonusAt}-in-a-row streak and points double. Spend points on rewards you chose — or let them bank for a bigger one.</div>

      <div class="card mb-2">
        ${pointsBar(m)}
        ${todayClaims.length ? `<div class="text-xs text-muted mt-1">Claimed today: ${todayClaims.map(c => `${escapeHtml(c.name)} <a class="link undo-claim" data-id="${c.id}">undo</a>`).join(' · ')}</div>` : ''}
      </div>

      <h3 class="section-title">🎁 Your rewards</h3>
      <div class="grid grid-2 gap-2 mb-2" id="reward-cards">
        ${m.rewards.length ? m.rewards.map(r => this.rewardCard(r)).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🎁</div>
            <h3>No rewards on the list</h3>
            <p>Rewards are yours to choose — small and frequent works best. Start with the suggested four and rename them.</p>
            <button class="btn btn-primary btn-sm mt-1" id="add-default-rewards">Add the suggested four</button>
          </div>`}
      </div>

      ${m.claims.length ? `
      <div class="card mb-2" id="enjoyed-list">
        <div class="card-header"><span class="card-title">🎁 Enjoyed so far</span><span class="text-sm text-muted">${formatPoints(m.points.spent)} points · ${m.claims.length} reward${m.claims.length === 1 ? '' : 's'}</span></div>
        ${m.claims.map(c => `
          <div class="flex items-center justify-between text-sm" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <span><span class="text-muted" style="display:inline-block;width:96px">${formatDate(c.date)}</span> ${escapeHtml(c.name)}${c.note ? ` <span class="text-muted">· ${escapeHtml(c.note)}</span>` : ''}</span>
            <span class="pts minus">−${formatPoints(c.cost)}</span>
          </div>`).join('')}
      </div>` : ''}

      <h3 class="section-title">🔁 Your habits</h3>
      <div class="grid grid-2 gap-2" id="habit-cards">
        ${m.habits.length ? m.habits.map(h => this.habitCard(h, m.today)).join('') : `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🔁</div>
            <h3>No habits yet</h3>
            <p>Pick one to start: save a set amount each week, invest every month, or keep a spending category under a cap.</p>
            <button class="btn btn-primary btn-sm mt-1" id="add-habit-btn-empty">+ New habit</button>
          </div>`}
      </div>

      <h3 class="section-title mt-2">🏅 Badges</h3>
      <div class="card mb-2">
        <div class="text-sm text-muted mb-1">${m.badges.filter(b => b.unlockedOn).length} of ${m.badges.length} unlocked. No points — just proof you did it.${m.fi ? ` You are ${Math.round(m.fi.progress * 1000) / 10}% of the way to your FI number${m.fi.fiDate ? `, FI in ${formatPeriod(m.fi.fiDate)} on current habits` : ''}.` : ''}</div>
        <div class="badge-grid" id="badge-grid">${m.badges.map(b => badgeTile(b)).join('')}</div>
      </div>

      <div class="card mt-2">
        <div class="card-header">
          <span class="card-title">🧭 Trail</span>
          <select id="trail-filter" class="text-sm" style="width:auto">
            <option value="all">Everything</option>
            <option value="miss">Misses only</option>
            <option value="reward">Rewards claimed</option>
            <option value="milestone">Badges</option>
            ${m.habits.map(h => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('')}
          </select>
        </div>
        <div class="trail" id="trail-list"></div>
        <div class="text-center mt-2"><button class="btn btn-secondary btn-sm" id="trail-more" style="display:none">Show more</button></div>
      </div>

      <details class="card mt-2 rewards-rules">
        <summary>How points work (the whole rule set)</summary>
        <ul class="text-sm mt-1">
          <li><b>Save</b> or <b>invest</b> your target: <b>${rules.points.weekly.save}</b> points per week, <b>${rules.points.monthly.save}</b> per month. Scores the moment the target is reached.</li>
          <li><b>Spending swap</b> (keep a category under a cap): <b>${rules.points.weekly.swap}</b> per week, <b>${rules.points.monthly.swap}</b> per month. Scores when the period ends under the cap.</li>
          <li><b>Streak</b>: ${rules.streakBonusAt} in a row and the points <b>double</b> for as long as it lasts. A miss resets it.</li>
          <li><b>Rewards</b> are your own list, priced in points (${rules.rewardStep} ≈ a month of good habits). Claim one when you can afford it, or keep banking for a bigger one — points never expire.</li>
          <li><b>Badges</b> mark the big moments — first points, streaks, your first reward, and every rung towards financial independence (5 → 100% of your FI number, FI date moving earlier). No points, just recognition.</li>
          <li>Points are recomputed from your transactions — edits, imports and back-dated entries update the trail automatically.</li>
        </ul>
      </details>
    `;
    document.getElementById('trail-filter').value = this.rewardsPage.filter;
    this.renderTrail();

    const addHabit = () => this.showHabitModal(null, m);
    document.getElementById('add-habit-btn').addEventListener('click', addHabit);
    const emptyHabit = document.getElementById('add-habit-btn-empty');
    if (emptyHabit) emptyHabit.addEventListener('click', addHabit);
    document.getElementById('add-reward-btn').addEventListener('click', () => this.showRewardModal(null));
    const addDefaults = document.getElementById('add-default-rewards');
    if (addDefaults) addDefaults.addEventListener('click', async () => {
      try { await API.addDefaultRewards(); showToast('Four rewards added — rename them to your taste'); this.renderRewards(container); }
      catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('trail-filter').addEventListener('change', e => { this.rewardsPage.filter = e.target.value; this.rewardsPage.shown = 30; this.renderTrail(); });
    $$('.enjoyed-link').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const sel = document.getElementById('trail-filter');
      sel.value = 'reward';
      this.rewardsPage.filter = 'reward';
      this.renderTrail();
      const list = document.getElementById('enjoyed-list') || document.getElementById('trail-list');
      if (list && list.scrollIntoView) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    document.getElementById('trail-more').addEventListener('click', () => { this.rewardsPage.shown += 50; this.renderTrail(); });

    $$('.claim-reward-btn').forEach(btn => btn.addEventListener('click', async () => {
      const r = m.rewards.find(x => x.id === btn.dataset.id);
      if (!r) return;
      const ok = await App.confirmDialog(`Use ${formatPoints(r.cost)} of your ${formatPoints(m.points.balance)} points for ${r.name}${r.note ? ` (${r.note})` : ''}? The habits are what got you here — enjoy it guilt-free.`, { title: '🎉 Claim your reward?', confirmText: 'Claim it', danger: false });
      if (!ok) return;
      try {
        const res = await API.claimReward(r.id);
        showToast(`🎉 Enjoy ${r.name}! ${formatPoints(res.balance)} points left`);
        this.renderRewards(container);
      } catch (err) { showToast(err.message, 'error'); }
    }));
    $$('.undo-claim').forEach(a => a.addEventListener('click', async () => {
      try { await API.undoRewardClaim(a.dataset.id); showToast('Claim undone', 'info'); this.renderRewards(container); }
      catch (err) { showToast(err.message, 'error'); }
    }));
    $$('.edit-reward-btn').forEach(btn => btn.addEventListener('click', () => {
      const r = m.rewards.find(x => x.id === btn.dataset.id);
      if (r) this.showRewardModal(r);
    }));
    $$('.delete-reward-btn').forEach(btn => btn.addEventListener('click', async () => {
      if (!(await App.confirmDialog('Past claims stay in the trail.', { title: 'Remove this reward from the list?' }))) return;
      try { await API.deleteReward(btn.dataset.id); showToast('Reward removed'); this.renderRewards(container); }
      catch (err) { showToast(err.message, 'error'); }
    }));
    $$('.edit-habit-btn').forEach(btn => btn.addEventListener('click', () => {
      const h = m.habits.find(x => x.id === btn.dataset.id);
      if (h) this.showHabitModal(h, m);
    }));
    $$('.delete-habit-btn').forEach(btn => btn.addEventListener('click', async () => {
      if (!(await App.confirmDialog('Its points leave the trail too. Transactions are untouched.', { title: 'Delete this habit?' }))) return;
      try { await API.deleteHabit(btn.dataset.id); showToast('Habit deleted'); this.renderRewards(container); }
      catch (err) { showToast(err.message, 'error'); }
    }));
  } catch (err) {
    container.innerHTML = `<div class="text-center text-muted mt-2">Error: ${escapeHtml(err.message)}</div>`;
  }
};

App.rewardCard = function(r) {
  return `
    <div class="card reward-card ${r.ready ? 'ready' : ''}" data-id="${r.id}">
      <div class="flex items-center justify-between mb-1">
        <span class="card-title">🎁 ${escapeHtml(r.name)}</span>
        <div class="flex gap-1">
          <button class="btn btn-sm btn-secondary edit-reward-btn" data-id="${r.id}">✏️</button>
          <button class="btn btn-sm btn-danger delete-reward-btn" data-id="${r.id}">🗑️</button>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-sm text-muted">${formatPoints(r.cost)} points${r.note ? ` · ${escapeHtml(r.note)}` : ''}${r.timesClaimed ? ` · enjoyed ×${r.timesClaimed}` : ''}</span>
        ${r.ready
          ? `<button class="btn btn-sm btn-primary claim-reward-btn" data-id="${r.id}">Claim</button>`
          : `<span class="text-sm" style="color:var(--text-secondary)">${formatPoints(r.shortBy)} more</span>`}
      </div>
    </div>`;
};

App.habitCard = function(h, today) {
  const state = habitState(h);
  const p = h.current;
  const pct = Math.min(100, Math.round((p.progress / p.target) * 100));
  const barClass = h.kind === 'swap' ? (p.progress > p.target ? 'danger' : pct > 80 ? 'warning' : '') : '';
  const unit = h.cadence === 'weekly' ? 'week' : 'month';
  const label = state === 'met' ? `<span style="color:var(--green)">✔ Done for this ${unit}</span>`
    : state === 'over' ? `<span style="color:var(--red)">✘ Over the cap this ${unit}</span>`
    : `<span class="text-muted">${h.kind === 'swap' ? 'On track — the bar is what you have spent' : 'In progress'}</span>`;
  return `
    <div class="card habit-card ${state}">
      <div class="flex items-center justify-between mb-1">
        <span class="card-title">${HABIT_ICON[h.kind]} ${escapeHtml(h.name)} ${streakChip(h)}</span>
        <div class="flex gap-1">
          <button class="btn btn-sm btn-secondary edit-habit-btn" data-id="${h.id}">✏️</button>
          <button class="btn btn-sm btn-danger delete-habit-btn" data-id="${h.id}">🗑️</button>
        </div>
      </div>
      <div class="text-sm text-muted mb-1">${escapeHtml(describeHabit(h))} · ${h.pointsPerPeriod} pts${h.streak >= 4 ? ' ×2' : ''}</div>
      <div class="flex justify-between text-sm mb-1">${label}<span>${escapeHtml(describeCurrent(h, today))}</span></div>
      <div class="progress-bar mb-1"><div class="progress-fill ${barClass}" style="width:${pct}%"></div></div>
      <div class="flex items-center justify-between text-xs text-muted">
        <span>Met ${h.periodsMet} of ${h.periodsScored} ${unit}${h.periodsScored === 1 ? '' : 's'} · ${h.pointsEarned} pts · best streak ${h.bestStreak}</span>
        ${periodDots(h)}
      </div>
      ${h.bonusNext ? `<div class="text-xs mt-1" style="color:var(--orange)">One more ${unit} and your points double 🔥</div>` : ''}
    </div>`;
};

App.renderTrail = function() {
  const { data, filter, shown } = this.rewardsPage;
  const list = document.getElementById('trail-list');
  const more = document.getElementById('trail-more');
  if (!list) return;
  let entries = data.ledger;
  if (filter === 'miss' || filter === 'reward' || filter === 'milestone') entries = entries.filter(e => e.kind === filter);
  else if (filter !== 'all') entries = entries.filter(e => e.habitId === filter);
  if (!entries.length) {
    list.innerHTML = `<div class="text-sm text-muted">${data.habits.length ? 'Nothing here yet.' : 'Add a habit and the trail fills in from your transactions.'}</div>`;
    more.style.display = 'none';
    return;
  }
  const groups = [];
  for (const e of entries.slice(0, shown)) {
    const key = e.date.slice(0, 7);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  list.innerHTML = groups.map(g => `
    <div class="trail-month">${formatPeriod(g.key)}</div>
    ${g.items.map(ledgerLine).join('')}
  `).join('');
  more.style.display = entries.length > shown ? '' : 'none';
};

// ── Reward form ──
App.showRewardModal = function(reward) {
  const isEdit = !!reward;
  const formHtml = `
    <div class="form-group">
      <label>Reward</label>
      <input type="text" id="reward-name" maxlength="60" value="${isEdit ? escapeHtml(reward.name) : ''}" placeholder="e.g. Dinner for two" required>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Points</label>
        <input type="number" step="1" min="1" id="reward-cost" value="${isEdit ? reward.cost : 100}" list="reward-cost-presets" required>
        <datalist id="reward-cost-presets"><option value="100"><option value="250"><option value="500"><option value="1000"></datalist>
        <div class="help">100 ≈ a month of good habits. Bigger number, bigger treat.</div>
      </div>
      <div class="form-group">
        <label>Roughly costs</label>
        <input type="text" id="reward-note" maxlength="80" value="${isEdit ? escapeHtml(reward.note) : ''}" placeholder="~$60">
        <div class="help">Shown next to what you saved, so the treat feels earned.</div>
      </div>
    </div>
  `;
  this.showModal(isEdit ? 'Edit reward' : 'New reward', formHtml, async () => {
    const data = {
      name: document.getElementById('reward-name').value.trim(),
      cost: parseInt(document.getElementById('reward-cost').value, 10),
      note: document.getElementById('reward-note').value.trim(),
    };
    if (isEdit) { await API.updateReward(reward.id, data); showToast('Reward updated'); }
    else { await API.createReward(data); showToast('Reward added'); }
    this.renderRewards(document.getElementById('page-content'));
  });
};

// ── Habit form ──
App.showHabitModal = async function(habit, motivation) {
  const isEdit = !!habit;
  const s = motivation ? motivation.suggestions : { monthlySaving: 0, monthlyInvesting: 0, spendingByCategory: {}, swapCandidates: [] };
  let accounts = [];
  try { accounts = await API.getAccounts(); } catch { /* account picker is optional */ }
  const savingsFirst = [...accounts].sort((a, b) => (b.type === 'savings') - (a.type === 'savings'));
  const swapCats = TRANSACTION_CATEGORIES.filter(c => ![TRANSFER_CATEGORY, INVESTMENT_CATEGORY, UNCATEGORIZED_CATEGORY, 'Salary', 'Freelance'].includes(c));
  const orderedCats = [...s.swapCandidates.filter(c => swapCats.includes(c)), ...swapCats.filter(c => !s.swapCandidates.includes(c))];
  const kind = isEdit ? habit.kind : 'save';
  const cadence = isEdit ? habit.cadence : 'weekly';

  const formHtml = `
    <div class="form-group">
      <label>What do you want to do?</label>
      <div class="toggle-group w-full" id="habit-kind">
        <button type="button" data-kind="save" class="${kind === 'save' ? 'active' : ''}">💰 Save</button>
        <button type="button" data-kind="invest" class="${kind === 'invest' ? 'active' : ''}">📈 Invest</button>
        <button type="button" data-kind="swap" class="${kind === 'swap' ? 'active' : ''}">☕ Spend less</button>
      </div>
      <div class="help" id="habit-kind-help"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>How often</label>
        <select id="habit-cadence">
          <option value="weekly" ${cadence === 'weekly' ? 'selected' : ''}>Every week</option>
          <option value="monthly" ${cadence === 'monthly' ? 'selected' : ''}>Every month</option>
        </select>
      </div>
      <div class="form-group">
        <label id="habit-amount-label">Target amount</label>
        <input type="number" step="0.01" min="0.01" id="habit-amount" value="${isEdit ? habit.amount : ''}" required>
        <div class="help" id="habit-amount-help"></div>
      </div>
    </div>
    <div class="form-group" id="habit-category-group">
      <label>Spending category</label>
      <select id="habit-category">${orderedCats.map(c => `<option value="${c}" ${isEdit && habit.category === c ? 'selected' : ''}>${c}${s.spendingByCategory[c] ? ` (≈${formatWhole(s.spendingByCategory[c])}/mo lately)` : ''}</option>`).join('')}</select>
    </div>
    <div class="form-group" id="habit-account-group">
      <label>Into which account</label>
      <select id="habit-account">
        <option value="">Any savings account</option>
        ${savingsFirst.map(a => `<option value="${a.id}" ${isEdit && habit.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}${a.type === 'savings' ? '' : ` (${a.type})`}</option>`).join('')}
      </select>
      <div class="help">Counts transfers arriving in the account. Card pay-offs never count.</div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="habit-name" maxlength="60" value="${isEdit ? escapeHtml(habit.name) : ''}" placeholder="Weekly saving">
      </div>
      <div class="form-group">
        <label>Start counting from</label>
        <input type="date" id="habit-start" value="${isEdit ? habit.startDate : App.today}" max="${App.today}" required>
        <div class="help">Pick an earlier date to score what you have already done.</div>
      </div>
    </div>
    <div class="help" id="habit-points-help"></div>
  `;

  const current = { kind };
  const overlay = this.showModal(isEdit ? 'Edit habit' : 'New habit', formHtml, async () => {
    const data = {
      kind: current.kind,
      cadence: document.getElementById('habit-cadence').value,
      amount: parseFloat(document.getElementById('habit-amount').value),
      name: document.getElementById('habit-name').value.trim(),
      startDate: document.getElementById('habit-start').value,
    };
    if (current.kind === 'swap') data.category = document.getElementById('habit-category').value;
    if (current.kind === 'save') data.accountId = document.getElementById('habit-account').value || null;
    if (isEdit) { await API.updateHabit(habit.id, data); showToast('Habit updated'); }
    else { await API.createHabit(data); showToast('Habit added — points are counted from your transactions'); }
    const content = document.getElementById('page-content');
    if (App.currentPage === 'rewards') App.renderRewards(content); else App.navigate('rewards');
  });

  const rules = motivation ? motivation.rules : { points: { weekly: { save: 10, invest: 10, swap: 5 }, monthly: { save: 25, invest: 25, swap: 15 } }, streakBonusAt: 4 };
  const perWeek = n => Math.round(n * 12 / 52);
  const refresh = () => {
    const cad = overlay.querySelector('#habit-cadence').value;
    const k = current.kind;
    overlay.querySelectorAll('#habit-kind button').forEach(b => b.classList.toggle('active', b.dataset.kind === k));
    overlay.querySelector('#habit-category-group').style.display = k === 'swap' ? '' : 'none';
    overlay.querySelector('#habit-account-group').style.display = k === 'save' ? '' : 'none';
    overlay.querySelector('#habit-amount-label').textContent = k === 'swap' ? 'Spending cap' : 'Target amount';
    overlay.querySelector('#habit-kind-help').textContent =
      k === 'save' ? 'Transfers into your savings account(s).' :
      k === 'invest' ? 'Money put into investments (transactions in the Investment category).' :
      'Keep one spending category under a cap — e.g. swap the morning barista coffee for a home brew.';
    let hint = '';
    if (k === 'save' && s.monthlySaving) hint = `Lately you have saved about ${formatWhole(s.monthlySaving)} a month (≈ ${formatWhole(perWeek(s.monthlySaving))} a week).`;
    if (k === 'invest' && s.monthlyInvesting) hint = `Lately you have invested about ${formatWhole(s.monthlyInvesting)} a month (≈ ${formatWhole(perWeek(s.monthlyInvesting))} a week).`;
    if (k === 'swap') {
      const cat = overlay.querySelector('#habit-category').value;
      const avg = s.spendingByCategory[cat];
      hint = avg ? `You spend about ${formatWhole(avg)} a month on ${cat} (≈ ${formatWhole(perWeek(avg))} a week). Set the cap a little below that.` : 'Set the cap a little below what you spend today.';
    }
    overlay.querySelector('#habit-amount-help').textContent = hint;
    const nameEl = overlay.querySelector('#habit-name');
    const per = cad === 'weekly' ? 'Weekly' : 'Monthly';
    const auto = k === 'save' ? `${per} saving` : k === 'invest' ? `${per} investing` : `${overlay.querySelector('#habit-category').value} swap`;
    nameEl.placeholder = auto;
    if (!isEdit && !nameEl.dataset.touched) nameEl.value = auto;
    const pts = rules.points[cad][k];
    overlay.querySelector('#habit-points-help').textContent = `Worth ${pts} points each ${cad === 'weekly' ? 'week' : 'month'} — ${pts * 2} once you are ${rules.streakBonusAt} in a row.`;
  };
  overlay.querySelectorAll('#habit-kind button').forEach(b => b.addEventListener('click', () => { current.kind = b.dataset.kind; refresh(); }));
  overlay.querySelector('#habit-cadence').addEventListener('change', refresh);
  overlay.querySelector('#habit-category').addEventListener('change', refresh);
  overlay.querySelector('#habit-name').addEventListener('input', e => { e.target.dataset.touched = '1'; });
  refresh();
};

// ── The nudge: a once-a-day pop-up when a reward has been affordable for a while ──
// Shown after sign-in / app start. "Later" silences it until tomorrow; claiming clears it server-side.
App.checkNudge = async function() {
  try {
    const m = await API.getMotivation();
    if (!m.nudge) return;
    const key = `finfolio-nudge-seen:${m.nudge.rewardId}`;
    if (localStorage.getItem(key) === m.today) return;
    localStorage.setItem(key, m.today);
    const dlg = this._openDialog(`
      <h2>🎉 You have earned a treat</h2>
      <p>${nudgeText(m)}</p>
      <p class="mt-1 text-sm">${m.claims.length ? `Last one enjoyed: ${escapeHtml(m.claims[0].name)} on ${formatDate(m.claims[0].date)}.` : 'You have not claimed anything yet.'} The habits are what matter, and they are on track.</p>
      <p class="text-xs text-muted mt-1">As of ${formatDate(m.today)}${App.clockFrozen ? ' — the server clock is frozen (--now / FINFOLIO_NOW)' : ''}.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="nudge-later">Later</button>
        <button type="button" class="btn btn-primary" id="nudge-go">See my rewards</button>
      </div>
    `);
    dlg.classList.add('nudge-dialog');
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('#nudge-later').addEventListener('click', () => dlg.close());
    dlg.querySelector('#nudge-go').addEventListener('click', () => { dlg.close(); this.navigate('rewards'); });
  } catch { /* never block the app on the nudge */ }
};
