// Shared domain model: constants, validation and score helpers.
//
// Imported by the browser app *and* the Node dev server (dev-server.js).
// The production backend (api.php / lib/validate.php) mirrors these rules
// in PHP - keep both in sync when changing a rule.

export const SURFACES = ['Clay', 'Hard', 'Grass', 'Carpet'];

export const ROUNDS = ['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'RR', 'Q'];
export const ROUND_NAMES = {
  F: 'Final',
  SF: 'Semi-final',
  QF: 'Quarter-final',
  R16: 'Round of 16',
  R32: 'Round of 32',
  R64: 'Round of 64',
  RR: 'Round robin',
  Q: 'Qualifying',
};

export const OUTCOMES = ['completed', 'retired', 'walkover'];
export const MAX_SETS = 5;

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const fail = (message) => {
  throw new ValidationError(message);
};

// ---------------------------------------------------------------- helpers

export function slugify(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const charLength = (s) => [...s].length;

function text(value, max, label, required = false) {
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') {
    fail(`${label} is invalid.`);
  }
  // eslint-disable-next-line no-control-regex
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s === '') {
    if (required) fail(`${label} is required.`);
    return null;
  }
  if (charLength(s) > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
}

function int(value, min, max, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? (/^\s*-?\d+\s*$/.test(value) ? Number(value) : NaN) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) fail(`${label} must be a whole number.`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
  return n;
}

export function isValidDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ------------------------------------------------------------------ score

/** A "7–6" style set, where tie-break points of the set loser may be recorded. */
export const isTiebreakSet = (a, b) => (a === 7 && b === 6) || (a === 6 && b === 7);

/**
 * A deciding match tie-break entered as its own "set" (e.g. 10–8).
 * Heuristic: no regular set reaches 10 games in casual play.
 */
export const isMatchTiebreak = (set) => Math.max(set[0], set[1]) >= 10;

/** 1 if player 1 won more sets, 2 if player 2 did, 0 if level. */
export function setsWinner(sets) {
  let a = 0;
  let b = 0;
  for (const [x, y] of sets) {
    if (x > y) a++;
    else if (y > x) b++;
  }
  return a > b ? 1 : b > a ? 2 : 0;
}

/** Sets as [winnerGames, loserGames, tb?] - the way scores are printed. */
export function setsFromWinner(match) {
  const flip = match.winner === match.p2;
  return match.sets.map(([a, b, tb]) => {
    const set = flip ? [b, a] : [a, b];
    if (tb !== undefined && tb !== null) set.push(tb);
    return set;
  });
}

// ------------------------------------------------------------- validation

export function normalizePlayer(input) {
  const p = input && typeof input === 'object' ? input : {};
  const thisYear = new Date().getFullYear();

  const name = text(p.name, 40, 'Name', true);

  const country = text(p.country, 3, 'Country');
  if (country && !/^[A-Za-z]{2,3}$/.test(country)) fail('Country must be a 2–3 letter code, e.g. SUI.');

  const born = text(p.born, 10, 'Born');
  if (born) {
    const year = Number(born.slice(0, 4));
    const ok = /^\d{4}$/.test(born) || (/^\d{4}-\d{2}-\d{2}$/.test(born) && isValidDate(born));
    if (!ok || year < 1900 || year > thisYear) fail('Born must be a year (1997) or a date (1997-03-14).');
  }

  const plays = text(p.plays, 1, 'Plays');
  if (plays && !['R', 'L'].includes(plays)) fail('Plays must be R or L.');

  const backhand = text(p.backhand, 1, 'Backhand');
  if (backhand && !['1', '2'].includes(backhand)) fail('Backhand must be 1 or 2.');

  let avatar = p.avatar ?? null;
  if (avatar === '') avatar = null;
  if (avatar !== null) {
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)) {
      fail('Photo must be a PNG, JPEG or WebP image.');
    }
    if (avatar.length > 400_000) fail('Photo is too large.');
  }

  return {
    name,
    country: country ? country.toUpperCase() : null,
    birthplace: text(p.birthplace, 60, 'Birthplace'),
    born,
    height_cm: int(p.height_cm, 50, 250, 'Height'),
    weight_kg: int(p.weight_kg, 20, 300, 'Weight'),
    plays,
    backhand,
    turned_pro: int(p.turned_pro, 1950, thisYear + 1, 'Turned pro'),
    avatar,
  };
}

/**
 * Validates a match and derives its winner.
 * `sets` are stored from player 1's point of view: [[p1Games, p2Games, tb?], ...]
 * where `tb` is the tie-break points of the set's loser (printed as 7–6⁴).
 */
export function normalizeMatch(input, playerIds) {
  const m = input && typeof input === 'object' ? input : {};

  const date = String(m.date ?? '').trim();
  if (!isValidDate(date)) fail('Please enter a valid date.');

  const event = text(m.event, 80, 'Event', true);

  if (!SURFACES.includes(m.surface)) fail('Please pick a surface.');
  if (!ROUNDS.includes(m.round)) fail('Please pick a round.');
  if (!OUTCOMES.includes(m.outcome)) fail('Please pick a result type.');

  const p1 = int(m.p1, 1, Number.MAX_SAFE_INTEGER, 'Player 1');
  const p2 = int(m.p2, 1, Number.MAX_SAFE_INTEGER, 'Player 2');
  if (!p1 || !p2 || !playerIds.has(p1) || !playerIds.has(p2)) fail('Please pick both players.');
  if (p1 === p2) fail('A player cannot play against themselves.');

  const rawSets = m.sets ?? [];
  if (!Array.isArray(rawSets) || rawSets.length > MAX_SETS) fail(`A match has at most ${MAX_SETS} sets.`);

  const sets = rawSets.map((set, i) => {
    const n = i + 1;
    if (!Array.isArray(set) || set.length < 2 || set.length > 3) fail(`Set ${n} is invalid.`);
    const a = int(set[0], 0, 99, `Set ${n}`);
    const b = int(set[1], 0, 99, `Set ${n}`);
    if (a === null || b === null) fail(`Set ${n} is incomplete.`);
    const tb = set.length === 3 ? int(set[2], 0, 99, `Set ${n} tie-break`) : null;
    if (tb === null) return [a, b];
    if (!isTiebreakSet(a, b)) fail(`Set ${n}: tie-break points only apply to 7–6 sets.`);
    return [a, b, tb];
  });

  let winner = int(m.winner, 1, Number.MAX_SAFE_INTEGER, 'Winner');

  if (m.outcome === 'walkover') {
    sets.length = 0;
    if (winner !== p1 && winner !== p2) fail('Please pick who got the walkover.');
  } else if (m.outcome === 'retired') {
    if (!sets.length) fail('Enter the score at the moment of retirement.');
    if (winner !== p1 && winner !== p2) fail('Please pick the winner (the player who did not retire).');
  } else {
    if (!sets.length) fail('Please enter the score.');
    sets.forEach(([a, b], i) => {
      if (a === b) fail(`Set ${i + 1} has no winner. Use “Retired” for unfinished matches.`);
    });
    const side = setsWinner(sets);
    if (!side) fail('Sets are level. Add the deciding set or mark the match as retired.');
    winner = side === 1 ? p1 : p2;
  }

  return { date, event, surface: m.surface, indoor: Boolean(m.indoor), round: m.round, p1, p2, winner, outcome: m.outcome, sets };
}
