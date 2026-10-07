import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScenario } from './helpers.js';
import { buildPack, evaluatePack } from '../src/domain/offline.js';
import { assessClock } from '../src/domain/clock.js';
import { saveFavorite, reconnect } from '../src/domain/favorites.js';
import { importNotice } from '../src/domain/notices.js';
import { offsetISO as iso } from '../src/util/time.js';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);

test('客户端时钟偏差被识别且业务采用服务器时间', () => {
  const a = assessClock(NOW + 7200000, NOW); // 客户端快 2 小时
  assert.equal(a.skewSeconds, 7200);
  assert.equal(a.trusted, false);
  assert.equal(a.correctedNow, NOW);
});

test('离线包带有效期；过期后 expired=true 且免责声明不得承诺安全/交通', () => {
  setupScenario(NOW);
  const pack = buildPack(NOW);
  assert.ok(pack.expiresAt > pack.generatedAt);
  assert.match(pack.disclaimer, /不.*(安全|交通).*保证|不构成/);
  const live = evaluatePack(pack, NOW + 1000);
  assert.equal(live.expired, false);
  const dead = evaluatePack(pack, pack.expiresAt + 1000);
  assert.equal(dead.expired, true);
  assert.match(dead.guidance, /过期|重新联网/);
});

test('收藏重连：导入新公告后 diff 标记变化', () => {
  const { d } = setupScenario(NOW);
  const fav = saveFavorite({ name:'p', window:{ start: iso(d(0,0)), end: iso(d(1,0)) } }, NOW);
  const before = reconnect(fav.id, NOW);
  assert.equal(before.changed, false);

  importNotice({ status:'confirmed', topic:'venue', resourceId:'view', predicate:'closed',
    title:'重连前新增关闭', applicableWindows:[{start:iso(d(0,10)),end:iso(d(0,11))}],
    source:{name:'运维',sourceTime:new Date(NOW).toISOString()} }, NOW);

  const after = reconnect(fav.id, NOW);
  assert.equal(after.generationAdvanced, true);
  assert.equal(after.changed, true);
  assert.ok(after.diff.some((x) => x.changed));
});

test('守塔人资料不随公告代次失效', () => {
  setupScenario(NOW);
  importNotice({ status:'confirmed', topic:'boat', resourceId:'ferry', predicate:'cancelled',
    title:'再多取消也不影响历史', applicableWindows:[{start:iso(NOW),end:iso(NOW+3600000)}],
    source:{name:'航运',sourceTime:new Date(NOW).toISOString()} }, NOW);
  const keepers = listKeepers();
  assert.equal(keepers.length, 1);
  assert.equal(keepers[0].superseded, false);
  assert.match(keepers[0].note, /独立|安全/);
});
import { listKeepers } from '../src/domain/history.js';
