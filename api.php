<?php
/**
 * Head 2 Head - JSON API (production backend, PHP 7.4+).
 *
 *   GET  api.php?action=data            players + matches (public)
 *   GET  api.php?action=export          JSON backup download (admin)
 *   POST api.php?action=login           {password}
 *   POST api.php?action=logout
 *   POST api.php?action=player.save     {id?, name, country, ...}
 *   POST api.php?action=player.delete   {id}
 *   POST api.php?action=match.save      {id?, date, event, surface, ...}
 *   POST api.php?action=match.delete    {id}
 *
 * POST requests must send the header "X-H2H: 1". Browsers can't add custom
 * headers to cross-site requests without a CORS pre-flight (which we never
 * allow), so this blocks CSRF without tokens.
 *
 * The Node dev server (dev-server.js) implements the same contract.
 */
declare(strict_types=1);

require __DIR__ . '/lib/validate.php';
require __DIR__ . '/lib/store.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// ---------------------------------------------------------------- session

const H2H_SESSION = 'h2h_admin';

function session_begin(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    // Own session directory so our 30-day lifetime isn't cut short by the
    // host's global session garbage collection.
    $dir = H2H_DATA_DIR . '/sessions';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    if (is_dir($dir) && is_writable($dir)) {
        session_save_path($dir);
        ini_set('session.gc_probability', '1');
        ini_set('session.gc_divisor', '100');
    }
    $lifetime = 60 * 60 * 24 * 30;
    ini_set('session.gc_maxlifetime', (string)$lifetime);
    ini_set('session.use_strict_mode', '1');

    $path = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
    session_name(H2H_SESSION);
    session_set_cookie_params([
        'lifetime' => $lifetime,
        'path' => $path,
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function is_admin(): bool
{
    // Only visitors who ever signed in carry the cookie; everyone else
    // never gets a session (or a cookie) at all.
    if (empty($_COOKIE[H2H_SESSION])) {
        return false;
    }
    session_begin();
    return !empty($_SESSION['admin']);
}

function require_admin(): void
{
    if (!is_admin()) {
        throw new ApiError('Please sign in first.', 401);
    }
}

function editing_enabled(array $config): bool
{
    if (!empty($config['admin_password_hash'])) {
        return true;
    }
    $plain = (string)$config['admin_password'];
    return $plain !== '' && $plain !== 'change-me';
}

function password_ok(array $config, string $password): bool
{
    if (!empty($config['admin_password_hash'])) {
        return password_verify($password, (string)$config['admin_password_hash']);
    }
    return editing_enabled($config) && hash_equals((string)$config['admin_password'], $password);
}

// ---------------------------------------------------------------- helpers

function read_json_body(): array
{
    $raw = (string)file_get_contents('php://input');
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new ApiError('Invalid JSON body.');
    }
    return $data;
}

function body_id(array $body): ?int
{
    $id = $body['id'] ?? null;
    if ($id === null || $id === '' || $id === 0) {
        return null;
    }
    if (is_int($id) && $id > 0) {
        return $id;
    }
    if (is_string($id) && ctype_digit($id)) {
        return (int)$id;
    }
    throw new ApiError('Invalid id.');
}

// ----------------------------------------------------------------- router

$config = [];
try {
    $config = h2h_config();
    $action = (string)($_GET['action'] ?? '');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $body = [];

    if ($method === 'POST') {
        if (($_SERVER['HTTP_X_H2H'] ?? '') !== '1') {
            throw new ApiError('Missing X-H2H request header.');
        }
        $body = read_json_body();
    } elseif ($method !== 'GET') {
        throw new ApiError('Method not allowed.', 405);
    }

    switch ("$method $action") {
        case 'GET data':
            $pdo = db();
            respond([
                'players' => fetch_players($pdo),
                'matches' => fetch_matches($pdo),
                'admin' => is_admin(),
                'editable' => editing_enabled($config),
            ]);
            break;

        case 'GET export':
            require_admin();
            $pdo = db();
            header('Content-Disposition: attachment; filename="h2h-backup-' . date('Y-m-d') . '.json"');
            echo json_encode([
                'exported_at' => h2h_now(),
                'players' => fetch_players($pdo),
                'matches' => fetch_matches($pdo),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            exit;

        case 'POST login':
            if (!editing_enabled($config)) {
                throw new ApiError('Editing is not set up yet: copy config.sample.php to config.php and set a password.', 503);
            }
            if (!password_ok($config, (string)($body['password'] ?? ''))) {
                usleep(800000); // slow down guessing
                throw new ApiError('Wrong password.', 401);
            }
            session_begin();
            session_regenerate_id(true);
            $_SESSION['admin'] = true;
            respond(['admin' => true]);
            break;

        case 'POST logout':
            if (!empty($_COOKIE[H2H_SESSION])) {
                session_begin();
                $_SESSION = [];
                session_destroy();
                $params = session_get_cookie_params();
                setcookie(H2H_SESSION, '', [
                    'expires' => time() - 3600,
                    'path' => $params['path'],
                    'secure' => $params['secure'],
                    'httponly' => true,
                    'samesite' => 'Lax',
                ]);
            }
            respond(['admin' => false]);
            break;

        case 'POST player.save':
            require_admin();
            $pdo = db();
            $player = normalize_player($body);
            $id = body_id($body);
            if ($id === null) {
                $id = insert_player($pdo, $player);
            } else {
                update_player($pdo, $id, $player);
            }
            respond(['player' => find_player($pdo, $id)]);
            break;

        case 'POST player.delete':
            require_admin();
            $id = body_id($body);
            if ($id === null) {
                throw new ApiError('Invalid id.');
            }
            delete_player(db(), $id);
            respond(['deleted' => $id]);
            break;

        case 'POST match.save':
            require_admin();
            $pdo = db();
            $match = normalize_match($body, player_ids($pdo));
            $id = body_id($body);
            if ($id === null) {
                $id = insert_match($pdo, $match);
            } else {
                update_match($pdo, $id, $match);
            }
            respond(['match' => find_match($pdo, $id)]);
            break;

        case 'POST match.delete':
            require_admin();
            $id = body_id($body);
            if ($id === null) {
                throw new ApiError('Invalid id.');
            }
            delete_match(db(), $id);
            respond(['deleted' => $id]);
            break;

        default:
            throw new ApiError('Unknown action.', 404);
    }
} catch (ApiError $e) {
    respond(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('[h2h] ' . $e);
    $message = !empty($config['debug']) ? $e->getMessage() : 'Server error. Set debug => true in config.php for details.';
    respond(['error' => $message], 500);
}
