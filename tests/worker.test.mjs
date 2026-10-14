import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handle } from '../worker/index.mjs';

const env = { WEBHOOK_SECRET: 'test-secret', GITHUB_DISPATCH_TOKEN: 'test-token' };
const sha = 'a'.repeat(40);
const delivery = '00000000-0000-4000-8000-000000000000';
const repo = { id: 1400879584, full_name: 'neuma573/quiet-solitare', private: true };
const merged = { repository: repo, action: 'closed', pull_request: {
  merged: true, merge_commit_sha: sha, base: { ref: 'main', repo } } };
function request(payload, event = 'pull_request', secret = env.WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return new Request('https://relay.example/github', { method: 'POST', body, headers: {
    'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery,
    'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });
}
const noDispatch = async () => { assert.fail('Ignored or unauthenticated event must not dispatch'); };

test('signed main merge dispatches only exact merge SHA and public target', async () => {
  let calls = 0;
  const response = await handle(request(merged), env, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/neuma573/quiet-solitaire-web/dispatches');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body), { event_type: 'source-main-merged', client_payload: {
      source_repository: repo.full_name, source_ref: 'refs/heads/main', source_sha: sha, delivery_id: delivery } });
    return new Response(null, { status: 204 });
  });
  assert.equal(response.status, 202);
  assert.equal(calls, 1);
});
test('missing or incorrect raw-body signature never dispatches', async () => {
  const missing = request(merged); missing.headers.delete('X-Hub-Signature-256');
  assert.equal((await handle(missing, env, noDispatch)).status, 401);
  assert.equal((await handle(request(merged, 'pull_request', 'wrong'), env, noDispatch)).status, 401);
  const changed = request(merged); changed.headers.set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64));
  assert.equal((await handle(changed, env, noDispatch)).status, 401);
});
test('ping works but push, unmerged closure and non-main merge do not dispatch', async () => {
  assert.equal((await handle(request({ repository: repo }, 'ping'), env, noDispatch)).status, 200);
  for (const [payload, event] of [
    [merged, 'push'], [{ ...merged, action: 'opened' }, 'pull_request'],
    [{ ...merged, pull_request: { ...merged.pull_request, merged: false } }, 'pull_request'],
    [{ ...merged, pull_request: { ...merged.pull_request, base: { ref: 'feature', repo } } }, 'pull_request']
  ]) assert.equal((await handle(request(payload, event), env, noDispatch)).status, 202);
});
test('other repository and invalid merge SHA never dispatch', async () => {
  assert.equal((await handle(request({ ...merged, repository: { ...repo, id: 1 } }), env, noDispatch)).status, 403);
  for (const value of ['main', '0'.repeat(40), null]) {
    assert.equal((await handle(request({ ...merged, pull_request: { ...merged.pull_request, merge_commit_sha: value } }), env, noDispatch)).status, 400);
  }
});
test('missing configuration and GitHub rejection fail closed without leaking details', async () => {
  assert.equal((await handle(request(merged), {}, noDispatch)).status, 503);
  const result = await handle(request(merged), env, async () => new Response('private error', { status: 401 }));
  assert.equal(result.status, 502);
  assert.equal(await result.text(), 'Dispatch failed');
});
