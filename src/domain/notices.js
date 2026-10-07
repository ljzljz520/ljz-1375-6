// 公告域：管理端只接受“经确认(confirmed)”的公告；保存来源时间、适用窗口与内容代次。
// 重复船班通知以 dedupKey 去重（不产生新代次、不触发计划失效）。
import { createHash } from 'node:crypto';
import { load, save, nextGeneration } from '../db/store.js';
import { intersect, parseOffsetISO, offsetISO } from '../util/time.js';

let seq = 0;
const newId = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** 规范化窗口（epoch ms 半开区间） */
export function normalizeWindows(windows) {
  return (windows || []).map((w) => ({
    start: parseOffsetISO(w.start),
    end: parseOffsetISO(w.end),
  })).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
}

/** 去重键：同一来源、同一结论、同一航段、同一适用窗口的重复导入视为重复公告 */
export function dedupKey(n) {
  const basis = {
    topic: n.topic,
    resourceId: n.resourceId || null,
    predicate: n.predicate,
    legs: [...(n.legs || [])].sort(),
    windows: normalizeWindows(n.applicableWindows)
      .map((w) => `${w.start}/${w.end}`).sort(),
    severity: n.payload?.severity || null,
    source: n.source?.name || null,
    text: (n.summary || n.title || '').trim(),
  };
  return createHash('sha1').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

/**
 * 导入一条公告（管理 API）。
 * 约束：仅接受 status=confirmed；draft/refuted 一律拒绝。
 * 返回 { result: 'inserted'|'duplicate'|'rejected', reason? }
 */
export function importNotice(input, now = Date.now()) {
  const db = load();
  const status = (input.status || 'confirmed').toLowerCase();
  if (status !== 'confirmed') {
    return { result: 'rejected', reason: `仅接受经确认的公告，收到 status=${status}` };
  }

  const windows = normalizeWindows(input.applicableWindows);
  if (!windows.length) {
    return { result: 'rejected', reason: '缺少有效的适用时间窗口 applicableWindows' };
  }

  const candidate = {
    id: input.id || newId('ntc'),
    topic: input.topic,
    resourceId: input.resourceId || null,
    predicate: input.predicate,
    title: input.title || '',
    summary: input.summary || '',
    legs: input.legs || [],
    payload: input.payload || {},
    source: {
      name: input.source?.name || '未知来源',
      url: input.source?.url || null,
      sourceTime: parseOffsetISO(input.source?.sourceTime) ?? now,
      receivedAt: now,
    },
    applicableWindows: windows,
    status: 'confirmed',
    generation: 0,
    dedupKey: '',
    importedAt: now,
  };
  candidate.dedupKey = dedupKey(candidate);

  if (db.notices.some((n) => n.dedupKey === candidate.dedupKey)) {
    // 重复：保留首次导入，仅累加计数；不递增内容代次，计划缓存无需失效
    const first = db.notices.find((n) => n.dedupKey === candidate.dedupKey);
    first.duplicateCount = (first.duplicateCount || 1) + 1;
    save();
    return { result: 'duplicate', noticeId: first.id, generation: db.generation };
  }

  candidate.generation = nextGeneration(); // 新内容 -> 新代次，后台预计算计划随之失效
  db.importedAt = now;
  db.notices.push(candidate);
  save();
  return { result: 'inserted', noticeId: candidate.id, generation: candidate.generation };
}

/** 取在查询窗口内（有交集）且当前仍适用的已确认公告 */
export function activeNotices(window, filter = {}) {
  return load().notices
    .filter((n) => n.status === 'confirmed')
    .filter((n) => (filter.topic ? n.topic === filter.topic : true))
    .filter((n) => (filter.resourceId ? n.resourceId === filter.resourceId : true))
    .filter((n) => (filter.predicate ? n.predicate === filter.predicate : true))
    .filter((n) => n.applicableWindows.some((w) => intersect(w, window)));
}

/** 某条件域最近来源时间（用于“最后核对时间”） */
export function latestSourceTime(notices) {
  const times = notices.map((n) => n.source?.sourceTime).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function presentNotice(n) {
  return {
    ...n,
    applicableWindows: n.applicableWindows.map((w) => ({
      start: offsetISO(w.start), end: offsetISO(w.end),
    })),
    source: { ...n.source, sourceTime: offsetISO(n.source.sourceTime), receivedAt: offsetISO(n.source.receivedAt) },
    importedAt: offsetISO(n.importedAt),
    duplicateCount: n.duplicateCount || 1,
  };
}
