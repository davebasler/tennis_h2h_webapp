// Admin dialogs: sign in, match editor, player editor, player manager.

import { api } from './api.js';
import { $, $$, avatar, el, esc, icon, scoreHtml } from './dom.js';
import {
  isTiebreakSet, MAX_SETS, normalizeMatch, normalizePlayer, OUTCOMES, ROUND_NAMES, ROUNDS, setsWinner, SURFACES,
} from './model.js';

let modalUid = 0;

/** Opens a modal <dialog>; it removes itself from the DOM when closed. */
function openModal({ title, body, foot = '', narrow = false, onClose }) {
  const titleId = `modal-title-${++modalUid}`;
  const dlg = el(`
    <dialog class="modal${narrow ? ' modal--narrow' : ''}" aria-labelledby="${titleId}">
      <header class="modal__head">
        <h2 class="modal__title" id="${titleId}">${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
      </header>
      <div class="modal__body">${body}</div>
      ${foot ? `<footer class="modal__foot">${foot}</footer>` : ''}
    </dialog>`);
  document.body.append(dlg);

  // Close on backdrop click (but not when a text selection drag ends outside).
  let downOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === dlg;
  });
  dlg.addEventListener('click', (e) => {
    if ((e.target === dlg && downOnBackdrop) || e.target.closest('[data-close]')) dlg.close();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  dlg.showModal();
  return dlg;
}

function showError(dlg, message) {
  const box = $('.form-error', dlg);
  box.textContent = message;
  box.hidden = !message;
  if (message) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function withBusy(dlg, fn) {
  const buttons = $$('.modal__foot button', dlg);
  buttons.forEach((b) => (b.disabled = true));
  try {
    showError(dlg, '');
    await fn();
  } catch (err) {
    showError(dlg, err.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/** A delete button that needs a second click within 4s (no blocking confirm()). */
function armDelete(button, onConfirm) {
  let timer = null;
  const label = button.innerHTML;
  button.addEventListener('click', () => {
    if (button.classList.contains('is-armed')) {
      clearTimeout(timer);
      onConfirm();
      return;
    }
    button.classList.add('is-armed');
    button.textContent = 'Click again to delete';
    timer = setTimeout(() => {
      button.classList.remove('is-armed');
      button.innerHTML = label;
    }, 4000);
  });
}

const segmented = (name, options, checked) =>
  `<div class="segmented">${options
    .map(([value, label]) => `<label><input type="radio" name="${name}" value="${esc(value)}"${String(value) === String(checked) ? ' checked' : ''}><span>${esc(label)}</span></label>`)
    .join('')}</div>`;

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------- login

export function openLogin({ editable, onSuccess }) {
  const dlg = openModal({
    title: 'Sign in',
    narrow: true,
    body: `
      ${editable ? '' : '<p class="note">Editing isn’t set up on this server yet: copy <code>config.sample.php</code> to <code>config.php</code> and set a password.</p>'}
      <form id="login-form" class="form" novalidate>
        <input type="text" name="username" autocomplete="username" value="h2h-admin" hidden>
        <label class="field">
          <span class="field__label">Admin password</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required>
        </label>
        <p class="form-error" role="alert" hidden></p>
      </form>`,
    foot: `<span class="spacer"></span>
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn btn--primary" form="login-form">Sign in</button>`,
  });
  const form = $('#login-form', dlg);
  form.password.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(dlg, async () => {
      await api.login(form.password.value);
      dlg.close();
      onSuccess();
    });
  });
}

// ------------------------------------------------------------- match editor

/**
 * @param {object} o
 * @param {object|null} o.match   existing match to edit, or null for a new one
 * @param {object[]} o.players
 * @param {object[]} o.matches    all matches (for event suggestions and defaults)
 * @param {{p1?: number, p2?: number}} o.defaults
 * @param {(match: object) => void} o.onSaved
 * @param {() => void} o.onDeleted
 */
export function openMatchEditor({ match = null, players, matches, defaults = {}, onSaved, onDeleted }) {
  const last = matches[0];
  const m = match ?? {
    date: todayIso(),
    event: '',
    surface: last?.surface ?? 'Clay',
    indoor: last?.indoor ?? false,
    round: 'F',
    p1: defaults.p1 ?? players[0]?.id,
    p2: defaults.p2 ?? players.find((p) => p.id !== (defaults.p1 ?? players[0]?.id))?.id,
    outcome: 'completed',
    winner: null,
    sets: [],
  };
  let setCount = Math.min(MAX_SETS, Math.max(3, m.sets.length));

  // Event suggestions, most used first.
  const eventCounts = new Map();
  for (const x of matches) eventCounts.set(x.event, (eventCounts.get(x.event) ?? 0) + 1);
  const events = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

  const dlg = openModal({
    title: match ? 'Edit match' : 'Add match',
    body: `
      <form id="match-form" novalidate>
        <div class="form-grid">
          <label class="field">
            <span class="field__label">Date</span>
            <input class="input" type="date" name="date" required value="${esc(m.date)}">
          </label>
          <label class="field">
            <span class="field__label">Round</span>
            <select class="input" name="round">
              ${ROUNDS.map((r) => `<option value="${r}"${r === m.round ? ' selected' : ''}>${ROUND_NAMES[r]}</option>`).join('')}
            </select>
          </label>
          <label class="field field--wide">
            <span class="field__label">Event</span>
            <input class="input" name="event" list="event-suggestions" maxlength="80" required
              placeholder="e.g. Northbrook ATP 500" value="${esc(m.event)}">
            <datalist id="event-suggestions">${events.map((e) => `<option value="${esc(e)}"></option>`).join('')}</datalist>
          </label>
          <div class="field field--wide" role="group" aria-label="Surface">
            <span class="field__label">Surface</span>
            <div class="field__row">
              ${segmented('surface', SURFACES.map((s) => [s, s]), m.surface)}
              <label class="check"><input type="checkbox" name="indoor"${m.indoor ? ' checked' : ''}> Indoor</label>
            </div>
          </div>
        </div>

        <div class="scorecard">
          <div class="scorecard__grid" data-grid></div>
          <div class="scorecard__sets">
            <button type="button" class="btn" data-add-set>${icon('plus')} Set</button>
            <button type="button" class="btn btn--ghost" data-remove-set>Remove set</button>
          </div>
          <div class="scorecard__options">
            <div class="field" role="group" aria-label="Result">
              <span class="field__label">Result</span>
              ${segmented('outcome', OUTCOMES.map((o) => [o, { completed: 'Completed', retired: 'Retired', walkover: 'Walkover' }[o]]), m.outcome)}
            </div>
            <div class="field" role="group" aria-label="Winner">
              <span class="field__label">Winner <span class="hint" data-winner-hint></span></span>
              <div data-winner></div>
            </div>
          </div>
          <p class="preview" aria-live="polite"></p>
        </div>
        <p class="form-error" role="alert" hidden></p>
      </form>`,
    foot: `
      ${match ? `<button type="button" class="btn btn--danger" data-delete>${icon('trash')} Delete</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn btn--primary" form="match-form">${match ? 'Save changes' : 'Add match'}</button>`,
  });

  const form = $('#match-form', dlg);
  const grid = $('[data-grid]', dlg);
  const card = $('.scorecard', dlg);
  const playerIds = new Set(players.map((p) => p.id));
  const nameOf = (id) => players.find((p) => p.id === id)?.name ?? '?';
  const playerOptions = (selected) =>
    players.map((p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

  // Grid flows column by column: tab order goes set by set (p1, p2, tie-break).
  function renderGrid(values) {
    const cells = [
      '<span class="scorecard__head">Player</span>',
      `<select class="input" name="p1" aria-label="Player 1">${playerOptions(values.p1)}</select>`,
      `<select class="input" name="p2" aria-label="Player 2">${playerOptions(values.p2)}</select>`,
      '<span class="scorecard__tb-label">Tie-break</span>',
    ];
    for (let i = 0; i < setCount; i++) {
      const [a = '', b = '', tb = ''] = values.sets[i] ?? [];
      const input = (name, value, label, extra = '') =>
        `<input class="score-input${extra}" name="${name}" value="${value ?? ''}" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="${label}">`;
      cells.push(
        `<span class="scorecard__head">Set ${i + 1}</span>`,
        input(`a${i}`, a, `Set ${i + 1}, player 1 games`),
        input(`b${i}`, b, `Set ${i + 1}, player 2 games`),
        input(`tb${i}`, tb, `Set ${i + 1}, tie-break points of the set loser`, ' score-input--tb'),
      );
    }
    grid.innerHTML = cells.join('');
    $$('.score-input--tb', grid).forEach((x) => (x.placeholder = '–'));
    $('[data-add-set]', dlg).disabled = setCount >= MAX_SETS;
    $('[data-remove-set]', dlg).disabled = setCount <= 1;
  }

  const num = (v) => (v === '' ? null : Number(v));

  /** Reads the score grid → { sets, error }. */
  function readSets() {
    const rows = [];
    for (let i = 0; i < setCount; i++) {
      rows.push([form[`a${i}`].value.trim(), form[`b${i}`].value.trim(), form[`tb${i}`].value.trim()]);
    }
    while (rows.length && rows[rows.length - 1][0] === '' && rows[rows.length - 1][1] === '') rows.pop();
    const sets = [];
    for (const [i, [a, b, tb]] of rows.entries()) {
      if (a === '' || b === '') return { sets, error: `Set ${i + 1} is incomplete.` };
      const set = [num(a), num(b)];
      if (tb !== '' && isTiebreakSet(set[0], set[1])) set.push(num(tb));
      sets.push(set);
    }
    return { sets, error: null };
  }

  function currentValues() {
    const { sets } = readSets();
    return {
      id: match?.id,
      date: form.date.value,
      event: form.event.value,
      surface: form.surface.value,
      indoor: form.indoor.checked,
      round: form.round.value,
      p1: Number(form.p1.value),
      p2: Number(form.p2.value),
      outcome: form.outcome.value,
      winner: form.winner ? Number(form.winner.value) || null : null,
      sets,
    };
  }

  let winnerKey = '';
  function renderWinner(v) {
    const derived = v.outcome === 'completed' ? setsWinner(v.sets) : 0;
    const winner = derived ? (derived === 1 ? v.p1 : v.p2) : v.winner;
    const key = `${v.p1}-${v.p2}`;
    if (key !== winnerKey) {
      // Rebuild only when the players change, so keyboard focus survives updates.
      winnerKey = key;
      $('[data-winner]', dlg).innerHTML = segmented('winner', [[v.p1, nameOf(v.p1)], [v.p2, nameOf(v.p2)]], winner);
    }
    $('[data-winner-hint]', dlg).textContent = {
      completed: '· worked out from the score',
      retired: '· the player who did not retire',
      walkover: '· who got the walkover',
    }[v.outcome];
    $('input[name=winner]', dlg).forEach((r) => {
      r.disabled = v.outcome === 'completed';
      if (derived) r.checked = Number(r.value) === winner;
    });
  }

  function update() {
    const v = currentValues();
    const walkover = v.outcome === 'walkover';
    card.classList.toggle('is-walkover', walkover);
    $$('.score-input', grid).forEach((x) => (x.disabled = walkover));
    $$('[data-add-set], [data-remove-set]', dlg).forEach((b) => (b.hidden = walkover));

    for (let i = 0; i < setCount; i++) {
      const a = num(form[`a${i}`].value.trim());
      const b = num(form[`b${i}`].value.trim());
      const tb = form[`tb${i}`];
      const allowTb = !walkover && isTiebreakSet(a, b);
      tb.disabled = !allowTb;
      if (!allowTb) tb.value = '';
      form[`a${i}`].classList.toggle('is-set-winner', a !== null && b !== null && a > b);
      form[`b${i}`].classList.toggle('is-set-winner', a !== null && b !== null && b > a);
    }

    renderWinner(v);
    const preview = $('.preview', dlg);
    const { error } = readSets();
    const finalV = currentValues();
    if (finalV.p1 === finalV.p2) {
      preview.textContent = 'Pick two different players.';
      return;
    }
    if (error) {
      preview.textContent = error;
      return;
    }
    try {
      const n = normalizeMatch({ ...finalV, event: finalV.event || '–' }, playerIds);
      const loser = n.winner === n.p1 ? n.p2 : n.p1;
      preview.innerHTML = `<strong>${esc(nameOf(n.winner))}</strong> d. ${esc(nameOf(loser))} ${scoreHtml(n)}`;
    } catch (err) {
      preview.textContent =
        !finalV.sets.length && finalV.outcome === 'completed'
          ? 'Enter the games of each set. The winner is worked out automatically.'
          : err.message;
    }
  }

  renderGrid(m);
  update();

  $('[data-add-set]', dlg).addEventListener('click', () => {
    const v = currentValues();
    const raw = [...Array(setCount)].map((_, i) => [form[`a${i}`].value, form[`b${i}`].value, form[`tb${i}`].value]);
    setCount = Math.min(MAX_SETS, setCount + 1);
    renderGrid({ ...v, sets: raw });
    update();
    form[`a${setCount - 1}`].focus();
  });
  $('[data-remove-set]', dlg).addEventListener('click', () => {
    const v = currentValues();
    const raw = [...Array(setCount)].map((_, i) => [form[`a${i}`].value, form[`b${i}`].value, form[`tb${i}`].value]);
    setCount = Math.max(1, setCount - 1);
    renderGrid({ ...v, sets: raw });
    update();
  });

  form.addEventListener('input', (e) => {
    if (e.target.classList.contains('score-input')) e.target.value = e.target.value.replace(/\D/g, '');
    update();
  });
  form.addEventListener('change', update);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(dlg, async () => {
      const { error } = readSets();
      if (error) throw new Error(error);
      const payload = { ...normalizeMatch(currentValues(), playerIds), id: match?.id };
      const res = await api.saveMatch(payload);
      dlg.close();
      onSaved(res.match);
    });
  });

  const del = $('[data-delete]', dlg);
  if (del) {
    armDelete(del, () =>
      withBusy(dlg, async () => {
        await api.deleteMatch(match.id);
        dlg.close();
        onDeleted?.();
      }),
    );
  }
  if (!match) form.event.focus();
}

// ------------------------------------------------------------ player editor

async function imageToAvatar(file) {
  if (!file?.type.startsWith('image/')) throw new Error('Please choose an image file.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image.'));
      i.src = url;
    });
    const size = 320;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) * 0.3; // portraits: keep the face, crop more from the bottom
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {object} o
 * @param {object|null} o.player
 * @param {string} o.prefillName
 * @param {(player: object) => void} o.onSaved
 * @param {() => void} o.onDeleted
 */
