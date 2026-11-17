<?php
/**
 * Storage: PDO with SQLite (default, zero setup) or MySQL (optional, see
 * config.sample.php). The schema is created automatically on first use and
 * data/seed.json is imported once into a fresh database.
 */
declare(strict_types=1);

const H2H_ROOT = __DIR__ . '/..';
const H2H_DATA_DIR = H2H_ROOT . '/data';

function h2h_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $defaults = [
        'admin_password' => '',
        'admin_password_hash' => '',
        'db' => ['dsn' => '', 'user' => null, 'password' => null],
        'debug' => false,
    ];
    $file = H2H_ROOT . '/config.php';
    $user = is_file($file) ? require $file : [];
    $config = array_replace_recursive($defaults, is_array($user) ? $user : []);
    return $config;
}

function h2h_now(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $cfg = h2h_config()['db'];
    $dsn = (string)($cfg['dsn'] ?: 'sqlite:' . H2H_DATA_DIR . '/h2h.sqlite');

    if (strpos($dsn, 'sqlite:') === 0) {
        if (!extension_loaded('pdo_sqlite')) {
            throw new ApiError('The PHP extension pdo_sqlite is not available on this server. Configure MySQL in config.php instead.', 500);
        }
        if (!is_writable(dirname(substr($dsn, 7)))) {
            throw new ApiError('The data/ folder must be writable by PHP (chmod 755 or 775).', 500);
        }
    }

    $pdo = new PDO($dsn, $cfg['user'] ?: null, $cfg['password'] ?: null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    if (db_driver($pdo) === 'sqlite') {
        $pdo->exec('PRAGMA foreign_keys = ON');
    }
    db_migrate($pdo);
    return $pdo;
}

function db_driver(PDO $pdo): string
{
    return (string)$pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
}

function db_migrate(PDO $pdo): void
{
    if (db_driver($pdo) === 'mysql') {
        $opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        $pdo->exec("CREATE TABLE IF NOT EXISTS meta (
            k VARCHAR(64) NOT NULL PRIMARY KEY,
            v TEXT NULL
        ) $opts");
        $pdo->exec("CREATE TABLE IF NOT EXISTS players (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            country VARCHAR(3) NULL,
            birthplace VARCHAR(120) NULL,
            born VARCHAR(10) NULL,
            height_cm SMALLINT NULL,
            weight_kg SMALLINT NULL,
            plays CHAR(1) NULL,
            backhand CHAR(1) NULL,
            turned_pro SMALLINT NULL,
            avatar MEDIUMTEXT NULL,
            created_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL,
            UNIQUE KEY uq_players_name (name)
        ) $opts");
        $pdo->exec("CREATE TABLE IF NOT EXISTS matches (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            played_on CHAR(10) NOT NULL,
            event_name VARCHAR(160) NOT NULL,
            surface VARCHAR(16) NOT NULL,
            indoor TINYINT NOT NULL DEFAULT 0,
            round_code VARCHAR(8) NOT NULL,
            player1_id INT UNSIGNED NOT NULL,
            player2_id INT UNSIGNED NOT NULL,
            winner_id INT UNSIGNED NOT NULL,
            outcome VARCHAR(16) NOT NULL,
            sets_json TEXT NOT NULL,
            created_at VARCHAR(32) NOT NULL,
            updated_at VARCHAR(32) NOT NULL,
            INDEX idx_matches_players (player1_id, player2_id),
            FOREIGN KEY (player1_id) REFERENCES players(id),
            FOREIGN KEY (player2_id) REFERENCES players(id),
            FOREIGN KEY (winner_id) REFERENCES players(id)
        ) $opts");
    } else {
        // Keep in sync with SQLITE_SCHEMA in dev-server.js (same database file format).
        $pdo->exec('CREATE TABLE IF NOT EXISTS meta (
            k TEXT NOT NULL PRIMARY KEY,
            v TEXT
        )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS players (
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
        )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS matches (
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
        )');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_matches_players ON matches (player1_id, player2_id)');
    }

    $version = $pdo->query("SELECT v FROM meta WHERE k = 'schema_version'")->fetchColumn();
    if ($version !== false) {
        return;
    }

    // Fresh database: claim the "schema_version" row first so that two
    // simultaneous first requests can't both import the seed.
    $pdo->beginTransaction();
    try {
        $pdo->prepare("INSERT INTO meta (k, v) VALUES ('schema_version', '1')")->execute();
        db_seed($pdo, H2H_DATA_DIR . '/seed.json');
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        $again = $pdo->query("SELECT v FROM meta WHERE k = 'schema_version'")->fetchColumn();
        if ($again === false) {
            throw $e; // a real error, not a lost race
        }
    }
}

