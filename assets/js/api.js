// Thin client for api.php (or the Node dev server, which speaks the same API).

const ENDPOINT = 'api.php';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(action, body) {
  const post = body !== undefined;
  let res;
  try {
    res = await fetch(`${ENDPOINT}?action=${encodeURIComponent(action)}`, {
      method: post ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: post ? { 'Content-Type': 'application/json', 'X-H2H': '1' } : {},
      body: post ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON: PHP isn't running (e.g. the page was opened as a file or from
    // a static server). Locally, use `npm run dev` instead.
  }
  if (!data) throw new ApiError(`The server did not answer with data (HTTP ${res.status}). Is PHP enabled?`, res.status);
  if (!res.ok) throw new ApiError(data.error || `Request failed (HTTP ${res.status}).`, res.status);
  return data;
}

export const api = {
  load: () => request('data'),
  login: (password) => request('login', { password }),
  logout: () => request('logout', {}),
  savePlayer: (player) => request('player.save', player),
  deletePlayer: (id) => request('player.delete', { id }),
  saveMatch: (match) => request('match.save', match),
  deleteMatch: (id) => request('match.delete', { id }),
  exportUrl: `${ENDPOINT}?action=export`,
};