export function openPlayerEditor({ player = null, prefillName = '', onSaved, onDeleted }) {
  const p = player ?? { name: prefillName, country: '', birthplace: '', born: '', height_cm: '', weight_kg: '', plays: '', backhand: '', turned_pro: '', avatar: null };
  let photo = p.avatar;
  const val = (v) => esc(v ?? '');

  const dlg = openModal({
    title: player ? 'Edit player' : 'New player',
    body: `
      <form id="player-form" novalidate>
        <div class="avatar-edit">
          <button type="button" class="avatar-drop" data-photo aria-label="Upload photo"></button>
          <div class="avatar-edit__actions">
            <button type="button" class="btn" data-pick-photo>Upload photo</button>
            <button type="button" class="link-btn" data-remove-photo>Remove photo</button>
            <span class="hint">JPG or PNG. It’s cropped to a square.</span>
          </div>
          <input type="file" accept="image/*" hidden data-file>
        </div>
        <div class="form-grid">
          <label class="field field--wide">
            <span class="field__label">Name</span>
            <input class="input" name="name" maxlength="40" required autocomplete="off" value="${val(p.name)}">
          </label>
          <label class="field">
            <span class="field__label">Country code</span>
            <input class="input" name="country" maxlength="3" placeholder="SUI" autocomplete="off" value="${val(p.country)}" style="text-transform:uppercase">
          </label>
          <label class="field">
            <span class="field__label">Birthplace</span>
            <input class="input" name="birthplace" maxlength="60" placeholder="City, Country" value="${val(p.birthplace)}">
          </label>
          <label class="field">
            <span class="field__label">Born</span>
            <input class="input" name="born" maxlength="10" placeholder="1997 or 1997-03-14" value="${val(p.born)}">
          </label>
          <label class="field">
            <span class="field__label">Turned pro</span>
            <input class="input" name="turned_pro" inputmode="numeric" maxlength="4" placeholder="2018" value="${val(p.turned_pro)}">
          </label>
          <label class="field">
            <span class="field__label">Height (cm)</span>
            <input class="input" name="height_cm" inputmode="numeric" maxlength="3" placeholder="180" value="${val(p.height_cm)}">
          </label>
          <label class="field">
            <span class="field__label">Weight (kg)</span>
            <input class="input" name="weight_kg" inputmode="numeric" maxlength="3" placeholder="75" value="${val(p.weight_kg)}">
          </label>
          <div class="field" role="group" aria-label="Plays">
            <span class="field__label">Plays</span>
            ${segmented('plays', [['R', 'Right'], ['L', 'Left'], ['', '–']], p.plays ?? '')}
          </div>
          <div class="field" role="group" aria-label="Backhand">
            <span class="field__label">Backhand</span>
            ${segmented('backhand', [['1', 'One-handed'], ['2', 'Two-handed'], ['', '–']], p.backhand ?? '')}
          </div>
        </div>
        <p class="form-error" role="alert" hidden></p>
      </form>`,
    foot: `
      ${player ? `<button type="button" class="btn btn--danger" data-delete>${icon('trash')} Delete</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn btn--primary" form="player-form">${player ? 'Save changes' : 'Add player'}</button>`,
  });

  const form = $('#player-form', dlg);
  const field = (name) => form.elements.namedItem(name);
  const drop = $('[data-photo]', dlg);
  const fileInput = $('[data-file]', dlg);

  const renderPhoto = () => {
    drop.innerHTML = avatar({ name: field('name').value || '?', avatar: photo });
    $('[data-remove-photo]', dlg).hidden = !photo;
  };
  renderPhoto();
  field('name').addEventListener('input', () => !photo && renderPhoto());

  const takeFile = async (file) => {
    try {
      showError(dlg, '');
      photo = await imageToAvatar(file);
      renderPhoto();
    } catch (err) {
      showError(dlg, err.message);
    }
  };
  drop.addEventListener('click', () => fileInput.click());
  $('[data-pick-photo]', dlg).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => fileInput.files[0] && takeFile(fileInput.files[0]));
  $('[data-remove-photo]', dlg).addEventListener('click', () => {
    photo = null;
    renderPhoto();
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-dragover');
    if (e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(dlg, async () => {
      const values = {
        name: field('name').value,
        country: field('country').value,
        birthplace: field('birthplace').value,
        born: field('born').value,
        turned_pro: field('turned_pro').value,
        height_cm: field('height_cm').value,
        weight_kg: field('weight_kg').value,
        plays: field('plays').value,
        backhand: field('backhand').value,
        avatar: photo,
      };
      const payload = { ...normalizePlayer(values), id: player?.id };
      const res = await api.savePlayer(payload);
      dlg.close();
      onSaved(res.player);
    });
  });

  const del = $('[data-delete]', dlg);
  if (del) {
    armDelete(del, () =>
      withBusy(dlg, async () => {
        await api.deletePlayer(player.id);
        dlg.close();
        onDeleted?.();
      }),
    );
  }
  if (!player) field('name').focus();
}

