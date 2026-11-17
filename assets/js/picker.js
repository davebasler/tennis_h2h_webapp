// Searchable player combobox (WAI-ARIA combobox + listbox pattern).

import { avatar, esc, icon } from './dom.js';

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let uid = 0;

export class PlayerPicker {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {string} opts.label        "Player 1"
   * @param {string} opts.color        CSS color of the slot (identity dot)
   * @param {(query: string) => Array<{player: object, meta: string, current: boolean}>} opts.options
   * @param {(player: object) => void} opts.onSelect
   * @param {() => boolean} opts.canAdd  whether to offer "Add new player"
   * @param {(name: string) => void} opts.onAdd
   */
  constructor(root, opts) {
    this.opts = opts;
    this.value = null;
    this.items = [];
    this.active = -1;
    this.query = '';
    const id = `picker-${++uid}`;
    this.listId = `${id}-list`;

    root.innerHTML = `
      <label class="picker__label" for="${id}"><i style="--c:${opts.color}"></i>${esc(opts.label)}</label>
      <div class="picker__field">
        <span class="picker__thumb"></span>
        <input class="picker__input" id="${id}" type="text" role="combobox" aria-autocomplete="list"
          aria-expanded="false" aria-controls="${this.listId}" autocomplete="off" spellcheck="false"
          placeholder="Search player…">
        ${icon('chevron', 'i picker__chev')}
      </div>
      <ul class="picker__list" id="${this.listId}" role="listbox" aria-label="${esc(opts.label)}" hidden></ul>`;

    this.input = root.querySelector('input');
    this.list = root.querySelector('ul');
    this.thumb = root.querySelector('.picker__thumb');
    this.setValue(null);

    this.input.addEventListener('focus', () => {
      this.input.select();
      this.open('');
    });
    this.input.addEventListener('click', () => {
      if (this.list.hidden) this.open('');
    });
    this.input.addEventListener('input', () => this.open(this.input.value));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => this.close());
    // Keep focus in the input while clicking an option.
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('[data-index]');
      if (li) this.choose(Number(li.dataset.index));
    });
  }

  setValue(player) {
    this.value = player;
    this.input.value = player?.name ?? '';
    this.thumb.innerHTML = player ? avatar(player) : `<span class="avatar">${icon('search')}</span>`;
  }

  open(query) {
    this.query = query.trim();
    const q = fold(this.query);
    const entries = this.opts.options(q).filter((e) => !q || fold(e.player.name).includes(q) || fold(e.player.country).includes(q));
    this.items = entries.map((e) => ({ type: 'player', ...e }));
    if (this.opts.canAdd()) this.items.push({ type: 'add' });

    this.list.innerHTML = this.items.length
      ? this.items.map((item, i) => this.optionHtml(item, i)).join('')
      : '<li class="picker__empty">No players found</li>';
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    const current = this.items.findIndex((it) => it.current);
    this.setActive(q ? 0 : Math.max(current, 0));
  }

  optionHtml(item, i) {
    const id = `${this.listId}-${i}`;
    if (item.type === 'add') {
      const label = this.query ? `Add “${esc(this.query)}” as new player` : 'Add new player';
      return `<li class="picker__option picker__option--add" id="${id}" role="option" aria-selected="false" data-index="${i}">
        <span class="avatar" style="--size:32px">${icon('plus')}</span><span class="picker__option-name">${label}</span></li>`;
    }
    const p = item.player;
    return `<li class="picker__option${item.current ? ' is-current' : ''}" id="${id}" role="option" aria-selected="false" data-index="${i}">
      ${avatar(p, 32)}
      <span class="picker__option-name">${esc(p.name)}</span>
      <span class="picker__option-meta">${esc(item.meta)}</span></li>`;
  }

  setActive(i) {
    const nodes = this.list.querySelectorAll('[data-index]');
    if (!nodes.length) {
      this.active = -1;
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.active = (i + nodes.length) % nodes.length;
    nodes.forEach((node, n) => {
      const on = n === this.active;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-selected', String(on));
      if (on) {
        this.input.setAttribute('aria-activedescendant', node.id);
        node.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  choose(i) {
    const item = this.items[i];
    if (!item) return;
    const query = this.query;
    this.close();
    this.input.blur();
    if (item.type === 'add') this.opts.onAdd(query);
    else this.opts.onSelect(item.player);
  }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.input.value = this.value?.name ?? '';
  }

  onKey(e) {
    const open = !this.list.hidden;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (!open) this.open('');
        else this.setActive(this.active + (e.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'Enter':
        if (open && this.active >= 0) {
          e.preventDefault();
          this.choose(this.active);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          this.close();
          this.input.select();
        }
        break;
      default:
    }
  }
}
