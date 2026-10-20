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

export function createLeaderboardClient({ apiBase, fetchImpl = globalThis.fetch, location = globalThis.location,
  locks = globalThis.navigator?.locks } = {}) {
  const base = normalizeApiBase(apiBase, location);
  let csrfToken = '';
  let sessionFlight = null;
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
      const messages = { 400: '입력값이나 게임 기록을 확인해 주세요.', 401: '게스트 연결이 만료되었습니다. 페이지를 새로고침해 주세요.',
        403: '게스트 연결을 확인할 수 없습니다. 페이지를 새로고침해 주세요.', 409: '이 게임 기록은 이미 처리되었거나 만료되었습니다.',
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
  async function withGuestLock(action) {
    // Serialize cookie-changing requests across same-origin tabs. Without
    // Web Locks keep the game/read-only board usable, but do not race creates.
    if (!locks?.request) throw new LeaderboardError('이 브라우저에서 게스트를 연결할 수 없습니다. 최신 브라우저로 다시 시도해 주세요.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await locks.request(`quiet-guest:${base}`, { mode: 'exclusive', signal: controller.signal },
        () => action(controller.signal));
    } catch (error) {
      if (error instanceof LeaderboardError) throw error;
      throw new LeaderboardError('게스트 연결을 완료하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally { clearTimeout(timeout); }
  }
  async function session() {
    if (!sessionFlight) {
      sessionFlight = withGuestLock(async signal => {
        const created = await request('/v1/session', { method: 'POST', body: {}, signal });
        // A blocked cookie must not look connected or trigger silent repeated
        // guest creation. Read the cookie-owned identity before accepting it.
        const restored = await request('/v1/me', { signal });
        if (!created.user?.id || restored.user?.id !== created.user.id) throw new LeaderboardError('게스트 연결을 확인할 수 없습니다. 다시 시도해 주세요.');
        return restored;
      });
    }
    const pending = sessionFlight;
    try { return await pending; }
    finally { if (sessionFlight === pending) sessionFlight = null; }
  }
  return {
    enabled: !!base,
    session,
    me: () => request('/v1/me'),
    rename: nickname => request('/v1/me', { method: 'PATCH', body: { nickname: normalizeNickname(nickname) } }),
    remove: () => withGuestLock(async signal => {
      const result = await request('/v1/me', { method: 'DELETE', signal }); csrfToken = ''; return result;
    }),
    startRun: mode => request('/v1/runs', { method: 'POST', body: { mode } }),
    finishRun: (id, result, key) => request(`/v1/runs/${encodeURIComponent(id)}/result`, {
      method: 'POST', body: result, idempotencyKey: key }),
    board: ({ signal } = {}) => request('/v1/leaderboard?limit=25', { signal }),
  };
}
