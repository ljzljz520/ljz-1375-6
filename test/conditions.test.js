import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { landingDecision, venueCondition } from '../src/domain/conditions.js';
import { importNotice } from '../src/domain/notices.js';
import { offsetISO as iso } from '../src/util/time.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);

test('四条件在重叠窗口全部成立时才可登岛', () => {
  const { d } = setupScenario(NOW);
  const r = landingDecision({ start: d(0, 6, 30), end: d(0, 7, 30) }, { now: NOW });
  assert.equal(r.decision, 'LANDING_POSSIBLE');
});

test('数据不足（D9 无任何公告）-> 整体 UNKNOWN，绝不放行', () => {
  const { d } = setupScenario(NOW);
  const r = landingDecision({ start: d(9, 6, 30), end: d(9, 7, 30) }, { now: NOW });
  assert.equal(r.decision, 'UNKNOWN');
  assert.match(r.reason, /boat/);
});

test('临时取消窗口内 boat=FALSE -> NO_LANDING，不能因其余条件好而放行', () => {
  const { d } = setupScenario(NOW);
  const r = landingDecision({ start: d(1, 6, 30), end: d(1, 7, 30) }, { now: NOW });
  assert.equal(r.conditions.boat.verdict, 'FALSE');
  assert.equal(r.decision, 'NO_LANDING');
});

test('等宽正反对撞 => CONFLICT 段，整体 UNKNOWN', () => {
  const { d } = setupScenario(NOW);
  const win = { start: iso(d(2, 14)), end: iso(d(2, 15)) };
  importNotice({ status:'confirmed', topic:'venue', resourceId:'z', predicate:'open', title:'开',
    applicableWindows:[win], source:{name:'a',sourceTime:new Date(NOW).toISOString()} }, NOW);
  importNotice({ status:'confirmed', topic:'venue', resourceId:'z', predicate:'closed', title:'关',
    applicableWindows:[win], source:{name:'b',sourceTime:new Date(NOW).toISOString()} }, NOW);
  const r = landingDecision({ start: d(2, 13), end: d(2, 16) }, { now: NOW });
  const z = r.conditions.venue.perVenue.find((v) => v.resourceId === 'z');
  assert.ok(z.segments.some((s) => s.status === 'CONFLICT'));
  assert.equal(r.decision, 'UNKNOWN');
});

test('临时关闭只挖掉小窗口：D1 观景台 TRUE/FALSE/TRUE 三段', () => {
  const { d } = setupScenario(NOW);
  const v = venueCondition({ start: d(1, 9), end: d(1, 18) }, { resourceId: 'view', now: NOW });
  assert.deepEqual(
    v.segments.map((s) => [s.status, s.start.slice(11, 16), s.end.slice(11, 16)]),
    [['TRUE','09:00','13:00'],['FALSE','13:00','17:00'],['TRUE','17:00','18:00']]
  );
});

test('超过 TTL 的陈旧来源降级为 UNKNOWN', () => {
  const { d } = setupScenario(NOW);
  const old = NOW - 100 * 3600000;
  // 覆盖一个原本没有天气数据的日期（D8），但来源时间在 100 小时前
  importNotice({ status:'confirmed', topic:'weather', resourceId:'island', predicate:'forecast',
    title:'陈旧天气', payload:{severity:'fair'},
    applicableWindows:[{start:iso(d(8,0)),end:iso(d(9,0))}],
    source:{name:'气象',sourceTime:new Date(old).toISOString()} }, NOW);
  const r = landingDecision({ start: d(8, 6, 30), end: d(8, 7, 30) }, { now: NOW });
  assert.equal(r.conditions.weather.stale, true);
  assert.equal(r.conditions.weather.verdict, 'UNKNOWN');
  assert.equal(r.decision, 'UNKNOWN');
});
