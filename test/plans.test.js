import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { compare, precomputeDay, getPlan } from '../src/domain/plans.js';
import { importNotice } from '../src/domain/notices.js';
import { load } from '../src/db/store.js';
import { offsetISO as iso } from '../src/util/time.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);

test('新公告推进代次后，旧预计算计划标记 stale，但仍可展示', () => {
  const { d } = setupScenario(NOW);
  const before = getPlan(d(0), NOW);
  assert.equal(before.stale, false);

  importNotice({ status:'confirmed', topic:'venue', resourceId:'tower', predicate:'closed',
    title:'又一条新公告', applicableWindows:[{start:iso(d(0,9)),end:iso(d(0,12))}],
    source:{name:'管理处',sourceTime:new Date(NOW).toISOString()} }, NOW);

  const after = getPlan(d(0), NOW);
  assert.equal(after.stale, true);
  assert.equal(after.available, true); // 旧计划仍在，只是不能当新结论
});

test('compare 同时返回预计算结论、实时结论与延迟字段', () => {
  const { d } = setupScenario(NOW);
  const r = compare(d(0), NOW);
  assert.ok(r.precomputed);
  assert.equal(typeof r.requestTime.computeMs, 'number');
  assert.ok(r.tradeoff.announcementFrequency.includes('公告'));
});

test('重复通知不推进代次，计划不 stale', () => {
  const { d } = setupScenario(NOW);
  importNotice({ status:'confirmed', topic:'boat', resourceId:'ferry', predicate:'operates',
    title:'班期', legs:['outbound','return'],
    applicableWindows:[{start:iso(d(0,6,30)),end:iso(d(0,8))},{start:iso(d(0,14)),end:iso(d(0,15,30))},
      {start:iso(d(1,6,30)),end:iso(d(1,8))},{start:iso(d(1,14)),end:iso(d(1,15,30))}],
    source:{name:'航运',sourceTime:new Date(NOW).toISOString()} }, NOW);
  assert.equal(getPlan(d(0), NOW).stale, false);
});