// ----------------------------------------------------------- player manager

/**
 * @param {object} o
 * @param {() => Array<{player: object, meta: string}>} o.rows
 * @param {(player: object) => void} o.onEdit
 * @param {() => void} o.onAdd
 * @returns {{ refresh: () => void, dialog: HTMLDialogElement }}
 */
export function openPlayersManager({ rows, onEdit, onAdd, onClose }) {
  const dlg = openModal({
    title: 'Players',
    body: '<ul class="plist" data-list></ul>',
    foot: `<span class="spacer"></span>
      <button type="button" class="btn" data-close>Done</button>
      <button type="button" class="btn btn--primary" data-add>${icon('plus')} New player</button>`,
    onClose,
  });
  const list = $('[data-list]', dlg);
  const refresh = () => {
    const items = rows();
    list.innerHTML = items.length
      ? items
          .map(
            ({ player, meta }) => `
        <li>
          ${avatar(player, 40)}
          <div class="plist__info"><div class="plist__name">${esc(player.name)}</div><div class="plist__meta">${esc(meta)}</div></div>
          <button type="button" class="icon-btn" data-edit="${player.id}" aria-label="Edit ${esc(player.name)}">${icon('edit')}</button>
        </li>`,
          )
          .join('')
      : '<li class="muted">No players yet.</li>';
  };
  refresh();
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;
    const entry = rows().find((r) => r.player.id === Number(btn.dataset.edit));
    if (entry) onEdit(entry.player);
  });
  $('[data-add]', dlg).addEventListener('click', onAdd);
  return { refresh, dialog: dlg };
}
