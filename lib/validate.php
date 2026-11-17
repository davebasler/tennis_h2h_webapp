<?php
/**
 * Input validation - a PHP port of assets/js/model.js (normalizePlayer /
 * normalizeMatch). Keep both in sync when changing a rule.
 */
declare(strict_types=1);

const H2H_SURFACES = ['Clay', 'Hard', 'Grass', 'Carpet'];
const H2H_ROUNDS = ['F', 'SF', 'QF', 'R16', 'R32', 'R64', 'RR', 'Q'];
const H2H_OUTCOMES = ['completed', 'retired', 'walkover'];
const H2H_MAX_SETS = 5;

/** An error whose message is safe to show to the user. */
class ApiError extends RuntimeException
{
    /** @var int */
    public $status;

    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function v_fail(string $message): void
{
    throw new ApiError($message, 400);
}

function v_strlen(string $s): int
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : (int)preg_match_all('/./us', $s);
}

/** Trimmed text without control characters, or null when empty. */
function v_text($value, int $max, string $label, bool $required = false): ?string
{
    if ($value !== null && !is_string($value) && !is_int($value) && !is_float($value)) {
        v_fail("$label is invalid.");
    }
    $s = (string)($value ?? '');
    if ($s !== '' && !preg_match('//u', $s)) {
        v_fail("$label is invalid.");
    }
    $s = trim((string)preg_replace('/[\x00-\x1F\x7F]/u', '', $s));
    if ($s === '') {
        if ($required) {
            v_fail("$label is required.");
        }
        return null;
    }
    if (v_strlen($s) > $max) {
        v_fail("$label is too long (max $max characters).");
    }
    return $s;
}

/** Whole number within [min, max], or null when empty. */
function v_int($value, int $min, int $max, string $label): ?int
{
    if ($value === null || $value === '') {
        return null;
    }
    if (is_string($value) && preg_match('/^\s*-?\d+\s*$/', $value)) {
        $value = (int)trim($value);
    } elseif (is_float($value) && floor($value) === $value && abs($value) < PHP_INT_MAX) {
        $value = (int)$value;
    }
    if (!is_int($value)) {
        v_fail("$label must be a whole number.");
    }
    if ($value < $min || $value > $max) {
        v_fail("$label must be between $min and $max.");
    }
    return $value;
}

function v_is_date($value): bool
{
    if (!is_string($value) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m)) {
        return false;
    }
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}

function is_tiebreak_set(int $a, int $b): bool
{
    return ($a === 7 && $b === 6) || ($a === 6 && $b === 7);
}

/** 1 if player 1 won more sets, 2 if player 2 did, 0 if level. */
function sets_winner(array $sets): int
{
    $a = 0;
    $b = 0;
    foreach ($sets as $set) {
        if ($set[0] > $set[1]) {
            $a++;
        } elseif ($set[1] > $set[0]) {
            $b++;
        }
    }
    return $a > $b ? 1 : ($b > $a ? 2 : 0);
}

function normalize_player($input): array
{
    $p = is_array($input) ? $input : [];
    $thisYear = (int)date('Y');

    $name = v_text($p['name'] ?? null, 40, 'Name', true);

    $country = v_text($p['country'] ?? null, 3, 'Country');
    if ($country !== null && !preg_match('/^[A-Za-z]{2,3}$/', $country)) {
        v_fail('Country must be a 2–3 letter code, e.g. SUI.');
    }

    $born = v_text($p['born'] ?? null, 10, 'Born');
    if ($born !== null) {
        $year = (int)substr($born, 0, 4);
        $ok = preg_match('/^\d{4}$/', $born) || v_is_date($born);
        if (!$ok || $year < 1900 || $year > $thisYear) {
            v_fail('Born must be a year (1997) or a date (1997-03-14).');
        }
    }

    $plays = v_text($p['plays'] ?? null, 1, 'Plays');
    if ($plays !== null && !in_array($plays, ['R', 'L'], true)) {
        v_fail('Plays must be R or L.');
    }

    $backhand = v_text($p['backhand'] ?? null, 1, 'Backhand');
    if ($backhand !== null && !in_array($backhand, ['1', '2'], true)) {
        v_fail('Backhand must be 1 or 2.');
    }

    $avatar = $p['avatar'] ?? null;
    if ($avatar === '') {
        $avatar = null;
    }
    if ($avatar !== null) {
        if (!is_string($avatar) || !preg_match('#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$#', $avatar)) {
            v_fail('Photo must be a PNG, JPEG or WebP image.');
        }
        if (strlen($avatar) > 400000) {
            v_fail('Photo is too large.');
        }
    }

    return [
        'name' => $name,
        'country' => $country !== null ? strtoupper($country) : null,
        'birthplace' => v_text($p['birthplace'] ?? null, 60, 'Birthplace'),
        'born' => $born,
        'height_cm' => v_int($p['height_cm'] ?? null, 50, 250, 'Height'),
        'weight_kg' => v_int($p['weight_kg'] ?? null, 20, 300, 'Weight'),
        'plays' => $plays,
        'backhand' => $backhand,
        'turned_pro' => v_int($p['turned_pro'] ?? null, 1950, $thisYear + 1, 'Turned pro'),
        'avatar' => $avatar,
    ];
}

