import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { server } from '../src/server.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
let base;
before(async () => {
  setupScenario(NOW);
  await new Promise((res) => server.listen(0, res));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const j = async (path, opts) => {
  const res = await fetch(base + path, opts);
  return { status: res.status, body: await res.json() };
};

test('GET 首页 200 且为 HTML', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('/api/time 根据 X-Client-Time 报告偏差（对真实服务器时间）', async () => {
  const serverMs = Date.now();
  const r = await j('/api/time', { headers: { 'X-Client-Time': String(serverMs + 7200000) } });
  assert.ok(Math.abs(r.body.skewSeconds - 7200) <= 2);
  assert.equal(r.body.trusted, false);
});

test('管理导入缺令牌 401；draft 被业务拒绝；重复公告 dedup', async () => {
  const win = encodeURIComponent('2026-10-07T06:30:00+08:00');
  const win2 = encodeURIComponent('2026-10-07T08:00:00+08:00');
  let r = await j('/api/admin/notices', { method:'POST', body:'{}' });
  assert.equal(r.status, 401);

  const draft = JSON.stringify({ status:'draft', topic:'boat', predicate:'operates',
    applicableWindows:[{start:'2026-10-07T06:30:00+08:00',end:'2026-10-07T08:00:00+08:00'}] });
  r = await j('/api/admin/notices', { method:'POST', headers:{'X-Admin-Token':'beacon-admin-token','Content-Type':'application/json'}, body:draft });
  assert.equal(r.body.results[0].result, 'rejected');

  const dup = JSON.stringify({ status:'confirmed', topic:'boat', resourceId:'ferry', predicate:'operates',
    title:'班期', legs:['outbound','return'],
    applicableWindows:[
      {start:'2026-10-07T06:30:00+08:00',end:'2026-10-07T08:00:00+08:00'},
      {start:'2026-10-07T14:00:00+08:00',end:'2026-10-07T15:30:00+08:00'},
      {start:'2026-10-08T06:30:00+08:00',end:'2026-10-08T08:00:00+08:00'},
      {start:'2026-10-08T14:00:00+08:00',end:'2026-10-08T15:30:00+08:00'}],
    source:{name:'航运',sourceTime:'2026-10-07T22:00:00+08:00'} });
  r = await j('/api/admin/notices', { method:'POST', headers:{'X-Admin-Token':'beacon-admin-token','Content-Type':'application/json'}, body:dup });
  assert.equal(r.body.results[0].result, 'duplicate');
});

test('/api/landing 返回四类条件及各自最后核对时间', async () => {
  const r = await j('/api/landing?start=2026-10-07T06:30:00%2B08:00&end=2026-10-07T07:30:00%2B08:00');
  assert.equal(r.body.decision, 'LANDING_POSSIBLE');
  for (const k of ['boat','weather','tide','venue']) {
    assert.ok(r.body.lastChecked[k]);
    assert.ok(r.body.conditions[k]);
  }
});

test('/api/offline/pack 含 expiresAt 与免责声明', async () => {
  const r = await j('/api/offline/pack');
  assert.ok(r.body.pack.expiresAtISO);
  assert.match(r.body.pack.disclaimer, /安全|交通/);
});
