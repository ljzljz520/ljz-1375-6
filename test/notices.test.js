import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { importNotice } from '../src/domain/notices.js';
import { offsetISO as iso } from '../src/util/time.js';
import { load } from '../src/db/store.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);

test('重复船班通知：不新增代次、不触发失效，仅累加 duplicateCount', () => {
  const { d } = setupScenario(NOW);
  const before = load().generation;
  const payload = {
    status:'confirmed', topic:'boat', resourceId:'ferry', predicate:'operates',
    title:'班期', legs:['outbound','return'],
    applicableWindows:[{start:iso(d(0,6,30)),end:iso(d(0,8))},{start:iso(d(0,14)),end:iso(d(0,15,30))},
      {start:iso(d(1,6,30)),end:iso(d(1,8))},{start:iso(d(1,14)),end:iso(d(1,15,30))}],
    source:{name:'航运',sourceTime:new Date(NOW).toISOString()},
  };
  const r1 = importNotice(payload, NOW);
  assert.equal(r1.result, 'duplicate');
  assert.equal(load().generation, before);
  const first = load().notices.find((n) => n.id === r1.noticeId);
  assert.ok(first.duplicateCount >= 2);
});

test('draft/refuted 公告一律拒绝，不写库', () => {
  setupScenario(NOW);
  const before = load().notices.length;
  const r = importNotice({ status:'draft', topic:'boat', predicate:'operates',
    applicableWindows:[{start:iso(NOW),end:iso(NOW+3600000)}] }, NOW);
  assert.equal(r.result, 'rejected');
  assert.equal(load().notices.length, before);
});

test('新公告插入并推进内容代次', () => {
  setupScenario(NOW);
  const before = load().generation;
  const r = importNotice({ status:'confirmed', topic:'venue', resourceId:'new', predicate:'open',
    title:'新场所', applicableWindows:[{start:iso(NOW),end:iso(NOW+3600000)}],
    source:{name:'x',sourceTime:new Date(NOW).toISOString()} }, NOW);
  assert.equal(r.result, 'inserted');
  assert.equal(r.generation, before + 1);
});
