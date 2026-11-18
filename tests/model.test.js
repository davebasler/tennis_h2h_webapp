// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { scoreText } from '../assets/js/dom.js';
import { normalizeMatch, normalizePlayer, slugify, ValidationError } from '../assets/js/model.js';
import { age, headToHead, record } from '../assets/js/stats.js';

const ids = new Set([1, 2, 3]);
const base = { date: '2024-05-25', event: 'Test Open', surface: 'Clay', indoor: false, round: 'F', p1: 1, p2: 2, outcome: 'completed' };

test('completed match: winner is derived from the sets', () => {
  const m = normalizeMatch({ ...base, winner: 1, sets: [[4, 6], [7, 6, 5], [3, 6]] }, ids);
  assert.equal(m.winner, 2);
  assert.deepEqual(m.sets, [[4, 6], [7, 6, 5], [3, 6]]);
});

test('completed match: level sets and unfinished sets are rejected', () => {
  assert.throws(() => normalizeMatch({ ...base, sets: [[6, 4], [4, 6]] }, ids), ValidationError);
  assert.throws(() => normalizeMatch({ ...base, sets: [[4, 4]] }, ids), /no winner/);
  assert.throws(() => normalizeMatch({ ...base, sets: [] }, ids), /enter the score/);
});

test('tie-break points only on 7–6 sets', () => {
  assert.throws(() => normalizeMatch({ ...base, sets: [[6, 4, 3]] }, ids), /tie-break/);
  assert.deepEqual(normalizeMatch({ ...base, sets: [[6, 7, 4], [6, 1], [6, 2]] }, ids).sets[0], [6, 7, 4]);
});

test('retired and walkover need an explicit winner', () => {
  assert.throws(() => normalizeMatch({ ...base, outcome: 'retired', sets: [[4, 4]] }, ids), /winner/);
  assert.equal(normalizeMatch({ ...base, outcome: 'retired', winner: 1, sets: [[4, 4]] }, ids).winner, 1);
  const wo = normalizeMatch({ ...base, outcome: 'walkover', winner: 2, sets: [[6, 0]] }, ids);
  assert.deepEqual(wo.sets, []);
  assert.equal(wo.winner, 2);
});

test('players must exist and differ', () => {
  assert.throws(() => normalizeMatch({ ...base, p2: 1, sets: [[6, 0]] }, ids), /themselves/);
  assert.throws(() => normalizeMatch({ ...base, p2: 9, sets: [[6, 0]] }, ids), /both players/);
});

test('player validation', () => {
  const p = normalizePlayer({ name: '  Alex ', country: 'sui', born: '1997', height_cm: '175', plays: 'R' });
  assert.equal(p.name, 'Alex');
  assert.equal(p.country, 'SUI');
  assert.equal(p.height_cm, 175);
  assert.throws(() => normalizePlayer({ name: '' }), /required/);
  assert.throws(() => normalizePlayer({ name: 'X', born: '1997-02-30' }), /Born/);
  assert.throws(() => normalizePlayer({ name: 'X', avatar: 'javascript:alert(1)' }), /Photo/);
});

test('slugs are URL friendly', () => {
  assert.equal(slugify('Zoë Müller'), 'zoe-muller');
  assert.equal(slugify('  Sam  '), 'sam');
});

test('score text is printed from the winner’s side', () => {
  const m = { p1: 1, p2: 2, winner: 2, outcome: 'completed', sets: [[4, 6], [7, 6, 5], [3, 6]] };
  assert.equal(scoreText(m), '6–4 6–7(5) 6–3');
  assert.equal(scoreText({ ...m, winner: 1, outcome: 'completed', sets: [[10, 8]] }), '[10–8]');
  assert.equal(scoreText({ ...m, winner: 1, outcome: 'retired', sets: [[4, 4]] }), '4–4 ret.');
});

test('age from year or full date', () => {
  const now = new Date(2026, 10, 17);
  assert.equal(age('1997', now), 29);
  assert.equal(age('1997-12-01', now), 28);
  assert.equal(age('1997-11-17', now), 29);
});

test('UI code never iterates over a single-element $() lookup', () => {
  // $() returns one element, $$() an array. Mixing them up broke the match dialog once.
  for (const file of fs.readdirSync(new URL('../assets/js/', import.meta.url))) {
    const src = fs.readFileSync(new URL(`../assets/js/${file}`, import.meta.url), 'utf8');
    const bad = src.match(/(?<!\$)\$\([^()]*\)\.(forEach|map|filter|some|every)\(/);
    assert.equal(bad, null, `${file}: ${bad?.[0]}`);
  }
});

test('demo seed data is valid and its statistics add up', () => {
  const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const seedIds = new Set(seed.players.map((p) => p.id));
  seed.players.forEach((p) => normalizePlayer(p));
  const matches = seed.matches.map((m, i) => ({ id: i + 1, ...normalizeMatch(m, seedIds) }));

  // Every stored winner agrees with the score.
  seed.matches.forEach((m, i) => assert.equal(matches[i].winner, m.winner));

  assert.deepEqual(headToHead(matches, 1, 2).wins, [11, 5]); // Alex vs Robin
  assert.deepEqual(headToHead(matches, 1, 3).wins, [5, 2]); // Alex vs Sam
  assert.equal(headToHead(matches, 3, 4).total, 0); // Sam and Jules never met

  // Career W/L excludes walkovers; a title is a final won.
  assert.deepEqual(record(matches, 1), { wins: 17, losses: 8, titles: 9 });
  assert.deepEqual(record(matches, 2), { wins: 8, losses: 17, titles: 4 });
  assert.deepEqual(record(matches, 3), { wins: 5, losses: 7, titles: 1 });
  assert.deepEqual(record(matches, 4), { wins: 4, losses: 2, titles: 2 });
  assert.deepEqual(record(matches, 2, 2026), { wins: 1, losses: 3, titles: 0 });
});
