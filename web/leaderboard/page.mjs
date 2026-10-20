import { createLeaderboardClient, normalizeApiBase } from '../leaderboard-api.mjs';

// Do not invent, silently omit, sort, or renumber malformed server results.
// The Worker owns rank and the deterministic ordering of equal-XP entries.
export function readEntries(data) {
  if (data?.metric !== 'cumulative-xp' || data.verification !== 'client-reported'
      || !Array.isArray(data.entries) || data.entries.length > 25) throw new Error('Invalid leaderboard');
  let previousXp = Number.MAX_SAFE_INTEGER;
  return data.entries.map((row, index) => {
    if (!row || row.rank !== index + 1 || typeof row.nickname !== 'string' || !row.nickname.trim()
        || row.nickname.length > 200 || !Number.isSafeInteger(row.xp) || row.xp <= 0
        || row.xp > previousXp) throw new Error('Invalid leaderboard entry');
    previousXp = row.xp;
    return { rank: row.rank, nickname: row.nickname, xp: row.xp, isMe: row.isMe === true };
  });
}

export function mountPage({ document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const get = id => document.getElementById(id);
  const refresh = get('refresh'), content = get('board-content'), status = get('board-status');
  const title = get('state-title'), description = get('state-description'), error = get('board-error');
  const table = get('rankings'), rows = get('ranking-rows'), summary = get('board-summary');
  // Resolve relative API config from the game root, not the nested page.
  const configUrl = new URL('../leaderboard-config.json', document.baseURI);
  let current = null;
  let disposed = false;
  function state(kind, heading, detail) {
    content.dataset.state = kind; content.setAttribute('aria-busy', String(kind === 'loading'));
    status.hidden = kind === 'ready'; title.textContent = heading; description.textContent = detail;
    table.hidden = kind !== 'ready';
    // Native disabled blurs the active button in Chromium. Keep the loading
    // control focusable; the current-request guard suppresses repeat activation.
    refresh.disabled = kind === 'disabled';
    refresh.setAttribute('aria-disabled', String(kind === 'loading' || kind === 'disabled'));
    refresh.textContent = kind === 'error' ? '다시 시도' : '새로고침';
  }
  async function load() {
    if (current || disposed) return;
    const controller = new AbortController(); current = controller;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    error.hidden = true; error.textContent = ''; rows.replaceChildren();
    summary.textContent = 'XP가 높은 순으로 표시합니다.';
    state('loading', '순위를 불러오는 중입니다…', '잠시만 기다려 주세요.');
    try {
      const response = await fetchImpl(configUrl, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Configuration unavailable');
      const config = await response.json();
      if (!config || typeof config.apiBase !== 'string') throw new Error('Invalid configuration');
      const apiBase = normalizeApiBase(config.apiBase, { href: configUrl.href });
      if (disposed || current !== controller) return;
      if (!apiBase) {
        state('disabled', '리더보드를 준비하고 있어요', '공유 순위 서버가 아직 연결되지 않았습니다. 연결 후 이곳에서 기록을 확인할 수 있어요.');
        return;
      }
      const client = createLeaderboardClient({ apiBase, fetchImpl });
      const entries = readEntries(await client.board({ signal: controller.signal }));
      if (disposed || current !== controller) return;
      if (!entries.length) {
        state('empty', '아직 등록된 기록이 없어요', '게임에서 리더보드에 참여하고 첫 승리의 XP를 남겨 보세요.');
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('tr'); row.dataset.rank = String(entry.rank);
        if (entry.isMe) row.className = 'is-me';
        for (const value of [entry.rank, entry.nickname, entry.xp.toLocaleString('ko-KR')]) {
          const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
        }
        if (entry.isMe) {
          const badge = document.createElement('span'); badge.className = 'me-label'; badge.textContent = '나';
          row.children[1].append(badge);
        }
        rows.append(row);
      }
      summary.textContent = `상위 ${entries.length}명 · 누적 XP 높은 순`;
      state('ready', '', '');
    } catch {
      if (disposed || current !== controller) return;
      state('error', '순위를 불러오지 못했어요', '잠시 후 다시 시도해 주세요.');
      error.textContent = controller.signal.aborted
        ? '서버 응답이 늦어지고 있습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
        : '연결 또는 서버 응답을 확인할 수 없습니다. 인터넷 연결을 확인하거나 잠시 후 다시 시도해 주세요.';
      error.hidden = false;
    } finally {
      window.clearTimeout(timeout);
      if (current === controller) current = null;
    }
  }
  const pagehide = () => { current?.abort(); current = null; };
  const pageshow = event => { if (event.persisted) void load(); };
  refresh.addEventListener('click', load);
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  void load();
  return { load, destroy() {
    disposed = true; pagehide(); refresh.removeEventListener('click', load);
    window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow);
  } };
}

if (typeof document !== 'undefined' && document.getElementById('ranking-rows')) mountPage();
