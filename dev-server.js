// Local development server - no PHP needed.
//
//   npm run dev                      → http://localhost:8000  (password: admin)
//   H2H_PASSWORD=secret PORT=3000 npm run dev
//
// Serves the static site and implements the same JSON API as api.php on top of
// Node's built-in SQLite (Node >= 22.13). It uses the same schema and database
// file (data/h2h.sqlite) as the PHP backend, so a local database can be
// uploaded to the server as-is.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMatch, normalizePlayer, ValidationError } from './assets/js/model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const PASSWORD = process.env.H2H_PASSWORD || 'admin';
const DB_FILE = process.env.H2H_DB || path.join(ROOT, 'data', 'h2h.sqlite');
const SEED_FILE = process.env.H2H_SEED || path.join(ROOT, 'data', 'seed.json');
const COOKIE = 'h2h_admin';

// Keep in sync with the SQLite branch of db_migrate() in lib/store.php.
const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT NOT NULL PRIMARY KEY,
    v TEXT
  );
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    country TEXT,
    birthplace TEXT,
    born TEXT,
    height_cm INTEGER,
    weight_kg INTEGER,
    plays TEXT,
    backhand TEXT,
    turned_pro INTEGER,
    avatar TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    played_on TEXT NOT NULL,
    event_name TEXT NOT NULL,
    surface TEXT NOT NULL,
    indoor INTEGER NOT NULL DEFAULT 0,
    round_code TEXT NOT NULL,
    player1_id INTEGER NOT NULL REFERENCES players(id),
    player2_id INTEGER NOT NULL REFERENCES players(id),
    winner_id INTEGER NOT NULL REFERENCES players(id),
    outcome TEXT NOT NULL,
    sets_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_matches_players ON matches (player1_id, player2_id);
