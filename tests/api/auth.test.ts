import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, type TestApp, TEST_TODAY } from '../helpers/server.js';

describe('API: meta & auth', () => {
  let app: TestApp;
  before(async () => { app = await launch(); });
  after(async () => { await app.close(); });

  test('GET /api/meta is public and reports the frozen clock', async () => {
    const res = await app.get('/api/meta');
    assert.equal(res.status, 200);
    assert.equal(res.body.today, TEST_TODAY);
    assert.equal(res.body.clockFrozen, true);
  });

  test('serves the SPA shell for / and unknown non-API paths', async () => {
    const root = await app.get('/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') || '', /text\/html/);
    assert.match(String(root.body), /<title>FinFolio/);
    const deep = await app.get('/some/spa/route');
    assert.equal(deep.status, 200);
    assert.match(String(deep.body), /<title>FinFolio/);
    const js = await app.get('/js/api.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
  });

  test('register → login round-trip', async () => {
    const reg = await app.post('/api/auth/register', { username: 'alice', password: 'secret' });
    assert.equal(reg.status, 200);
    assert.ok(reg.body.token);
    assert.equal(reg.body.user.username, 'alice');

    const dup = await app.post('/api/auth/register', { username: 'alice', password: 'x' });
    assert.equal(dup.status, 409);

    const bad = await app.post('/api/auth/login', { username: 'alice', password: 'nope' });
    assert.equal(bad.status, 401);

    const ok = await app.post('/api/auth/login', { username: 'alice', password: 'secret' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, reg.body.user.id);
  });

  test('validation errors on auth', async () => {
    assert.equal((await app.post('/api/auth/register', { username: 'x' })).status, 400);
    assert.equal((await app.post('/api/auth/login', {})).status, 400);
    assert.equal((await app.post('/api/auth/login')).status, 400);
  });

  test('protected routes require a valid bearer token', async () => {
    assert.equal((await app.get('/api/dashboard')).status, 401);
    assert.equal((await app.get('/api/dashboard', 'bogus-token')).status, 401);
    const { token } = await app.register('bob', 'pw');
    assert.equal((await app.get('/api/dashboard', token)).status, 200);
  });

  test('unknown API routes return 404 JSON', async () => {
    const res = await app.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
  });

  test('CORS preflight', async () => {
    const res = await app.request('OPTIONS', '/api/accounts');
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('users cannot see each other\'s list data', async () => {
    const a = await app.register('carol', 'pw');
    const b = await app.register('dan', 'pw');
    await app.post('/api/accounts', { name: 'Carol Main', type: 'checking', balance: 10 }, a.token);
    const mine = await app.get('/api/accounts', a.token);
    const theirs = await app.get('/api/accounts', b.token);
    assert.equal(mine.body.length, 1);
    assert.equal(theirs.body.length, 0);
  });
});