/** Imports a seed / backup file (same format as the export) into an empty database. */
function db_seed(PDO $pdo, string $file): void
{
    if (!is_file($file)) {
        return;
    }
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) {
        throw new RuntimeException("Seed file $file is not valid JSON.");
    }
    $idMap = [];
    foreach ($data['players'] ?? [] as $p) {
        $idMap[(int)($p['id'] ?? 0)] = insert_player($pdo, normalize_player($p));
    }
    $ids = array_values($idMap);
    foreach ($data['matches'] ?? [] as $m) {
        foreach (['p1', 'p2', 'winner'] as $key) {
            $m[$key] = $idMap[(int)($m[$key] ?? 0)] ?? null;
        }
        insert_match($pdo, normalize_match($m, $ids));
    }
}

// ------------------------------------------------------------------ reads

function player_to_api(array $r): array
{
    $intOrNull = function ($v) {
        return $v === null ? null : (int)$v;
    };
    return [
        'id' => (int)$r['id'],
        'name' => $r['name'],
        'country' => $r['country'],
        'birthplace' => $r['birthplace'],
        'born' => $r['born'],
        'height_cm' => $intOrNull($r['height_cm']),
        'weight_kg' => $intOrNull($r['weight_kg']),
        'plays' => $r['plays'],
        'backhand' => $r['backhand'],
        'turned_pro' => $intOrNull($r['turned_pro']),
        'avatar' => $r['avatar'],
    ];
}

function match_to_api(array $r): array
{
    $sets = json_decode((string)$r['sets_json'], true);
    return [
        'id' => (int)$r['id'],
        'date' => $r['played_on'],
        'event' => $r['event_name'],
        'surface' => $r['surface'],
        'indoor' => (bool)(int)$r['indoor'],
        'round' => $r['round_code'],
        'p1' => (int)$r['player1_id'],
        'p2' => (int)$r['player2_id'],
        'winner' => (int)$r['winner_id'],
        'outcome' => $r['outcome'],
        'sets' => is_array($sets) ? $sets : [],
    ];
}

function fetch_players(PDO $pdo): array
{
    $rows = $pdo->query('SELECT * FROM players ORDER BY name')->fetchAll();
    return array_map('player_to_api', $rows);
}

function fetch_matches(PDO $pdo): array
{
    $rows = $pdo->query('SELECT * FROM matches ORDER BY played_on DESC, id DESC')->fetchAll();
    return array_map('match_to_api', $rows);
}

/** @return int[] */
function player_ids(PDO $pdo): array
{
    return array_map('intval', $pdo->query('SELECT id FROM players')->fetchAll(PDO::FETCH_COLUMN));
}

function find_player(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM players WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? player_to_api($row) : null;
}

function find_match(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM matches WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? match_to_api($row) : null;
}

// ----------------------------------------------------------------- writes

function player_params(array $p): array
{
    return [
        ':name' => $p['name'],
        ':country' => $p['country'],
        ':birthplace' => $p['birthplace'],
        ':born' => $p['born'],
        ':height_cm' => $p['height_cm'],
        ':weight_kg' => $p['weight_kg'],
        ':plays' => $p['plays'],
        ':backhand' => $p['backhand'],
        ':turned_pro' => $p['turned_pro'],
        ':avatar' => $p['avatar'],
        ':created' => h2h_now(),
        ':updated' => h2h_now(),
    ];
}

