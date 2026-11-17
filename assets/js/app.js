// Head 2 Head - single-page app.
//
// One page for every pair of players: the selection lives in the URL
// (?p1=alex&p2=robin), so any matchup can be bookmarked or shared.

import { api } from './api.js';
import {
  $, avatar, backhandText, esc, eventBadge, formatDate, formatDayMonth, heightText, icon, initTooltips,
  playsText, scoreHtml, scoreText, toast, weightText,
} from './dom.js';
import { openLogin, openMatchEditor, openPlayerEditor, openPlayersManager } from './editors.js';
import { ROUND_NAMES, slugify, SURFACES } from './model.js';
import { PlayerPicker } from './picker.js';
import { age, headToHead, pairCounts, pairKey, record, yearOf } from './stats.js';

const state = {
  players: [],
  matches: [],
  admin: false,
  editable: false,
  p1: null,
  p2: null,
  filter: { surface: 'all', year: 'all' },
  error: null,
};

const byId = new Map();
const slugs = new Map(); // player id -> url slug
let manager = null; // open players manager, if any

const player = (id) => byId.get(id) ?? null;
const slotColor = (slot) => `var(--${slot})`;

// ------------------------------------------------------------------- data

function index() {
  byId.clear();
  slugs.clear();
  const taken = new Set();
  for (const p of state.players) {
    let slug = slugify(p.name) || `player-${p.id}`;
    if (taken.has(slug)) slug = `${slug}-${p.id}`;
    taken.add(slug);
    slugs.set(p.id, slug);
    byId.set(p.id, p);
  }
}

