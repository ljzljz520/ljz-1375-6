// 条件域：船班(boat)、天气(weather)、潮汐(tide)、场所开放(venue) 是四类互相独立的条件。
// 任一条件都可能是 TRUE / FALSE / UNKNOWN；“数据不足”或“互相冲突”一律保留 UNKNOWN，
// 任何单一条件（哪怕船班 TRUE）都不允许推出“可登岛”。
import { FRESHNESS_SECONDS } from '../config.js';
import { activeNotices, latestSourceTime } from './notices.js';
import { intersect, offsetISO } from '../util/time.js';

export function claimsFromNotices(notices, query) {
  // 把公告展开为“声明(claim)”：在裁剪后的窗口内给出正向/负向结论
  const claims = [];
  for (const n of notices) {
    for (const w0 of n.applicableWindows) {
      const w = intersect(w0, query);
      if (!w) continue;
      let positive = null;
      if (n.topic === 'boat') positive = n.predicate === 'operates';
      if (n.topic === 'weather') positive = n.payload?.severity === 'fair';
      if (n.topic === 'tide') positive = n.predicate === 'window';
      if (n.topic === 'venue') positive = n.predicate === 'open';
      if (positive === null) continue;
      claims.push({
        window: w, fullWindow: w0, positive, topic: n.topic, resourceId: n.resourceId,
        noticeId: n.id, sourceTime: n.source?.sourceTime, sourceName: n.source?.name,
        generation: n.generation, summary: n.summary || n.title,
      });
    }
  }
  return claims;
}

const refOf = (c) => ({
  noticeId: c.noticeId, summary: c.summary, generation: c.generation, sourceTime: c.sourceTime,
});

/**
 * 通用声明归约（边界扫描）。在 query 上按所有声明的起止点切成基本段，逐段判定：
 *  - 无声明            -> UNKNOWN（数据不足，保留未知）
 *  - 仅正向/仅负向     -> TRUE / FALSE
 *  - 正负同时存在      -> 若负向窗口更具体（严格被正向包含，临时取消/临时关闭挖洞）=> FALSE；
 *                        若正向窗口更具体（被负向包含）=> TRUE；
 *                        特异性相同、正反对撞 => CONFLICT（保留未知）
 */
export function reduceClaims(claims, query) {
  const boundaries = new Set([query.start, query.end]);
  for (const c of claims) { boundaries.add(c.window.start); boundaries.add(c.window.end); }
  const points = [...boundaries].filter((p) => p > query.start && p < query.end)
    .sort((a, b) => a - b);
  const edges = [query.start, ...points, query.end];

  const segments = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const seg = { start: edges[i], end: edges[i + 1] };
    if (seg.end <= seg.start) continue;
    const covering = claims.filter((c) => c.window.start <= seg.start && c.window.end >= seg.end);
    const pos = covering.filter((c) => c.positive);
    const neg = covering.filter((c) => !c.positive);

    let status;
    if (covering.length === 0) status = 'UNKNOWN';
    else if (pos.length && !neg.length) status = 'TRUE';
    else if (neg.length && !pos.length) status = 'FALSE';
    else {
      // 正负对撞：
      //  1) 特异性（窗口宽度）：更窄的“临时”声明优先（临时取消/关闭挖洞）。
      //  2) 等宽时默认取安全侧：负向优先 => FALSE。
      //  3) 等宽且来自“不同来源”的权威对撞（如气象部门间分歧）：无法调和 => CONFLICT，保留未知。
      //     同一来源对同一班次既发班期又发取消，属于修正，按 2) 处理为取消。
      const widthsPos = pos.map((c) => c.window.end - c.window.start);
      const widthsNeg = neg.map((c) => c.window.end - c.window.start);
      const minPos = Math.min(...widthsPos);
      const minNeg = Math.min(...widthsNeg);
      const sourceNames = new Set(covering.map((c) => c.sourceName));
      const crossSourceDispute = minPos === minNeg && sourceNames.size > 1;
      if (minNeg < minPos) status = 'FALSE';
      else if (minPos < minNeg) status = 'TRUE';
      else status = crossSourceDispute ? 'CONFLICT' : 'FALSE';
    }
    segments.push({
      ...seg, status,
      evidence: covering.map(refOf),
      conflicts: status === 'CONFLICT'
        ? { positive: pos.map(refOf), negative: neg.map(refOf) }
        : undefined,
    });
  }

  // 合并相邻同状态段（证据去重保留）
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.status === s.status && last.end === s.start) {
      last.end = s.end;
      const seen = new Set(last.evidence.map((e) => e.noticeId));
      for (const e of s.evidence) if (!seen.has(e.noticeId)) { last.evidence.push(e); seen.add(e.noticeId); }
    } else {
      out.push({ ...s, evidence: [...s.evidence] });
    }
  }

  const statuses = new Set(out.map((s) => s.status));
  let overall;
  if (statuses.size === 1) overall = [...statuses][0];
  else if (statuses.has('CONFLICT') && !statuses.has('TRUE') && !statuses.has('FALSE')) overall = 'CONFLICT';
  else overall = 'MIXED';
  return { segments: out, overall };
}