function assert_unique_name(PDO $pdo, string $name, int $exceptId): void
{
    $stmt = $pdo->prepare('SELECT id FROM players WHERE LOWER(name) = LOWER(?) AND id <> ?');
    $stmt->execute([$name, $exceptId]);
    if ($stmt->fetchColumn() !== false) {
        throw new ApiError('A player with that name already exists.', 409);
    }
}

function insert_player(PDO $pdo, array $p): int
{
    assert_unique_name($pdo, $p['name'], 0);
    $pdo->prepare('INSERT INTO players
        (name, country, birthplace, born, height_cm, weight_kg, plays, backhand, turned_pro, avatar, created_at, updated_at)
        VALUES (:name, :country, :birthplace, :born, :height_cm, :weight_kg, :plays, :backhand, :turned_pro, :avatar, :created, :updated)')
        ->execute(player_params($p));
    return (int)$pdo->lastInsertId();
}

function update_player(PDO $pdo, int $id, array $p): void
{
    if (find_player($pdo, $id) === null) {
        throw new ApiError('Player not found.', 404);
    }
    assert_unique_name($pdo, $p['name'], $id);
    $params = player_params($p);
    unset($params[':created']);
    $params[':id'] = $id;
    $pdo->prepare('UPDATE players SET
        name = :name, country = :country, birthplace = :birthplace, born = :born,
        height_cm = :height_cm, weight_kg = :weight_kg, plays = :plays, backhand = :backhand,
        turned_pro = :turned_pro, avatar = :avatar, updated_at = :updated
        WHERE id = :id')->execute($params);
}

function delete_player(PDO $pdo, int $id): void
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM matches WHERE player1_id = ? OR player2_id = ?');
    $stmt->execute([$id, $id]);
    $count = (int)$stmt->fetchColumn();
    if ($count > 0) {
        $what = $count === 1 ? '1 match' : "$count matches";
        throw new ApiError("This player still has $what. Delete those first.", 409);
    }
    $stmt = $pdo->prepare('DELETE FROM players WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        throw new ApiError('Player not found.', 404);
    }
}

function match_params(array $m): array
{
    return [
        ':played_on' => $m['date'],
        ':event_name' => $m['event'],
        ':surface' => $m['surface'],
        ':indoor' => $m['indoor'] ? 1 : 0,
        ':round_code' => $m['round'],
        ':player1_id' => $m['p1'],
        ':player2_id' => $m['p2'],
        ':winner_id' => $m['winner'],
        ':outcome' => $m['outcome'],
        ':sets_json' => json_encode($m['sets']),
        ':created' => h2h_now(),
        ':updated' => h2h_now(),
    ];
}

function insert_match(PDO $pdo, array $m): int
{
    $pdo->prepare('INSERT INTO matches
        (played_on, event_name, surface, indoor, round_code, player1_id, player2_id, winner_id, outcome, sets_json, created_at, updated_at)
        VALUES (:played_on, :event_name, :surface, :indoor, :round_code, :player1_id, :player2_id, :winner_id, :outcome, :sets_json, :created, :updated)')
        ->execute(match_params($m));
    return (int)$pdo->lastInsertId();
}

function update_match(PDO $pdo, int $id, array $m): void
{
    if (find_match($pdo, $id) === null) {
        throw new ApiError('Match not found.', 404);
    }
    $params = match_params($m);
    unset($params[':created']);
    $params[':id'] = $id;
    $pdo->prepare('UPDATE matches SET
        played_on = :played_on, event_name = :event_name, surface = :surface, indoor = :indoor,
        round_code = :round_code, player1_id = :player1_id, player2_id = :player2_id,
        winner_id = :winner_id, outcome = :outcome, sets_json = :sets_json, updated_at = :updated
        WHERE id = :id')->execute($params);
}

function delete_match(PDO $pdo, int $id): void
{
    $stmt = $pdo->prepare('DELETE FROM matches WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        throw new ApiError('Match not found.', 404);
    }
}
