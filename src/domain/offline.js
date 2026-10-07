// 离线包：打包“截至生成时刻”的资料并标注有效期。
// 明确语义：过期离线包只能作历史参考，绝不能被描述为“现场安全”或“交通保证”。
import { OFFLINE_PACK_TTL_SECONDS } from '../config.js';
import { load } from '../db/store.js';
import { offsetISO } from '../util/time.js';
import { landingDecision } from './conditions.js';
import { listKeepers } from './history.js';
import { dayBounds, addDays } from '../util/time.js';

export function buildPack(now = Date.now(), days = 3) {
  const db = load();
  const daysPlans = [];
  for (let i = 0; i < days; i++) {
    const q = dayBounds(addDays(now, i));
    daysPlans.push({
      day: offsetISO(q.start).slice(0, 10),
      window: { start: offsetISO(q.start), end: offsetISO(q.end) },
      decision: landingDecision(q, { now }),
    });
  }
  return {
    packVersion: 1,
    generatedAt: now,
    generatedAtISO: offsetISO(now),
    expiresAt: now + OFFLINE_PACK_TTL_SECONDS * 1000,
    expiresAtISO: offsetISO(now + OFFLINE_PACK_TTL_SECONDS * 1000),
    validForSeconds: OFFLINE_PACK_TTL_SECONDS,
    contentGeneration: db.generation,
    days: daysPlans,
    notices: db.notices.map((n) => ({
      id: n.id, topic: n.topic, resourceId: n.resourceId, predicate: n.predicate,
      title: n.title, summary: n.summary, legs: n.legs,
      applicableWindows: n.applicableWindows.map((w) => ({ start: offsetISO(w.start), end: offsetISO(w.end) })),
      sourceTime: offsetISO(n.source.sourceTime),
    })),
    keepers: listKeepers(),
    disclaimer: '本离线包仅为“截至生成时刻”的缓存资料；过期后不代表现场安全状况，也不构成任何船班/登岛交通保证。',
  };
}

/** 客户端据服务器时间校验离线包是否过期 */
export function evaluatePack(pack, trustedNow) {
  const expired = trustedNow > pack.expiresAt;
  return {
    expired,
    secondsLeft: Math.round((pack.expiresAt - trustedNow) / 1000),
    staleGeneration: null, // 重新联网时用 comparePlans / favorites diff 判定
    guidance: expired
      ? '离线包已过期：只能作历史参考，必须重新联网核对船班、天气、潮汐、场所后再作决定'
      : '离线包在有效期内：可离线浏览资料，但任何“可登岛”结论仍需重新联网确认',
  };
}
