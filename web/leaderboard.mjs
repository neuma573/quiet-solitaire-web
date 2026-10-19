/* Web-owned guest profile and leaderboard overlay. No game save/auth data is stored here. */
export class LeaderboardError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'LeaderboardError'; this.status = status; }
}

export function normalizeApiBase(value, location = globalThis.location) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const url = new URL(value, location?.href ?? 'https://localhost/');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('HTTPS API required');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid API URL');
  return url.href.replace(/\/$/, '');
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

export function validMode(mode) {
  return !!mode && typeof mode === 'object' && !Array.isArray(mode)
    && ['casual', 'normal', 'challenge'].includes(mode.difficulty)
    && [1, 3].includes(mode.draw) && ['standard', 'vegas'].includes(mode.scoring);
}
const modeKey = mode => `${mode.difficulty}:${mode.draw}:${mode.scoring}`;
const validAttempt = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validResult = event => event.won === true && integer(event.score, 0, 1_522_580)
  && integer(event.elapsedMs, 1000, 86_400_000) && event.elapsedMs % 1000 === 0 && integer(event.moves, 1, 100_000);
const copyProfile = user => user && typeof user.id === 'string' && typeof user.nickname === 'string'
  && integer(user.xp, 0, Number.MAX_SAFE_INTEGER) ? { id: user.id, nickname: user.nickname, xp: user.xp } : null;