async function load() {
  try {
    const data = await api.load();
    state.players = data.players;
    state.matches = data.matches;
    state.admin = data.admin;
    state.editable = data.editable;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  index();
}

/** The pair that met most often (most recent first on ties). */
function defaultPair() {
  const counts = pairCounts(state.matches);
  let best = null;
  for (const m of state.matches) {
    const n = counts.get(pairKey(m.p1, m.p2));
    if (!best || n > best.n) best = { n, pair: [m.p1, m.p2] };
  }
  if (best) return best.pair;
  return [state.players[0]?.id ?? null, state.players[1]?.id ?? null];
}

function fromParam(value) {
  if (!value) return null;
  for (const [id, slug] of slugs) if (slug === value) return id;
  const n = Number(value);
  return byId.has(n) ? n : null;
}

function selectFromUrl() {
  const q = new URLSearchParams(location.search);
  let a = fromParam(q.get('p1'));
  let b = fromParam(q.get('p2'));
  if (a === b) b = null;
  if (a === null || b === null) {
    const [da, db] = defaultPair();
    if (a === null) a = da !== b ? da : db;
    if (b === null) b = [db, da, ...state.players.map((p) => p.id)].find((id) => id !== null && id !== a) ?? null;
  }
  state.p1 = a;
  state.p2 = b;
  writeUrl(false);
}

function writeUrl(push) {
  const q = new URLSearchParams();
  if (state.p1) q.set('p1', slugs.get(state.p1));
  if (state.p2) q.set('p2', slugs.get(state.p2));
  const query = q.toString();
  const url = `${location.pathname}${query ? `?${query}` : ''}`;
  if (url !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function select(slot, id) {
  const other = slot === 'p1' ? 'p2' : 'p1';
  if (state[other] === id) state[other] = state[slot]; // picking the opponent swaps sides
  state[slot] = id;
  state.filter = { surface: 'all', year: 'all' };
  writeUrl(true);
  render();
}

async function reload() {
  await load();
  if (!byId.has(state.p1) || !byId.has(state.p2) || state.p1 === state.p2) {
    state.p1 = byId.has(state.p1) ? state.p1 : null;
    state.p2 = byId.has(state.p2) && state.p2 !== state.p1 ? state.p2 : null;
    const fallback = defaultPair();
    state.p1 ??= fallback.find((id) => id !== state.p2) ?? null;
    state.p2 ??= [...fallback, ...state.players.map((p) => p.id)].find((id) => id !== null && id !== state.p1) ?? null;
    writeUrl(false);
  }
  render();
  manager?.refresh();
}

// ---------------------------------------------------------------- pickers

const pickers = {};

function pickerOptions(slot) {
  const other = state[slot === 'p1' ? 'p2' : 'p1'];
  const counts = pairCounts(state.matches);
  return () =>
    state.players
      .map((p) => {
        const n = p.id === other ? -1 : counts.get(pairKey(p.id, other)) ?? 0;
        const meta = p.id === other ? 'swap sides' : n ? `${n} meeting${n === 1 ? '' : 's'}` : 'no meetings';
        return { player: p, meta, n, current: p.id === state[slot] };
      })
      .sort((x, y) => y.n - x.n || x.player.name.localeCompare(y.player.name));
}

function initPickers() {
  for (const slot of ['p1', 'p2']) {
    pickers[slot] = new PlayerPicker($(`#picker-${slot}`), {
      label: slot === 'p1' ? 'Player 1' : 'Player 2',
      color: slotColor(slot),
      options: (q) => pickerOptions(slot)(q),
      onSelect: (p) => select(slot, p.id),
      canAdd: () => state.admin,
      onAdd: (name) =>
        openPlayerEditor({
          prefillName: name,
          onSaved: async (p) => {
            toast(`${p.name} added`);
            await reload();
            select(slot, p.id);
          },
        }),
    });
  }
  $('#swap').addEventListener('click', () => {
    [state.p1, state.p2] = [state.p2, state.p1];
    writeUrl(true);
    render();
  });
}

// ----------------------------------------------------------------- render

function render() {
  const A = player(state.p1);
  const B = player(state.p2);
  document.title = A && B ? `${A.name} vs ${B.name} · Head 2 Head` : 'Head 2 Head';
  pickers.p1.setValue(A);
  pickers.p2.setValue(B);
  renderNav();
  renderHero(A, B);
  renderContent(A, B);
}

function renderNav() {
  $('#nav').innerHTML = state.admin
    ? `<button type="button" class="btn btn--accent" data-action="add-match">${icon('plus')}<span class="btn__label">Add match</span></button>
       <button type="button" class="btn btn--on-dark" data-action="players">${icon('users')}<span class="btn__label">Players</span></button>
       <a class="btn btn--on-dark" href="${api.exportUrl}" download title="Download a JSON backup of all data">${icon('download')}<span class="btn__label">Backup</span></a>
       <button type="button" class="btn btn--on-dark" data-action="logout" title="Sign out">${icon('logout')}<span class="visually-hidden">Sign out</span></button>`
    : `<button type="button" class="btn btn--on-dark" data-action="login">${icon('lock')}<span class="btn__label">Sign in</span></button>`;
}

function splitbar([a, b], label = '') {
  const segs = [
    a ? `<span class="splitbar__seg" style="--c:${slotColor('p1')};flex:${a}"></span>` : '',
    b ? `<span class="splitbar__seg" style="--c:${slotColor('p2')};flex:${b}"></span>` : '',
  ].join('');
  return `<div class="splitbar"${label ? ` role="img" aria-label="${esc(label)}"` : ''}>${segs}</div>`;
}

const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

function heroMessage(title, text, action = '') {
  return `<div class="hero-empty"><h2>${esc(title)}</h2><p>${text}</p>${action}</div>`;
}

function renderHero(A, B) {
  const faceoff = $('#faceoff');
  if (state.error) {
    faceoff.innerHTML = heroMessage('Couldn’t load the results', esc(state.error), '<button type="button" class="btn btn--accent" data-action="retry">Try again</button>');
    return;
  }
  if (!A || !B) {
    faceoff.innerHTML = state.players.length < 2
      ? heroMessage(
          'Welcome!',
          'Add at least two players to start tracking head-to-heads.',
          state.admin
            ? `<button type="button" class="btn btn--accent" data-action="add-player">${icon('plus')} Add player</button>`
            : '<button type="button" class="btn btn--on-dark" data-action="login">Sign in to add players</button>',
        )
      : heroMessage('Pick two players', 'Choose a player on each side to see their head-to-head.');
    return;
  }

  const h = headToHead(state.matches, A.id, B.id);
  const card = (p, slot) => {
    const years = age(p.born);
    const meta = [
      p.country ? `<span class="cc">${esc(p.country)}</span>` : '',
      years !== null ? `<span>Age ${years}</span>` : '',
      playsText(p.plays) ? `<span class="fo-extra">${playsText(p.plays)}</span>` : '',
    ].join('');
    return `<div class="fo-player fo-player--${slot}" style="--c:${slotColor(slot)}">${avatar(p)}<h2 class="fo-name">${esc(p.name)}</h2><div class="fo-meta">${meta}</div></div>`;
  };

  let caption = 'No meetings yet. Time to book a court!';
  if (h.total) {
    const [a, b] = h.wins;
    const lead = a === b ? `Level at <strong>${a}–${b}</strong>` : `<strong>${esc(a > b ? A.name : B.name)}</strong> leads ${Math.max(a, b)}–${Math.min(a, b)}`;
    const streak = h.current && h.current.length >= 2 ? ` · ${esc(h.current.who === 0 ? A.name : B.name)} won the last ${h.current.length}` : '';
    const last = h.list[0];
    const wo = h.walkovers ? ` (incl. ${h.walkovers} walkover${h.walkovers > 1 ? 's' : ''})` : '';
    caption = `${lead}${wo}${streak}<br>Last met ${formatDate(last.date)} · ${esc(last.event)}`;
  }

  faceoff.innerHTML = `
    ${card(A, 'p1')}
    <div class="scoreboard">
      <div class="scoreboard__kicker">Head to head</div>
      <div class="scoreboard__nums" role="img" aria-label="${esc(A.name)} ${h.wins[0]}, ${esc(B.name)} ${h.wins[1]}">
        <span>${h.wins[0]}</span><span class="scoreboard__sep" aria-hidden="true">–</span><span>${h.wins[1]}</span>
      </div>
      <div class="scoreboard__wins" aria-hidden="true"><span>Wins</span><span>Wins</span></div>
      ${h.total ? `${splitbar(h.wins, `${A.name} won ${pct(h.wins[0], h.total)}% of meetings`)}
        <div class="scoreboard__pct"><span>${pct(h.wins[0], h.total)}%</span><span>${pct(h.wins[1], h.total)}%</span></div>` : ''}
    </div>
    <p class="faceoff__caption">${caption}</p>
    ${card(B, 'p2')}`;
}

function renderContent(A, B) {
  const content = $('#content');
  if (!A || !B) {
    content.innerHTML = '';
    return;
  }
  const h = headToHead(state.matches, A.id, B.id);
  content.innerHTML = `
    <div class="grid-2">
      ${comparisonCard(A, B)}
      ${statsCard(A, B, h)}
    </div>
    ${matchesCard(A, B, h)}`;
}

function legend(A, B) {
  return `<div class="legend" aria-hidden="true">
    <span><i class="dot" style="--c:${slotColor('p1')}"></i>${esc(A.name)}</span>
    <span><i class="dot" style="--c:${slotColor('p2')}"></i>${esc(B.name)}</span></div>`;
}

function comparisonCard(A, B) {
  const year = new Date().getFullYear();
  const [ca, cb] = [record(state.matches, A.id), record(state.matches, B.id)];
  const [ya, yb] = [record(state.matches, A.id, year), record(state.matches, B.id, year)];
  const dash = '<span class="muted">–</span>';
  const v = (x) => (x === null || x === undefined || x === '' ? dash : esc(x));

  const row = (label, a, b, lead = null, section = false) => {
    const cls = (side) => (lead === null || lead === 0 ? '' : (lead > 0) === (side === 0) ? 'is-lead' : 'is-trail');
    return `<div class="cmp__row${section ? ' cmp__row--section' : ''}">
      <span class="cmp__a ${cls(0)}">${a}</span><span class="cmp__label">${label}</span><span class="cmp__b ${cls(1)}">${b}</span></div>`;
  };
  const wl = (r) => `${r.wins}/${r.losses}`;

  return `
    <section class="card" aria-labelledby="cmp-title">
      <div class="card__head"><h2 class="card__title" id="cmp-title">Player comparison</h2></div>
      <div class="cmp">
        <div class="cmp__head">
          <div class="cmp__who" style="--c:${slotColor('p1')}">${avatar(A)}<span>${esc(A.name)}</span></div>
          <div class="cmp__who" style="--c:${slotColor('p2')}">${avatar(B)}<span>${esc(B.name)}</span></div>
        </div>
        ${row('Age', v(age(A.born)), v(age(B.born)))}
        ${row('Birthplace', v(A.birthplace), v(B.birthplace))}
        ${row('Height', v(heightText(A.height_cm)), v(heightText(B.height_cm)))}
        ${row('Weight', v(weightText(A.weight_kg)), v(weightText(B.weight_kg)))}
        ${row('Plays', v(playsText(A.plays)), v(playsText(B.plays)))}
        ${row('Backhand', v(backhandText(A.backhand)), v(backhandText(B.backhand)))}
        ${row('Turned pro', v(A.turned_pro), v(B.turned_pro))}
        ${row('YTD W/L', wl(ya), wl(yb), ya.wins - yb.wins, true)}
        ${row('YTD titles', ya.titles, yb.titles, ya.titles - yb.titles)}
        ${row('Career W/L', wl(ca), wl(cb), ca.wins - cb.wins)}
        ${row('Career titles', ca.titles, cb.titles, ca.titles - cb.titles)}
      </div>
    </section>`;
}

function statsCard(A, B, h) {
  const head = `<div class="card__head"><h2 class="card__title" id="h2h-title">Head-to-head stats</h2>${legend(A, B)}</div>`;
  if (!h.total) {
    return `<section class="card" aria-labelledby="h2h-title">${head}
      <div class="empty"><strong>No meetings yet</strong>Stats appear after their first match.</div></section>`;
  }

  const tip = (label, [a, b]) => {
    const t = a + b;
    return esc(`${esc(label)}<br><b>${esc(A.name)}</b> ${a}${t ? ` (${pct(a, t)}%)` : ''} · <b>${esc(B.name)}</b> ${b}${t ? ` (${pct(b, t)}%)` : ''}`);
  };

  const metrics = [
    ['Sets won', h.sets],
    ['Games won', h.games],
    ['Tie-breaks won', h.tiebreaks],
    ['Deciding sets won', h.deciders],
    ['Finals won', h.finals],
    ['Longest win streak', h.longestStreak],
  ].filter(([, [a, b]]) => a + b > 0);

  const bfly = metrics
    .map(([label, [a, b]]) => {
      const t = a + b;
      return `<div class="bfly__row" data-tip="${tip(label, [a, b])}">
        <div class="bfly__top"><span class="bfly__val">${a}</span><span class="bfly__label">${label}</span><span class="bfly__val">${b}</span></div>
        <div class="bfly__bars" aria-hidden="true">
          <div class="bfly__half"><span class="bfly__fill" style="--c:${slotColor('p1')};--w:${pct(a, t)}%"></span></div>
          <div class="bfly__half"><span class="bfly__fill" style="--c:${slotColor('p2')};--w:${pct(b, t)}%"></span></div>
        </div></div>`;
    })
    .join('');

  const splitRows = (entries) =>
    entries
      .map(([label, [a, b]]) => `<div class="split-row" data-tip="${tip(label, [a, b])}">
        <span class="split-row__label">${esc(label)}</span><span class="split-row__n">${a}</span>${splitbar([a, b])}<span class="split-row__n">${b}</span></div>`)
      .join('');

  const surfaces = SURFACES.filter((s) => h.bySurface.has(s)).map((s) => [s, h.bySurface.get(s)]);
  const seasons = [...h.byYear.entries()].sort((x, y) => y[0] - x[0]).map(([y, v]) => [String(y), v]);

  const form = h.list
    .slice(0, 10)
    .map((m) => {
      const slot = m.winner === A.id ? 'p1' : 'p2';
      const w = player(m.winner);
      const t = esc(`${formatDate(m.date)} · ${esc(m.event)}<br><b>${esc(w.name)}</b> won ${esc(scoreText(m))}`);
      return `<span class="form-guide__item" style="--c:${slotColor(slot)}" data-tip="${t}" tabindex="0" aria-label="${esc(`${formatDate(m.date)}: ${w.name} won`)}">${esc(w.name.slice(0, 1).toUpperCase())}</span>`;
    })
    .join('');

  return `<section class="card" aria-labelledby="h2h-title">${head}
    <div class="bfly">${bfly}</div>
    <h3 class="subhead">By surface</h3>${splitRows(surfaces)}
    ${seasons.length > 1 ? `<h3 class="subhead">By season</h3>${splitRows(seasons)}` : ''}
    <h3 class="subhead">Recent meetings · newest first</h3><div class="form-guide">${form}</div>
  </section>`;
}

function matchesCard(A, B, h) {
  const { surface, year } = state.filter;
  const list = h.list.filter((m) => (surface === 'all' || m.surface === surface) && (year === 'all' || yearOf(m) === Number(year)));
  const surfaces = SURFACES.filter((s) => h.list.some((m) => m.surface === s));
  const years = [...new Set(h.list.map(yearOf))].sort((a, b) => b - a);
  const cols = state.admin ? 7 : 6;

  const filters = `
    <div class="filters">
      ${surfaces.length > 1 ? `<div class="chips" role="group" aria-label="Filter by surface">
        ${['all', ...surfaces].map((s) => `<button type="button" class="chip" data-filter-surface="${s}" aria-pressed="${surface === s}">${s === 'all' ? 'All' : s}</button>`).join('')}
      </div>` : ''}
      ${years.length > 1 ? `<select class="select-sm" data-filter-year aria-label="Filter by season">
        <option value="all">All seasons</option>
        ${years.map((y) => `<option value="${y}"${String(y) === year ? ' selected' : ''}>${y}</option>`).join('')}
      </select>` : ''}
      ${state.admin ? `<button type="button" class="btn btn--primary" data-action="add-match">${icon('plus')} Add match</button>` : ''}
    </div>`;

  let body;
  if (!h.total) {
    body = `<div class="empty"><strong>No matches yet</strong>${esc(A.name)} and ${esc(B.name)} haven’t played each other.
      ${state.admin ? `<br><button type="button" class="btn btn--primary" data-action="add-match">${icon('plus')} Add their first match</button>` : ''}</div>`;
  } else if (!list.length) {
    body = '<div class="empty"><strong>Nothing here</strong>No matches for this filter.</div>';
  } else {
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(yearOf(m))) groups.set(yearOf(m), []);
      groups.get(yearOf(m)).push(m);
    }
    const rows = [...groups.entries()]
      .map(([y, ms]) => {
        const wa = ms.filter((m) => m.winner === A.id).length;
        const header = `<tr class="year-row"><th colspan="${cols}" scope="rowgroup">${y}
          <span class="year-record">${esc(A.name)} ${wa}–${ms.length - wa} ${esc(B.name)}</span></th></tr>`;
        return header + ms.map((m) => matchRow(m, A)).join('');
      })
      .join('');
    body = `<div class="table-wrap"><table class="matches">
      <thead><tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col">Surface</th><th scope="col">Rd</th>
        <th scope="col">Winner</th><th scope="col">Score</th>${state.admin ? '<th scope="col"><span class="visually-hidden">Edit</span></th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return `<section class="card" aria-labelledby="matches-title">
    <div class="card__head"><h2 class="card__title" id="matches-title">Matches <span class="count">${list.length}</span></h2>${h.total ? filters : ''}</div>
    ${body}
  </section>`;
}

function matchRow(m, A) {
  const w = player(m.winner);
  const slot = m.winner === A.id ? 'p1' : 'p2';
  const badge = eventBadge(m.event);
  const surface = `${m.indoor ? 'Indoor' : 'Outdoor'} ${m.surface}`;
  return `<tr class="match">
    <td class="c-date">${formatDayMonth(m.date)}</td>
    <td class="c-event"><span class="event">${esc(m.event)}</span>${badge ? `<span class="badge">${badge}</span>` : ''}
      <span class="m-meta">${formatDate(m.date)} · ${surface} · ${ROUND_NAMES[m.round]}</span></td>
    <td class="c-surface">${surface}</td>
    <td class="c-round" title="${ROUND_NAMES[m.round]}">${m.round}</td>
    <td class="c-winner"><span class="winner"><i class="dot" style="--c:${slotColor(slot)}"></i>${esc(w?.name ?? '?')}</span></td>
    <td class="c-score">${scoreHtml(m)}</td>
    ${state.admin ? `<td class="c-actions"><button type="button" class="icon-btn" data-edit-match="${m.id}" aria-label="Edit match of ${formatDate(m.date)}">${icon('edit')}</button></td>` : ''}
  </tr>`;
}

// ---------------------------------------------------------------- actions

function addMatch(match = null) {
  if (state.players.length < 2) {
    toast('Add at least two players first.', 'error');
    return;
  }
  openMatchEditor({
    match,
    players: state.players,
    matches: state.matches,
    defaults: { p1: state.p1, p2: state.p2 },
    onSaved: async (saved) => {
      toast(match ? 'Match updated' : 'Match added');
      const samePair = [saved.p1, saved.p2].includes(state.p1) && [saved.p1, saved.p2].includes(state.p2);
      if (!samePair) {
        state.p1 = saved.p1;
        state.p2 = saved.p2;
        state.filter = { surface: 'all', year: 'all' };
        writeUrl(true);
      }
      await reload();
    },
    onDeleted: async () => {
      toast('Match deleted');
      await reload();
    },
  });
}

function editPlayer(p = null) {
  openPlayerEditor({
    player: p,
    onSaved: async (saved) => {
      toast(p ? `${saved.name} updated` : `${saved.name} added`);
      await reload();
    },
    onDeleted: async () => {
      toast(`${p.name} deleted`);
      await reload();
    },
  });
}

function openManager() {
  manager = openPlayersManager({
    rows: () =>
      state.players.map((p) => {
        const r = record(state.matches, p.id);
        return { player: p, meta: [p.country, `${r.wins}/${r.losses} W/L`, `${r.titles} title${r.titles === 1 ? '' : 's'}`].filter(Boolean).join(' · ') };
      }),
    onEdit: (p) => editPlayer(p),
    onAdd: () => editPlayer(null),
    onClose: () => {
      manager = null;
    },
  });
}

const actions = {
  login: () =>
    openLogin({
      editable: state.editable,
      onSuccess: async () => {
        toast('Signed in. You can now add and edit results.');
        await reload();
      },
    }),
  logout: async () => {
    try {
      await api.logout();
      toast('Signed out');
    } catch (err) {
      toast(err.message, 'error');
    }
    state.admin = false;
    render();
  },
  'add-match': () => addMatch(),
  'add-player': () => editPlayer(null),
  players: () => openManager(),
  retry: () => reload(),
};

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], [data-filter-surface], [data-edit-match]');
  if (!target) return;
  if (target.dataset.action) {
    actions[target.dataset.action]?.();
  } else if (target.dataset.filterSurface) {
    state.filter.surface = target.dataset.filterSurface;
    renderContent(player(state.p1), player(state.p2));
  } else if (target.dataset.editMatch) {
    addMatch(state.matches.find((m) => m.id === Number(target.dataset.editMatch)) ?? null);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-filter-year]')) {
    state.filter.year = e.target.value;
    renderContent(player(state.p1), player(state.p2));
  }
});

window.addEventListener('popstate', () => {
  selectFromUrl();
  render();
});

// ------------------------------------------------------------------- boot

initPickers();
initTooltips();
await load();
selectFromUrl();
render();
