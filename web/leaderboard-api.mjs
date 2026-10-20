/* Shared API client. Importing this module never mounts UI or creates a guest. */
export class LeaderboardError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'LeaderboardError'; this.status = status; }
}

export function normalizeApiBase(value, location = globalThis.location) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const url = new URL(value, location?.href ?? 'https://localhost/');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('HTTPS API required');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid API URL');
  return url.href.replace(/\/+$/, '');
}

export function normalizeNickname(value) {
  if (typeof value !== 'string' || value.length > 200) throw new LeaderboardError('닉네임을 확인해 주세요.');
  const nickname = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  if ([...nickname].length < 2 || [...nickname].length > 20 || !/^[\p{L}\p{M}\p{N} _-]+$/u.test(nickname)
    || !/[\p{L}\p{N}]/u.test(nickname)) {
    throw new LeaderboardError('닉네임은 2~20자의 글자, 숫자, 공백, _ 또는 -로 입력해 주세요.');
  }
  return nickname;
}

export function createLeaderboardClient({ apiBase, fetchImpl = globalThis.fetch, location = globalThis.location } = {}) {
  const base = normalizeApiBase(apiBase, location);
  let csrfToken = '';
  async function request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    if (!base) throw new LeaderboardError('공유 리더보드 서버가 아직 연결되지 않았습니다.');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await fetchImpl(base + path, { method, headers, credentials: 'include', cache: 'no-store', signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new LeaderboardError('연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'); }
    if (!response.ok) {
      const messages = { 400: '입력값이나 게임 기록을 확인해 주세요.', 401: '게스트 연결이 만료되었습니다. 다시 참여해 주세요.',
        403: '게스트 연결을 확인할 수 없습니다. 다시 참여해 주세요.', 409: '이 게임 기록은 이미 처리되었거나 만료되었습니다.',
        410: '이 게임 기록은 만료되었습니다.', 429: '요청이 많습니다. 잠시 뒤 다시 시도해 주세요.' };
      // Never render arbitrary server/proxy error text, which may contain operational details.
      throw new LeaderboardError(messages[response.status] ?? '서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', response.status);
    }
    if (response.status === 204) return null;
    let data;
    try { data = await response.json(); } catch { throw new LeaderboardError('서버 응답을 읽을 수 없습니다.'); }
    if (typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
    return data;
  }
  return {
    enabled: !!base,
    session: () => request('/v1/session', { method: 'POST', body: {} }),
    me: () => request('/v1/me'),
    rename: nickname => request('/v1/me', { method: 'PATCH', body: { nickname: normalizeNickname(nickname) } }),
    remove: async () => { const result = await request('/v1/me', { method: 'DELETE' }); csrfToken = ''; return result; },
    startRun: mode => request('/v1/runs', { method: 'POST', body: { mode } }),
    finishRun: (id, result, key) => request(`/v1/runs/${encodeURIComponent(id)}/result`, {
      method: 'POST', body: result, idempotencyKey: key }),
    board: ({ signal } = {}) => request('/v1/leaderboard?limit=25', { signal }),
  };
}
