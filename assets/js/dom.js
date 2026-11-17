// Small DOM + formatting helpers shared by the UI modules.

import { isMatchTiebreak, setsFromWinner } from './model.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Parse an HTML string into a single element. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
};

export const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] : [...parts[0]][1] ?? '';
  return (first + last).toUpperCase();
}

/** Photo or monogram. Without `size`, the surrounding CSS decides (--size). */
export function avatar(player, size = null, attrs = '') {
  const style = size ? `style="--size:${size}px"` : '';
  if (player?.avatar) return `<img class="avatar" ${style} ${attrs} src="${esc(player.avatar)}" alt="">`;
  return `<span class="avatar" ${style} ${attrs} aria-hidden="true">${esc(initials(player?.name))}</span>`;
}

// --------------------------------------------------------------- formatting

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayMonthFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const asDate = (iso) => new Date(`${iso}T12:00:00`);

export const formatDate = (iso) => dateFmt.format(asDate(iso));
export const formatDayMonth = (iso) => dayMonthFmt.format(asDate(iso));

export function heightText(cm) {
  if (!cm) return null;
  const inches = Math.round(cm / 2.54);
  return `${Math.floor(inches / 12)}'${inches % 12}" (${cm} cm)`;
}

export function weightText(kg) {
  if (!kg) return null;
  return `${Math.round(kg * 2.20462)} lbs (${kg} kg)`;
}

export const playsText = (v) => ({ R: 'Right-handed', L: 'Left-handed' })[v] ?? null;
export const backhandText = (v) => ({ 1: 'One-handed', 2: 'Two-handed' })[v] ?? null;

/** Tournament tier badge derived from the event name ("ATP 500" → "500"). */
export function eventBadge(name) {
  const n = String(name);
  if (/masters\s*1000|\b1000\b/i.test(n)) return '1000';
  if (/\b500\b/.test(n)) return '500';
  if (/\b250\b/.test(n)) return '250';
  return null;
}

/** Score as printed on a scoreboard, from the winner's point of view. */
export function scoreHtml(match) {
  if (match.outcome === 'walkover') return '<span class="score"><span class="tag">W/O</span></span>';
  const sets = setsFromWinner(match)
    .map(([w, l, tb]) => {
      if (isMatchTiebreak([w, l])) return `<span class="set">[${w}–${l}]</span>`;
      const sup = tb !== undefined ? `<sup>${tb}</sup>` : '';
      return `<span class="set">${w}–${l}${sup}</span>`;
    })
    .join('');
  const ret = match.outcome === 'retired' ? '<span class="tag" title="Retired">RET</span>' : '';
  return `<span class="score">${sets}${ret}</span>`;
}

/** Plain-text version of the score, e.g. for tooltips. */
export function scoreText(match) {
  if (match.outcome === 'walkover') return 'W/O';
  const sets = setsFromWinner(match)
    .map(([w, l, tb]) => (isMatchTiebreak([w, l]) ? `[${w}–${l}]` : `${w}–${l}${tb !== undefined ? `(${tb})` : ''}`))
    .join(' ');
  return match.outcome === 'retired' ? `${sets} ret.` : sets;
}

// ------------------------------------------------------------------- toasts

export function toast(message, kind = 'info') {
  const host = $('#toasts');
  const node = el(`<div class="toast${kind === 'error' ? ' toast--error' : ''}">${esc(message)}</div>`);
  host.append(node);
  // As a popover the container lives in the top layer, so toasts stay visible above
  // open dialogs; re-showing moves it to the top. Older browsers ignore the attribute.
  if (host.showPopover) {
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }
  setTimeout(() => {
    node.remove();
    if (!host.children.length && host.hidePopover && host.matches(':popover-open')) host.hidePopover();
  }, kind === 'error' ? 6000 : 3200);
}

// ------------------------------------------------------------------ tooltip

/** One shared tooltip for every element with a data-tip attribute (HTML allowed, pre-escaped). */
export function initTooltips() {
  const tip = $('#tooltip');
  let current = null;
  const show = (target) => {
    current = target;
    tip.innerHTML = target.dataset.tip;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 140), window.innerWidth - 140);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(r.top, 48)}px`;
  };
  const hide = () => {
    current = null;
    tip.hidden = true;
  };
  document.addEventListener('pointerover', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target && target !== current) show(target);
    else if (!target && current) hide();
  });
  document.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target) show(target);
  });
  document.addEventListener('focusout', hide);
}
