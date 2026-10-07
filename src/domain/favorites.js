// 收藏计划：保存时冻结一份快照；重连后对比“变化前后”，逐项标注变化，而不是静默覆盖。
import { load, save } from '../db/store.js';
import { landingDecision } from './conditions.js';
import { offsetISO, parseOffsetISO } from '../util/time.js';

let seq = 0;
export function saveFavorite(input, now = Date.now()) {
  const db = load();
  const id = input.id || `fav_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const q = {
    start: parseOffsetISO(input.window.start),
    end: parseOffsetISO(input.window.end),
  };
  const snapshot = landingDecision(q, { venueId: input.venueId, now });
  const rec = {
    id,
    name: input.name || '未命名计划',
    venueId: input.venueId || null,
    window: { start: q.start, end: q.end },
    savedAt: now,
    contentGeneration: db.generation,
    snapshot,
  };
  db.favorites[id] = rec;
  save();
  return { id, savedAt: offsetISO(now) };
}

export function listFavorites() {
  return Object.values(load().favorites).map((f) => ({
    id: f.id, name: f.name, venueId: f.venueId,
    window: { start: offsetISO(f.window.start), end: offsetISO(f.window.end) },
    savedAt: offsetISO(f.savedAt), contentGeneration: f.contentGeneration,
  }));
}

/** 重连：以同一窗口重新组合约束，与保存时快照逐项对比 */
export function reconnect(id, now = Date.now()) {
  const db = load();
  const fav = db.favorites[id];
  if (!fav) return { error: '收藏不存在' };
  const current = landingDecision(fav.window, { venueId: fav.venueId, now });
  const before = fav.snapshot;

  const fields = [];
  fields.push({
    field: 'decision',
    before: before.decision, after: current.decision,
    changed: before.decision !== current.decision,
  });
  for (const k of ['boat', 'weather', 'tide', 'venue']) {
    fields.push({
      field: `${k}.verdict`,
      before: before.conditions[k].verdict,
      after: current.conditions[k].verdict,
      changed: before.conditions[k].verdict !== current.conditions[k].verdict,
    });
    fields.push({
      field: `${k}.lastChecked`,
      before: before.conditions[k].checkedAtISO,
      after: current.conditions[k].checkedAtISO,
      changed: before.conditions[k].checkedAtISO !== current.conditions[k].checkedAtISO,
    });
  }
  // 细粒度：场所按资源逐段比较（临时关闭某个观景点，即使整体结论不变也要呈现）
  const beforePerVenue = Object.fromEntries((before.conditions.venue.perVenue || []).map((v) => [v.resourceId, v]));
  const afterPerVenue = Object.fromEntries((current.conditions.venue.perVenue || []).map((v) => [v.resourceId, v]));
  for (const id of new Set([...Object.keys(beforePerVenue), ...Object.keys(afterPerVenue)])) {
    const b = beforePerVenue[id] ? JSON.stringify(beforePerVenue[id].segments) : null;
    const a = afterPerVenue[id] ? JSON.stringify(afterPerVenue[id].segments) : null;
    fields.push({
      field: `venue.${id}.segments`,
      before: beforePerVenue[id] ? beforePerVenue[id].segments.map((x)=>x.status).join('/') : '（无数据）',
      after: afterPerVenue[id] ? afterPerVenue[id].segments.map((x)=>x.status).join('/') : '（无数据）',
      changed: b !== a,
    });
  }
  return {
    id: fav.id, name: fav.name,
    savedGeneration: fav.contentGeneration,
    currentGeneration: db.generation,
    generationAdvanced: fav.contentGeneration !== db.generation,
    changed: fields.some((f) => f.changed),
    before: { decision: before.decision, lastChecked: before.lastChecked },
    after: { decision: current.decision, lastChecked: current.lastChecked },
    diff: fields,
  };
}
