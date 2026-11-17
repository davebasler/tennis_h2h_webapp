// Pure statistics over the match list. No DOM in here.
//
// Conventions (matching the original hand-written site):
//  - Walkovers count in the head-to-head record but not in W/L records.
//  - A title is a final won (including a final won by walkover).

import { isMatchTiebreak, isTiebreakSet } from './model.js';

const byDateAsc = (x, y) => x.date.localeCompare(y.date) || x.id - y.id;
const byDateDesc = (x, y) => byDateAsc(y, x);

export const yearOf = (match) => Number(match.date.slice(0, 4));

/** All meetings of a and b, newest first. */
export function meetings(matches, a, b) {
  return matches
    .filter((m) => (m.p1 === a && m.p2 === b) || (m.p1 === b && m.p2 === a))
    .sort(byDateDesc);
}

/** Number of meetings for every pair, keyed "minId-maxId". */
export function pairCounts(matches) {
  const counts = new Map();
  for (const m of matches) {
    const key = m.p1 < m.p2 ? `${m.p1}-${m.p2}` : `${m.p2}-${m.p1}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Games of `player` and the opponent in a set, from the player's side. */
const side = (match, set, player) => (match.p1 === player ? [set[0], set[1]] : [set[1], set[0]]);

export function headToHead(matches, a, b) {
  const list = meetings(matches, a, b);
  const s = {
    total: list.length,
    wins: [0, 0],
    walkovers: 0,
    retirements: 0,
    sets: [0, 0],
    games: [0, 0],
    tiebreaks: [0, 0],
    deciders: [0, 0],
    finals: [0, 0],
    longestStreak: [0, 0],
    current: null, // { who: 0|1, length }
    bySurface: new Map(), // surface -> [winsA, winsB]
    byYear: new Map(), // year -> [winsA, winsB]
    list,
  };

  const bump = (map, key, idx) => {
    if (!map.has(key)) map.set(key, [0, 0]);
    map.get(key)[idx]++;
  };

  let run = { who: null, length: 0 };
  for (const m of [...list].sort(byDateAsc)) {
    const w = m.winner === a ? 0 : 1;
    s.wins[w]++;
    if (m.round === 'F') s.finals[w]++;
    bump(s.bySurface, m.surface, w);
    bump(s.byYear, yearOf(m), w);

    run = run.who === w ? { who: w, length: run.length + 1 } : { who: w, length: 1 };
    s.longestStreak[w] = Math.max(s.longestStreak[w], run.length);

    if (m.outcome === 'walkover') {
      s.walkovers++;
      continue;
    }
    if (m.outcome === 'retired') s.retirements++;

    const before = [0, 0];
    m.sets.forEach((set, i) => {
      const [ga, gb] = side(m, set, a);
      const setWinner = ga > gb ? 0 : gb > ga ? 1 : null;
      if (setWinner === null) return; // unfinished set (retirement)
      const isLast = i === m.sets.length - 1;
      if (isLast && m.outcome === 'completed' && i >= 2 && before[0] === before[1]) {
        s.deciders[setWinner]++;
      }
      s.sets[setWinner]++;
      before[setWinner]++;
      if (isMatchTiebreak(set)) {
        s.tiebreaks[setWinner]++;
      } else {
        s.games[0] += ga;
        s.games[1] += gb;
        if (isTiebreakSet(ga, gb)) s.tiebreaks[setWinner]++;
      }
    });
  }
  if (run.who !== null) s.current = run;
  return s;
}

/** Career (or single-season) W/L and titles for one player. */
export function record(matches, player, year = null) {
  const r = { wins: 0, losses: 0, titles: 0 };
  for (const m of matches) {
    if (m.p1 !== player && m.p2 !== player) continue;
    if (year !== null && yearOf(m) !== year) continue;
    const won = m.winner === player;
    if (won && m.round === 'F') r.titles++;
    if (m.outcome === 'walkover') continue;
    if (won) r.wins++;
    else r.losses++;
  }
  return r;
}

/** Age in whole years from "YYYY" or "YYYY-MM-DD". */
export function age(born, now = new Date()) {
  if (!born) return null;
  const y = Number(born.slice(0, 4));
  if (born.length === 4) return now.getFullYear() - y;
  const m = Number(born.slice(5, 7));
  const d = Number(born.slice(8, 10));
  let years = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) years--;
  return years;
}