export function createLeaderboardClient({ apiBase, fetchImpl = globalThis.fetch, location = globalThis.location } = {}) {
  const base = normalizeApiBase(apiBase, location);
  let csrfToken = '';
  async function request(path, { method = 'GET', body, idempotencyKey } = {}) {
    if (!base) throw new LeaderboardError('공유 리더보드 서버가 아직 연결되지 않았습니다.');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await fetchImpl(base + path, { method, headers, credentials: 'include', cache: 'no-store',
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
    board: () => request('/v1/leaderboard?limit=25'),
  };
}

export class LeaderboardService {
  constructor(client, { randomUUID = () => globalThis.crypto.randomUUID(), onChange = () => {} } = {}) {
    this.client = client; this.randomUUID = randomUUID; this.onChange = onChange;
    this.profile = null; this.participating = false; this.active = null; this.pending = new Map();
    this.seen = new Set(); this.epoch = 0; this.boardGeneration = 0; this.disposed = false;
    this.state = { enabled: client.enabled, busy: false, loadingBoard: false, entries: [], message: '', error: '', pendingCount: 0 };
  }
  snapshot() { return { ...this.state, profile: this.profile && { ...this.profile }, participating: this.participating }; }
  changed() { if (!this.disposed) { this.state.pendingCount = this.pending.size; this.onChange(this.snapshot()); } }
  setProfile(user, kind = 'session') {
    const profile = copyProfile(user);
    if (!profile) throw new LeaderboardError('게스트 정보를 읽을 수 없습니다.');
    if (kind !== 'session' && this.profile) {
      if (this.profile.id !== profile.id) throw new LeaderboardError('게스트 연결이 변경되었습니다. 다시 참여해 주세요.');
      profile.xp = Math.max(this.profile.xp, profile.xp);
      // A result response can predate a successful nickname edit, and XP responses can arrive out of order.
      if (kind === 'result') profile.nickname = this.profile.nickname;
    }
    this.profile = profile;
  }
  async join() {
    if (this.state.busy || !this.client.enabled) return;
    const epoch = ++this.epoch;
    this.boardGeneration++; this.state.loadingBoard = false;
    this.state.busy = true; this.state.error = ''; this.changed();
    try {
      const data = await this.client.session();
      if (this.disposed || this.epoch !== epoch) return;
      this.setProfile(data.user); this.participating = true;
      this.state.message = '참여 중입니다. 지금부터 새로 시작한 게임의 승리 XP만 반영됩니다.';
    } catch (error) { if (this.epoch === epoch) this.state.error = error.message; }
    finally { if (this.epoch === epoch) { this.state.busy = false; this.changed(); } }
  }
  leave() {
    this.epoch++; this.boardGeneration++; this.state.loadingBoard = false;
    this.participating = false; this.active = null; this.pending.clear();
    this.state.busy = false; this.state.error = ''; this.state.message = '참여를 중지했습니다. 다시 참여하면 다음 새 게임부터 반영됩니다.';
    this.changed();
  }
  async rename(value) {
    if (!this.profile || this.state.busy) return;
    const nickname = normalizeNickname(value); const epoch = this.epoch;
    this.state.busy = true; this.state.error = ''; this.changed();
    try {
      const data = await this.client.rename(nickname);
      if (this.epoch !== epoch || this.disposed) return;
      this.setProfile(data.user, 'rename'); this.state.message = '닉네임을 저장했습니다. 고유 ID와 XP는 유지됩니다.';
      await this.refreshBoard();
    } catch (error) { if (this.epoch === epoch) this.state.error = error.message; }
    finally { if (this.epoch === epoch) { this.state.busy = false; this.changed(); } }
  }
  async remove() {
    if (!this.profile || this.state.busy) return;
    // Stop accepting new results before the asynchronous deletion begins.
    this.leave(); const epoch = this.epoch; this.state.busy = true; this.changed();
    try {
      await this.client.remove();
      if (this.epoch !== epoch || this.disposed) return;
      this.profile = null; this.state.entries = []; this.state.message = '게스트와 공유 순위 기록을 삭제했습니다.';
      await this.refreshBoard();
    } catch (error) { if (this.epoch === epoch) this.state.error = error.message; }
    finally { if (this.epoch === epoch) { this.state.busy = false; this.changed(); } }
  }
  async refreshBoard() {
    if (!this.client.enabled || this.disposed) return;
    const generation = ++this.boardGeneration; const epoch = this.epoch;
    this.state.loadingBoard = true; this.state.error = ''; this.changed();
    try {
      const data = await this.client.board();
      if (generation !== this.boardGeneration || epoch !== this.epoch || this.disposed) return;
      if (data.metric !== 'cumulative-xp' || data.verification !== 'client-reported' || !Array.isArray(data.entries)) {
        throw new LeaderboardError('호환되지 않는 리더보드 응답입니다.');
      }
      this.state.entries = data.entries.slice(0, 25).filter(row => integer(row.rank, 1, Number.MAX_SAFE_INTEGER)
        && typeof row.nickname === 'string' && integer(row.xp, 0, Number.MAX_SAFE_INTEGER))
        .map(row => ({ rank: row.rank, nickname: row.nickname, xp: row.xp, isMe: row.isMe === true }));
    } catch (error) { if (generation === this.boardGeneration && epoch === this.epoch) this.state.error = error.message; }
    finally {
      if (generation === this.boardGeneration && epoch === this.epoch) { this.state.loadingBoard = false; this.changed(); }
    }
  }
  async event(input) {
    let event;
    try { event = typeof input === 'string' ? JSON.parse(input) : input; } catch { return; }
    if (!event || typeof event !== 'object' || !this.participating || !this.profile || this.disposed) return;
    if (event.type === 'cancelled') {
      if (this.active?.attemptId === event.attemptId) this.active = null;
      return;
    }
    if (!validAttempt(event.attemptId) || !validMode(event.mode)) return;
    if (event.type === 'started') {
      if (this.seen.has(event.attemptId)) return;
      // Fail closed on a resumed/repeated attempt; this tab must observe its new start.
      if (this.seen.size >= 1000) { this.leave(); this.state.error = '페이지를 새로고침한 뒤 다시 참여해 주세요.'; this.changed(); return; }
      this.seen.add(event.attemptId);
      const active = { attemptId: event.attemptId, mode: { difficulty: event.mode.difficulty, draw: event.mode.draw,
        scoring: event.mode.scoring }, run: null, epoch: this.epoch };
      this.active = active;
      try {
        const data = await this.client.startRun(active.mode);
        if (this.active !== active || active.epoch !== this.epoch || !this.participating) return;
        if (!data?.run || typeof data.run.id !== 'string' || !validMode(data.run.mode)
          || modeKey(data.run.mode) !== modeKey(active.mode)) throw new LeaderboardError('게임 참여 정보를 확인할 수 없습니다.');
        active.run = data.run;
      } catch (error) {
        if (this.active === active) { this.active = null; this.state.error = error.message; this.changed(); }
      }
      return;
    }
    if (event.type !== 'completed') return;
    const prior = this.pending.get(event.attemptId);
    if (prior) return this.submit(prior);
    const active = this.active;
    if (!active || active.attemptId !== event.attemptId || modeKey(active.mode) !== modeKey(event.mode)) return;
    this.active = null;
    if (!validResult(event)) { this.state.error = '게임 결과가 올바르지 않아 전송하지 않았습니다.'; this.changed(); return; }
    if (!active.run) {
      this.state.error = '게임 시작 연결이 완료되지 않아 이 결과를 반영하지 못했습니다. 다음 새 게임부터 다시 시도합니다.';
      this.changed(); return;
    }
    const record = { attemptId: active.attemptId, runId: active.run.id, epoch: active.epoch, key: this.randomUUID(),
      result: { score: event.score, elapsedMs: event.elapsedMs, moves: event.moves, won: true }, inFlight: null };
    this.pending.set(record.attemptId, record);
    return this.submit(record);
  }
  async submit(record) {
    if (record.inFlight) return record.inFlight;
    if (record.epoch !== this.epoch || !this.participating || this.disposed) return;
    record.inFlight = (async () => {
      try {
        const data = await this.client.finishRun(record.runId, record.result, record.key);
        if (record.epoch !== this.epoch || this.disposed) return;
        this.setProfile(data.user, 'result'); this.pending.delete(record.attemptId);
        this.state.error = ''; this.state.message = '승리 XP를 반영했습니다.';
        await this.refreshBoard();
      } catch (error) {
        if (record.epoch !== this.epoch || this.disposed) return;
        if (error.status >= 400 && error.status < 500 && error.status !== 429) this.pending.delete(record.attemptId);
        this.state.error = error.message;
      } finally { record.inFlight = null; this.changed(); }
    })();
    this.changed();
    return record.inFlight;
  }
  async retryPending() { for (const record of this.pending.values()) await this.submit(record); }
  dispose() { this.leave(); this.disposed = true; }
}

function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function mountLeaderboard({ document = globalThis.document, window = globalThis.window, client,
  parent = document.getElementById('phone') ?? document.body } = {}) {
  const root = element(document, 'div', undefined, 'ql-root');
  const launcher = element(document, 'button', '순위 · 마이페이지', 'ql-launcher');
  launcher.type = 'button'; launcher.setAttribute('aria-haspopup', 'dialog');
  const dialog = element(document, 'dialog', undefined, 'ql-dialog');
  dialog.setAttribute('aria-labelledby', 'ql-title'); dialog.lang = 'ko';
  const heading = element(document, 'div', undefined, 'ql-heading');
  const title = element(document, 'h2', '리더보드', 'ql-title'); title.id = 'ql-title';
  const close = element(document, 'button', '닫기', 'ql-close'); close.type = 'button';
  heading.append(title, close);
  const disabled = element(document, 'p', '공유 리더보드 서버가 아직 연결되지 않았습니다. 연결 후 이용할 수 있습니다.', 'ql-note');
  const warning = element(document, 'p', '누적 XP 순위 · 클라이언트 신고 기록으로, 검증된 경쟁 순위는 아닙니다.', 'ql-note');
  const message = element(document, 'p', '', 'ql-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const error = element(document, 'p', '', 'ql-error'); error.setAttribute('role', 'alert');
  const profileSection = element(document, 'section', undefined, 'ql-profile');
  const profileTitle = element(document, 'h3', '마이페이지');
  const intro = element(document, 'p', '참여하면 자동 랜덤 닉네임과 고유 ID가 생성됩니다. 이후 새로 시작한 게임의 승리 XP와 닉네임이 공유 순위에 반영됩니다.', 'ql-note');
  const privacy = element(document, 'p', '이 브라우저의 쿠키로 게스트를 기억합니다. 쿠키 삭제·다른 기기에서는 복구할 수 없습니다. 로그인 복구 기능은 없습니다.', 'ql-note');
  const join = element(document, 'button', '동의하고 참여', 'ql-primary'); join.type = 'button';
  const leave = element(document, 'button', '참여 중지'); leave.type = 'button';
  const identity = element(document, 'p', '', 'ql-identity');
  const form = element(document, 'form', undefined, 'ql-name-form');
  const label = element(document, 'label', '닉네임'); label.htmlFor = 'ql-nickname';
  const input = element(document, 'input'); input.id = 'ql-nickname'; input.name = 'nickname'; input.type = 'text';
  input.autocomplete = 'nickname'; input.required = true; input.maxLength = 40;
  input.setAttribute('aria-describedby', 'ql-name-hint');
  const nameHint = element(document, 'p', '2~20자 · 글자, 숫자, 공백, _ 또는 -', 'ql-note'); nameHint.id = 'ql-name-hint';
  const save = element(document, 'button', '닉네임 저장'); save.type = 'submit';
  form.append(label, input, nameHint, save);
  const remove = element(document, 'button', '게스트와 순위 기록 삭제', 'ql-danger'); remove.type = 'button';
  const confirmDelete = element(document, 'div', undefined, 'ql-delete-confirm'); confirmDelete.hidden = true;
  const deleteNote = element(document, 'p', '이 게스트의 닉네임·XP·공유 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다.');
  const confirmButton = element(document, 'button', '삭제하기', 'ql-danger'); confirmButton.type = 'button';
  const cancelDelete = element(document, 'button', '취소'); cancelDelete.type = 'button';
  confirmDelete.append(deleteNote, confirmButton, cancelDelete);
  profileSection.append(profileTitle, intro, privacy, identity, form, join, leave, remove, confirmDelete);
  const boardSection = element(document, 'section', undefined, 'ql-board');
  const boardHeading = element(document, 'div', undefined, 'ql-heading');
  const boardTitle = element(document, 'h3', '누적 XP 순위');
  const refresh = element(document, 'button', '새로고침'); refresh.type = 'button';
  boardHeading.append(boardTitle, refresh);
  const table = element(document, 'table'); const caption = element(document, 'caption', '누적 XP 상위 25명'); caption.className = 'ql-sr-only';
  const head = element(document, 'thead'); const headers = element(document, 'tr');
  for (const text of ['순위', '닉네임', 'XP']) { const th = element(document, 'th', text); th.scope = 'col'; headers.append(th); }
  head.append(headers); const body = element(document, 'tbody'); table.append(caption, head, body);
  const empty = element(document, 'p', '아직 등록된 기록이 없습니다.', 'ql-note');
  const retry = element(document, 'button', '기록 전송 다시 시도'); retry.type = 'button';
  boardSection.append(boardHeading, table, empty, retry);
  dialog.append(heading, disabled, warning, message, error, boardSection, profileSection);
  root.append(launcher, dialog); parent.append(root);
  let previousFocus = null;
  const service = new LeaderboardService(client, { onChange(state) {
    root.dataset.enabled = String(state.enabled);
    disabled.hidden = state.enabled; warning.hidden = !state.enabled;
    profileSection.hidden = !state.enabled; boardSection.hidden = !state.enabled;
    message.textContent = state.message; message.hidden = !state.message;
    error.textContent = state.error; error.hidden = !state.error;
    const profile = state.profile;
    identity.hidden = !profile; form.hidden = !profile; remove.hidden = !profile;
    if (profile) {
      identity.textContent = `고유 ID: ${profile.id} · 누적 XP: ${profile.xp.toLocaleString('ko-KR')}`;
      if (document.activeElement !== input) input.value = profile.nickname;
    } else confirmDelete.hidden = true;
    join.hidden = state.participating; join.textContent = profile ? '새 게임부터 다시 참여' : '동의하고 참여';
    join.disabled = state.busy; leave.hidden = !state.participating; save.disabled = state.busy;
    remove.disabled = state.busy; confirmButton.disabled = state.busy; refresh.disabled = state.loadingBoard;
    retry.hidden = !state.pendingCount; retry.disabled = state.busy;
    const rows = state.entries.map(entry => {
      const row = element(document, 'tr'); if (entry.isMe) row.className = 'ql-me';
      const nickname = entry.nickname + (entry.isMe ? ' (나)' : '');
      row.append(element(document, 'td', String(entry.rank)), element(document, 'td', nickname),
        element(document, 'td', entry.xp.toLocaleString('ko-KR'))); return row;
    });
    body.replaceChildren(...rows); empty.hidden = rows.length > 0;
    empty.textContent = state.loadingBoard ? '순위를 불러오는 중입니다…' : '아직 등록된 기록이 없습니다.';
    window.dispatchEvent(new window.CustomEvent('quiet-leaderboard-profile', { detail: profile && { ...profile } }));
  } });
  function open(profileFocus = false) {
    if (!dialog.open) { previousFocus = document.activeElement; dialog.showModal(); close.focus(); }
    if (profileFocus !== true) dialog.scrollTop = 0;
    if (profileFocus && client.enabled) {
      profileSection.scrollIntoView({ block: 'start' });
      if (service.profile) input.focus(); else join.focus();
    }
    void service.refreshBoard();
  }
  function dismiss() { if (dialog.open) dialog.close(); }
  const guarded = fn => async event => {
    event?.preventDefault();
    try { await fn(); } catch (caught) { service.state.error = caught.message; service.changed(); }
  };
  launcher.addEventListener('click', () => open()); close.addEventListener('click', dismiss);
  dialog.addEventListener('close', () => { confirmDelete.hidden = true; previousFocus?.focus?.(); });
  join.addEventListener('click', guarded(() => service.join())); leave.addEventListener('click', () => service.leave());
  form.addEventListener('submit', guarded(() => service.rename(input.value)));
  refresh.addEventListener('click', guarded(() => service.refreshBoard()));
  retry.addEventListener('click', guarded(() => service.retryPending()));
  remove.addEventListener('click', () => { confirmDelete.hidden = false; confirmButton.focus(); });
  cancelDelete.addEventListener('click', () => { confirmDelete.hidden = true; remove.focus(); });
  confirmButton.addEventListener('click', guarded(async () => { await service.remove(); confirmDelete.hidden = true; }));
  const bridge = {
    emit(raw) {
      let event;
      try { event = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      if (event?.type === 'my-page') { open(true); return; }
      void service.event(event).catch(() => { service.state.error = '게임 기록을 처리하지 못했습니다.'; service.changed(); });
    },
    profile: () => service.profile && { ...service.profile },
  };
  window.QuietLeaderboardBridge = bridge;
  const eventListener = event => bridge.emit(event.detail);
  // A restored back/forward-cache page must opt in again and cannot resume an old run.
  const pagehide = () => service.leave();
  window.addEventListener('quiet-leaderboard', eventListener);
  window.addEventListener('pagehide', pagehide);
  service.changed();
  return { service, open, destroy() {
    service.dispose(); root.remove(); window.removeEventListener('quiet-leaderboard', eventListener);
    window.removeEventListener('pagehide', pagehide);
    if (window.QuietLeaderboardBridge === bridge) delete window.QuietLeaderboardBridge;
  } };
}

export async function bootLeaderboard({ document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch } = {}) {
  let apiBase = '';
  try {
    const response = await fetchImpl(new URL('leaderboard-config.json', document.baseURI), { cache: 'no-store', credentials: 'same-origin' });
    if (response.ok) apiBase = (await response.json()).apiBase ?? '';
    apiBase = normalizeApiBase(apiBase, window.location);
  } catch { apiBase = ''; /* Missing/invalid public config keeps the shared feature disabled. */ }
  return mountLeaderboard({ document, window, client: createLeaderboardClient({ apiBase, fetchImpl, location: window.location }) });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') void bootLeaderboard();