function evaluate(topic, query, { resourceId = null, now = Date.now() } = {}) {
  const notices = activeNotices(query, { topic, resourceId: resourceId || undefined });
  const claims = claimsFromNotices(notices, query);
  const reduced = reduceClaims(claims, query);
  const checkedAt = latestSourceTime(notices);
  const ttl = FRESHNESS_SECONDS[topic] || 86400;
  const stale = checkedAt == null ? null : now - checkedAt > ttl * 1000;

  // 对外判定：CONFLICT 与 UNKNOWN 都不下可登岛结论；陈旧也降级 UNKNOWN（数据不是“现场”的）
  let verdict = reduced.overall;
  let verdictReason = null;
  if (verdict === 'CONFLICT') verdictReason = '公告互相冲突，保留未知';
  if (claims.length === 0 || verdict === 'UNKNOWN') verdictReason = '该时段缺少数据，保留未知';
  if (verdict === 'MIXED') verdictReason = '窗口内仅部分时段有数据或被临时取消，逐段查看，不能对整天笼统下结论';
  if (stale) { verdict = 'UNKNOWN'; verdictReason = `来源时间超过 ${ttl / 3600}h 未核对，不可据此下结论`; }

  return {
    topic, resourceId: resourceId || null,
    verdict, rawOverall: reduced.overall, stale,
    checkedAt, checkedAtISO: offsetISO(checkedAt),
    freshnessTtlSeconds: ttl,
    reason: verdictReason,
    segments: reduced.segments.map((s) => ({
      start: offsetISO(s.start), end: offsetISO(s.end), status: s.status,
      evidence: (s.evidence || []).map((e) => ({ ...e, sourceTime: offsetISO(e.sourceTime) })),
      conflicts: s.conflicts,
    })),
  };
}

export const boatCondition    = (q, opts) => evaluate('boat', q, opts);
export const weatherCondition = (q, opts) => evaluate('weather', q, opts);
export const tideCondition    = (q, opts) => evaluate('tide', q, opts);
export const venueCondition   = (q, opts) => evaluate('venue', q, opts);

/** 场所是多个独立资源：逐个场所归约；全部开放才 TRUE，有冲突/未知则整体未知 */
export function venueSetCondition(query, opts = {}) {
  const dbNotices = activeNotices(query, { topic: 'venue' });
  const ids = [...new Set(dbNotices.map((n) => n.resourceId).filter(Boolean))];
  const perVenue = ids.map((id) => venueCondition(query, { resourceId: id, now: opts.now }));
  const checkedAt = perVenue.length ? Math.max(...perVenue.map((v) => v.checkedAt ?? 0)) : null;
  const staleAny = perVenue.some((v) => v.stale);
  let verdict;
  if (!perVenue.length) verdict = 'UNKNOWN';
  else if (perVenue.some((v) => v.verdict === 'FALSE')) verdict = 'FALSE';
  else if (perVenue.some((v) => v.verdict !== 'TRUE')) verdict = 'UNKNOWN';
  else verdict = 'TRUE';
  let reason = null;
  if (verdict === 'UNKNOWN' && !perVenue.length) reason = '没有任何场所开放数据，保留未知';
  if (verdict === 'UNKNOWN') reason = '部分场所数据不足/冲突/关闭，不能据部分开放场所给出整体结论';
  if (staleAny) { verdict = 'UNKNOWN'; reason = '存在场所公告超过 24h 未核对，不可据此下结论'; }
  return {
    topic: 'venue', verdict, reason, stale: staleAny,
    checkedAt, checkedAtISO: offsetISO(checkedAt),
    perVenue,
  };
}

/**
 * 登岛综合判定：四类条件必须同时成立（每类都需要数据，且为 TRUE）。
 * 任何 UNKNOWN / CONFLICT / MIXED / 缺失 / 陈旧 -> UNKNOWN，不输出“可登岛”。
 */
export function landingDecision(query, opts = {}) {
  const boat = boatCondition(query, opts);
  const weather = weatherCondition(query, opts);
  const tide = tideCondition(query, opts);
  const venue = venueSetCondition(query, opts);

  const parts = { boat, weather, tide, venue };
  const vals = Object.values(parts).map((p) => p.verdict);
  let decision;
  if (vals.includes('FALSE')) decision = 'NO_LANDING';
  else if (vals.every((v) => v === 'TRUE')) decision = 'LANDING_POSSIBLE';
  else decision = 'UNKNOWN';

  const reasons = [];
  if (decision === 'UNKNOWN') {
    for (const [k, p] of Object.entries(parts)) {
      if (p.verdict !== 'TRUE') reasons.push(`${k}: ${p.reason || p.verdict}`);
    }
  }
  const checkedTimes = Object.fromEntries(
    Object.entries(parts).map(([k, p]) => [k, { checkedAtISO: p.checkedAtISO, stale: p.stale }])
  );
  return {
    decision,
    reason: reasons.join('；') || null,
    rule: '船班∧天气∧潮汐∱所开放；任一未知/冲突/陈旧即整体未知',
    conditions: parts,
    lastChecked: checkedTimes,
  };
}
