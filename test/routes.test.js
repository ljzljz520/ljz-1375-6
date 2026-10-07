import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { checkRoute } from '../src/domain/routes.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);

test('已审路线 D0 整天窗口：所有被覆盖航段成立 => OK', () => {
  const { d } = setupScenario(NOW);
  const r = checkRoute('r1', d(0), { start: d(0, 6), end: d(0, 16) }, NOW);
  assert.equal(r.overall, 'OK');
  assert.ok(r.legs.every((l) => ['TRUE','NOT_NEEDED'].includes(l.status)));
});

test('D1 早班取消只影响渡轮航段 => BLOCKED；午后窗口不触达取消 => OK', () => {
  const { d } = setupScenario(NOW);
  const all = checkRoute('r1', d(1), { start: d(1, 6), end: d(1, 16) }, NOW);
  assert.equal(all.overall, 'BLOCKED');
  const ferry = all.legs.find((l) => l.id === 'ferry');
  assert.ok(ferry.segments.some((s) => s.status === 'FALSE'));
  // 取消不影响观景台/登塔/返程
  assert.equal(all.legs.find((l) => l.id === 'view').status, 'TRUE');

  const pm = checkRoute('r1', d(1), { start: d(1, 13), end: d(1, 16) }, NOW);
  assert.equal(pm.overall, 'OK');
  assert.ok(pm.legs.find((l) => l.id === 'ferry').intersectsUserWindow === false
    || !pm.legs.find((l) => l.id === 'ferry').segments.some((s) => s.status === 'FALSE'));
});

test('未审核路线不能用于区间校验', () => {
  const { d } = setupScenario(NOW);
  const r = checkRoute('draft', d(0), { start: d(0, 6), end: d(0, 8) }, NOW);
  assert.match(r.error, /尚未审核/);
});

test('跨夜潮位窗口 23:30-02:30 可被识别（跨日记录）', () => {
  const { d } = setupScenario(NOW);
  const r = checkRoute('r1', d(1), { start: d(1, 23, 30), end: d(2, 2, 30) }, NOW);
  // 该夜窗口与路线模板不相交（路线是日间），但潮汐条件本身可被单独验证
  const tide = r.legs.find((l) => l.id === 'tide');
  assert.equal(tide.intersectsUserWindow, false);
});
