<?php
/**
 * Copy this file to config.php and adjust it. config.php is git-ignored,
 * so your password never ends up in the repository.
 */
return [
    // Password for adding/editing matches and players.
    // Either set a plain password here ...
    'admin_password' => 'change-me',

    // ... or (nicer) a hash, generated with:
    //   php -r "echo password_hash('your-password', PASSWORD_DEFAULT), PHP_EOL;"
    // If set, it takes precedence over admin_password.
    'admin_password_hash' => '',

    // Database. Leave 'dsn' empty to use SQLite in data/h2h.sqlite (recommended:
    // nothing to set up, the data/ folder only has to be writable).
    // For MySQL (e.g. if your host has no SQLite) use something like:
    //   'dsn' => 'mysql:host=localhost;dbname=my_db;charset=utf8mb4',
    'db' => [
        'dsn' => '',
        'user' => null,
        'password' => null,
    ],

    // Show real error messages in API responses (only while debugging).
    'debug' => false,
];
