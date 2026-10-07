// 预计算域：后台按“日期计划”预聚合四类条件；与“请求时组合约束”并存以便对比取舍。
// 失效策略：公告导入产生新内容代次后，旧 generation 的计划立即标记 stale（保守失效）。
import { load, save } from '../db/store.js';
import { dayBounds, offsetISO } from '../util/time.js';
import { landingDecision } from './conditions.js';

export function dayKey(ts) {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  return offsetISO(dayBounds(ms).start).slice(0, 10);
}

/** 后台预计算：对某天站点本地 00:00–24:00 计算整体结论，落库并记录生成代次与耗时 */
export function precomputeDay(dateInput, now = Date.now()) {
  const db = load();
  const base = typeof dateInput === 'number' ? dateInput : Date.parse(dateInput);
  const q = dayBounds(base ?? now);
  const t0 = process.hrtime.bigint();
  const decision = landingDecision(q, { now });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const plan = {
    day: dayKey(q.start),
    window: { start: offsetISO(q.start), end: offsetISO(q.end) },
    decision: decision.decision,
    conditions: decision.conditions,
    generatedAt: now,
    generation: db.generation,
    computeMs: Math.round(elapsedMs * 1000) / 1000,
  };
  db.plans.byDate[plan.day] = plan;
  save();
  return plan;
}

/** 读取预计算计划；若内容代次已推进则标 stale（仍可展示，但不能当作新结论） */
export function getPlan(dateInput, now = Date.now()) {
  const db = load();
  const key = dayKey(typeof dateInput === 'number' ? dateInput : Date.parse(dateInput));
  const plan = db.plans.byDate[key];
  if (!plan) return { day: key, available: false };
  return { ...plan, available: true, stale: plan.generation !== db.generation };
}

/**
 * 对比：同一日期窗口上，预计算（旧）vs 请求时实时组合（新）。
 * 用于说明公告频率/查询延迟/缓存失效三者的取舍。
 */
export function compare(dateInput, now = Date.now()) {
  const db = load();
  const base = typeof dateInput === 'number' ? dateInput : Date.parse(dateInput);
  const q = dayBounds(base ?? now);

  const t0 = process.hrtime.bigint();
  const fresh = landingDecision(q, { now });
  const requestMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const plan = getPlan(base ?? now, now);
  const changed = plan.available ? plan.decision !== fresh.decision : null;

  return {
    day: dayKey(q.start),
    contentGeneration: db.generation,
    precomputed: plan.available ? {
      decision: plan.decision,
      generatedAt: offsetISO(plan.generatedAt),
      generation: plan.generation,
      stale: plan.stale,
      computeMs: plan.computeMs,
      serveMs: null, // 读缓存近似 0，见路由层计时
    } : null,
    requestTime: {
      decision: fresh.decision,
      computeMs: Math.round(requestMs * 1000) / 1000,
      lastChecked: fresh.lastChecked,
    },
    decisionChanged: changed,
    tradeoff: {
      announcementFrequency: '公告越频繁，预计算越易过期；实时组合始终最新但每次都要归约四类条件',
      queryLatency: '预计算 O(1) 读缓存、延迟低；请求时组合随公告数量线性增长，延迟高',
      cacheInvalidation: '本系统采用代次失效：仅内容变化(非重复通知)才递增代次并保守失效旧计划',
    },
  };
}