/**
 * Validates a match and derives its winner.
 * Sets are stored from player 1's point of view: [[p1Games, p2Games, tb?], ...].
 *
 * @param int[] $playerIds ids of all existing players
 */
function normalize_match($input, array $playerIds): array
{
    $m = is_array($input) ? $input : [];

    $date = is_string($m['date'] ?? null) ? trim($m['date']) : '';
    if (!v_is_date($date)) {
        v_fail('Please enter a valid date.');
    }

    $event = v_text($m['event'] ?? null, 80, 'Event', true);

    $surface = $m['surface'] ?? null;
    if (!in_array($surface, H2H_SURFACES, true)) {
        v_fail('Please pick a surface.');
    }
    $round = $m['round'] ?? null;
    if (!in_array($round, H2H_ROUNDS, true)) {
        v_fail('Please pick a round.');
    }
    $outcome = $m['outcome'] ?? null;
    if (!in_array($outcome, H2H_OUTCOMES, true)) {
        v_fail('Please pick a result type.');
    }

    $p1 = v_int($m['p1'] ?? null, 1, PHP_INT_MAX, 'Player 1');
    $p2 = v_int($m['p2'] ?? null, 1, PHP_INT_MAX, 'Player 2');
    if ($p1 === null || $p2 === null || !in_array($p1, $playerIds, true) || !in_array($p2, $playerIds, true)) {
        v_fail('Please pick both players.');
    }
    if ($p1 === $p2) {
        v_fail('A player cannot play against themselves.');
    }

    $rawSets = $m['sets'] ?? [];
    if (!is_array($rawSets) || count($rawSets) > H2H_MAX_SETS) {
        v_fail('A match has at most ' . H2H_MAX_SETS . ' sets.');
    }

    $sets = [];
    foreach (array_values($rawSets) as $i => $set) {
        $n = $i + 1;
        if (!is_array($set) || count($set) < 2 || count($set) > 3) {
            v_fail("Set $n is invalid.");
        }
        $set = array_values($set);
        $a = v_int($set[0], 0, 99, "Set $n");
        $b = v_int($set[1], 0, 99, "Set $n");
        if ($a === null || $b === null) {
            v_fail("Set $n is incomplete.");
        }
        $tb = count($set) === 3 ? v_int($set[2], 0, 99, "Set $n tie-break") : null;
        if ($tb === null) {
            $sets[] = [$a, $b];
            continue;
        }
        if (!is_tiebreak_set($a, $b)) {
            v_fail("Set $n: tie-break points only apply to 7–6 sets.");
        }
        $sets[] = [$a, $b, $tb];
    }

    $winner = v_int($m['winner'] ?? null, 1, PHP_INT_MAX, 'Winner');

    if ($outcome === 'walkover') {
        $sets = [];
        if ($winner !== $p1 && $winner !== $p2) {
            v_fail('Please pick who got the walkover.');
        }
    } elseif ($outcome === 'retired') {
        if (!$sets) {
            v_fail('Enter the score at the moment of retirement.');
        }
        if ($winner !== $p1 && $winner !== $p2) {
            v_fail('Please pick the winner (the player who did not retire).');
        }
    } else {
        if (!$sets) {
            v_fail('Please enter the score.');
        }
        foreach ($sets as $i => $set) {
            if ($set[0] === $set[1]) {
                v_fail('Set ' . ($i + 1) . ' has no winner. Use “Retired” for unfinished matches.');
            }
        }
        $side = sets_winner($sets);
        if ($side === 0) {
            v_fail('Sets are level. Add the deciding set or mark the match as retired.');
        }
        $winner = $side === 1 ? $p1 : $p2;
    }

    return [
        'date' => $date,
        'event' => $event,
        'surface' => $surface,
        'indoor' => !empty($m['indoor']),
        'round' => $round,
        'p1' => $p1,
        'p2' => $p2,
        'winner' => $winner,
        'outcome' => $outcome,
        'sets' => $sets,
    ];
}
