const SOURCE = 'neuma573/quiet-solitaire';
const SOURCE_ID = 1400879584;
const TARGET = 'neuma573/quiet-solitaire-web';
const MAX_BODY = 2 * 1024 * 1024;
const text = (body, status) => new Response(body, { status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function handle(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  const ready = Boolean(env.WEBHOOK_SECRET && env.GITHUB_DISPATCH_TOKEN);
  if (request.method === 'GET' && path === '/health') return text(ready ? 'Ready' : 'Not ready', ready ? 200 : 503);
  if (path !== '/github') return text('Not found', 404);
  if (request.method !== 'POST') return text('Method not allowed', 405);
  if (!ready) return text('Not ready', 503);
  const signature = request.headers.get('X-Hub-Signature-256') || '';
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return text('Unauthorized', 401);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return text('Payload too large', 413);
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) return text('Bad request', 400);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return text('Payload too large', 413); }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/.{2}/g), (part) => Number.parseInt(part, 16));
  if (!await crypto.subtle.verify('HMAC', key, bytes, raw)) return text('Unauthorized', 401);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return text('Bad request', 400); }
  if (payload?.repository?.id !== SOURCE_ID || payload.repository.full_name !== SOURCE || payload.repository.private !== true) {
    return text('Forbidden', 403);
  }
  const event = request.headers.get('X-GitHub-Event');
  if (event === 'ping') return text('OK', 200);
  const pr = payload.pull_request;
  if (event !== 'pull_request' || payload.action !== 'closed' || pr?.merged !== true || pr.base?.ref !== 'main') {
    return text('Ignored', 202);
  }
  const sha = pr.merge_commit_sha;
  if (pr.base.repo?.id !== SOURCE_ID || !/^[0-9a-f]{40}$/.test(sha || '') || sha === '0'.repeat(40)) {
    return text('Bad request', 400);
  }
  const delivery = request.headers.get('X-GitHub-Delivery');
  if (!/^[0-9a-f-]{36}$/i.test(delivery || '')) return text('Bad request', 400);
  let response;
  try {
    response = await fetcher(`https://api.github.com/repos/${TARGET}/dispatches`, {
      method: 'POST', headers: { 'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, 'User-Agent': 'quiet-web-merge-relay',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'source-main-merged', client_payload: {
        source_repository: SOURCE, source_ref: 'refs/heads/main', source_sha: sha, delivery_id: delivery } }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch { return text('Dispatch failed', 502); }
  return response.status === 204 ? text('Dispatched', 202) : text('Dispatch failed', 502);
}

export default { fetch: (request, env) => handle(request, env) };
