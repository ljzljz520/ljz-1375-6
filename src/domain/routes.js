// 路线域：对“用户选择的、已审核(reviewed)”路线做时间区间求交。
// 临时取消必须落到相关航段（leg.resource 匹配），不相关航段与守塔人历史资料不受影响。
import { load, save } from '../db/store.js';
import { intersect, offsetISO, parseOffsetISO, dayBounds, addDays } from '../util/time.js';
import { reduceClaims } from './conditions.js';
import { claimsFromNoticesBridge } from './bridge.js';

let seq = 0;
export function addRoute(route) {
  const db = load();
  const rec = {
    id: route.id || `route_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    name: route.name,
    reviewed: route.reviewed !== false,
    legs: route.legs.map((l) => ({
      id: l.id, label: l.label,
      resourceTopic: l.resourceTopic, resourceId: l.resourceId || null,
      start: l.start, end: l.end, // 站点本地 HH:MM（相对当天）
    })),
  };
  db.routes.push(rec);
  save();
  return rec;
}

function hhmmToTs(baseDay, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return baseDay + h * 3600000 + m * 60000;
}

/**
 * 检查用户在某日期选择的已审路线。
 * userWindow: {start, end}（可跨多日/跨夜）；dateTs: 该路线模板的基准日（站点本地 00:00）。
 */
export function checkRoute(routeId, dateInput, userWindowInput, now = Date.now()) {
  const db = load();
  const route = db.routes.find((r) => r.id === routeId);
  if (!route) return { error: '路线不存在' };
  if (!route.reviewed) return { error: '该路线尚未审核，不能用于区间校验' };

  const dateTs = typeof dateInput === 'number' ? dateInput : parseOffsetISO(dateInput);
  const day0 = dayBounds(dateTs).start;
  const q = {
    start: typeof userWindowInput.start === 'number' ? userWindowInput.start : parseOffsetISO(userWindowInput.start),
    end: typeof userWindowInput.end === 'number' ? userWindowInput.end : parseOffsetISO(userWindowInput.end),
  };

  const legs = route.legs.map((leg) => {
    let legDay = day0;
    // 跨夜航段：end HH:MM <= start HH:MM 视为次日
    if (leg.end <= leg.start) legDay = addDays(day0, 1);
    const planned = { start: hhmmToTs(day0, leg.start), end: hhmmToTs(legDay, leg.end) };
    const overlap = intersect(planned, q);

    // 只在“用户选择 ∩ 该航段”的区间上评估该航段资源；无交集则不需要该资源
    let evaluation = null;
    if (overlap) {
      const claims = claimsFromNoticesBridge(leg.resourceTopic, overlap, { resourceId: leg.resourceId });
      evaluation = reduceClaims(claims, overlap);
    }
    return {
      id: leg.id, label: leg.label,
      resource: { topic: leg.resourceTopic, resourceId: leg.resourceId },
      planned: { start: offsetISO(planned.start), end: offsetISO(planned.end) },
      intersectsUserWindow: Boolean(overlap),
      intersection: overlap ? { start: offsetISO(overlap.start), end: offsetISO(overlap.end) } : null,
      status: !overlap ? 'NOT_NEEDED' : evaluation.overall,
      reason: !overlap
        ? '用户选择的时间不覆盖该航段'
        : evaluation.overall === 'FALSE' ? '该航段相关资源被临时取消/关闭'
        : evaluation.overall === 'CONFLICT' ? '公告冲突，保留未知'
        : evaluation.overall === 'UNKNOWN' ? '该航段缺少数据，保留未知'
        : '该航段条件成立',
      segments: evaluation ? evaluation.segments.map((s) => ({
        start: offsetISO(s.start), end: offsetISO(s.end), status: s.status,
        evidence: (s.evidence || []).map((e) => ({ ...e, sourceTime: offsetISO(e.sourceTime) })),
      })) : [],
    };
  });

  const needed = legs.filter((l) => l.intersectsUserWindow);
  const hasFalseSegment = (l) => l.segments.some((s) => s.status === 'FALSE');
  let overall;
  if (!needed.length) overall = 'NO_OVERLAP';
  else if (needed.some((l) => l.status === 'FALSE' || hasFalseSegment(l))) overall = 'BLOCKED';
  else if (needed.every((l) => l.status === 'TRUE')) overall = 'OK';
  else overall = 'UNKNOWN';

  return {
    routeId, routeName: route.name, reviewed: route.reviewed,
    day: offsetISO(day0).slice(0, 10),
    userWindow: { start: offsetISO(q.start), end: offsetISO(q.end) },
    overall,
    rule: '对每个被用户窗口覆盖的航段做区间求交；临时取消仅影响其 resource 对应的航段',
    legs,
  };
}