`;

// ------------------------------------------------------------------ store

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');
db.exec(SQLITE_SCHEMA);

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const playerToApi = (r) => ({
  id: r.id,
  name: r.name,
  country: r.country,
  birthplace: r.birthplace,
  born: r.born,
  height_cm: r.height_cm,
  weight_kg: r.weight_kg,
  plays: r.plays,
  backhand: r.backhand,
  turned_pro: r.turned_pro,
  avatar: r.avatar,
});

const matchToApi = (r) => ({
  id: r.id,
  date: r.played_on,
  event: r.event_name,
  surface: r.surface,
  indoor: Boolean(r.indoor),
  round: r.round_code,
  p1: r.player1_id,
  p2: r.player2_id,
  winner: r.winner_id,
  outcome: r.outcome,
  sets: JSON.parse(r.sets_json || '[]'),
});

const store = {
  players: () => db.prepare('SELECT * FROM players ORDER BY name').all().map(playerToApi),
  matches: () => db.prepare('SELECT * FROM matches ORDER BY played_on DESC, id DESC').all().map(matchToApi),
  playerIds: () => new Set(db.prepare('SELECT id FROM players').all().map((r) => r.id)),
  findPlayer(id) {
    const r = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    return r ? playerToApi(r) : null;
  },
  findMatch(id) {
    const r = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    return r ? matchToApi(r) : null;
  },
  assertUniqueName(name, exceptId) {
    const r = db.prepare('SELECT id FROM players WHERE LOWER(name) = LOWER(?) AND id <> ?').get(name, exceptId);
    if (r) throw new ApiError('A player with that name already exists.', 409);
  },
  savePlayer(id, p) {
    const values = [p.name, p.country, p.birthplace, p.born, p.height_cm, p.weight_kg, p.plays, p.backhand, p.turned_pro, p.avatar];
    if (id === null) {
      this.assertUniqueName(p.name, 0);
      const t = now();
      const r = db
        .prepare(`INSERT INTO players (name, country, birthplace, born, height_cm, weight_kg, plays, backhand, turned_pro, avatar, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, t, t);
      return Number(r.lastInsertRowid);
    }
    if (!this.findPlayer(id)) throw new ApiError('Player not found.', 404);
    this.assertUniqueName(p.name, id);
    db.prepare(`UPDATE players SET name = ?, country = ?, birthplace = ?, born = ?, height_cm = ?, weight_kg = ?,
                plays = ?, backhand = ?, turned_pro = ?, avatar = ?, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
    return id;
  },
  deletePlayer(id) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM matches WHERE player1_id = ? OR player2_id = ?').get(id, id);
    if (n > 0) throw new ApiError(`This player still has ${n === 1 ? '1 match' : `${n} matches`}. Delete those first.`, 409);
    const r = db.prepare('DELETE FROM players WHERE id = ?').run(id);
    if (!r.changes) throw new ApiError('Player not found.', 404);
  },
  saveMatch(id, m) {
    const values = [m.date, m.event, m.surface, m.indoor ? 1 : 0, m.round, m.p1, m.p2, m.winner, m.outcome, JSON.stringify(m.sets)];
    if (id === null) {
      const t = now();
      const r = db
        .prepare(`INSERT INTO matches (played_on, event_name, surface, indoor, round_code, player1_id, player2_id, winner_id, outcome, sets_json, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, t, t);
      return Number(r.lastInsertRowid);
    }
    if (!this.findMatch(id)) throw new ApiError('Match not found.', 404);
    db.prepare(`UPDATE matches SET played_on = ?, event_name = ?, surface = ?, indoor = ?, round_code = ?, player1_id = ?,
                player2_id = ?, winner_id = ?, outcome = ?, sets_json = ?, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
    return id;
  },
  deleteMatch(id) {
    const r = db.prepare('DELETE FROM matches WHERE id = ?').run(id);
    if (!r.changes) throw new ApiError('Match not found.', 404);
  },
};

// Seed a fresh database once (same rule as the PHP backend).
if (!db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()) {
  transaction(() => {
    db.prepare("INSERT INTO meta (k, v) VALUES ('schema_version', '1')").run();
    if (!fs.existsSync(SEED_FILE)) return;
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const idMap = new Map();
    for (const p of seed.players ?? []) idMap.set(p.id, store.savePlayer(null, normalizePlayer(p)));
    const ids = new Set(idMap.values());
    for (const m of seed.matches ?? []) {
      const mapped = { ...m, p1: idMap.get(m.p1), p2: idMap.get(m.p2), winner: idMap.get(m.winner) };
      store.saveMatch(null, normalizeMatch(mapped, ids));
    }
    console.log(`Seeded database from ${path.relative(ROOT, SEED_FILE)}`);
  });
}

// ------------------------------------------------------------------- auth

const sessions = new Set();

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

const isAdmin = (req) => sessions.has(parseCookies(req.headers.cookie)[COOKIE]);

function requireAdmin(req) {
  if (!isAdmin(req)) throw new ApiError('Please sign in first.', 401);
}

function bodyId(body) {
  const id = body.id;
  if (id === null || id === undefined || id === '' || id === 0) return null;
  const n = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
  if (!Number.isInteger(n) || n < 1) throw new ApiError('Invalid id.');
  return n;
}

// -------------------------------------------------------------------- api

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new ApiError('Request too large.', 413);
  }
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    /* fall through */
  }
  throw new ApiError('Invalid JSON body.');
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res, url) {
  const action = url.searchParams.get('action') ?? '';
  let body = {};
  if (req.method === 'POST') {
    if (req.headers['x-h2h'] !== '1') throw new ApiError('Missing X-H2H request header.');
    body = await readJson(req);
  } else if (req.method !== 'GET') {
    throw new ApiError('Method not allowed.', 405);
  }

  switch (`${req.method} ${action}`) {
    case 'GET data':
      return send(res, 200, { players: store.players(), matches: store.matches(), admin: isAdmin(req), editable: true });

    case 'GET export': {
      requireAdmin(req);
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="h2h-backup-${date}.json"`,
      });
      return res.end(JSON.stringify({ exported_at: now(), players: store.players(), matches: store.matches() }, null, 4));
    }

    case 'POST login': {
      const given = Buffer.from(String(body.password ?? ''));
      const expected = Buffer.from(PASSWORD);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        await new Promise((r) => setTimeout(r, 800));
        throw new ApiError('Wrong password.', 401);
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      return send(res, 200, { admin: true }, {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
      });
    }

    case 'POST logout':
      sessions.delete(parseCookies(req.headers.cookie)[COOKIE]);
      return send(res, 200, { admin: false }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });

    case 'POST player.save': {
      requireAdmin(req);
      const id = store.savePlayer(bodyId(body), normalizePlayer(body));
      return send(res, 200, { player: store.findPlayer(id) });
    }

    case 'POST player.delete': {
      requireAdmin(req);
      const id = bodyId(body);
      if (id === null) throw new ApiError('Invalid id.');
      store.deletePlayer(id);
      return send(res, 200, { deleted: id });
    }

    case 'POST match.save': {
      requireAdmin(req);
      const id = store.saveMatch(bodyId(body), normalizeMatch(body, store.playerIds()));
      return send(res, 200, { match: store.findMatch(id) });
    }

    case 'POST match.delete': {
      requireAdmin(req);
      const id = bodyId(body);
      if (id === null) throw new ApiError('Invalid id.');
      store.deleteMatch(id);
      return send(res, 200, { deleted: id });
    }

    default:
      throw new ApiError('Unknown action.', 404);
  }
}

// ----------------------------------------------------------------- static

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  // Only the public parts of the site, like the .htaccess rules on Apache.
  const isPublic = file === path.join(ROOT, 'index.html') || file.startsWith(path.join(ROOT, 'assets') + path.sep);
  if (!isPublic || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api.php') await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof ApiError || e instanceof ValidationError) {
      send(res, e.status ?? 400, { error: e.message });
    } else {
      console.error(e);
      send(res, 500, { error: e.message || 'Server error.' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`H2H dev server → http://localhost:${PORT}  (admin password: ${PASSWORD === 'admin' ? 'admin' : '••••••'})`);
});
