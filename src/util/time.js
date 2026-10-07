// 时间工具：站点固定 UTC+8，内部一律以 epoch 毫秒（UTC）计算；区间统一用半开区间 [start, end)。
import { SITE_OFFSET_MIN } from '../config.js';

const pad = (n) => String(n).padStart(2, '0');

/** 当天站点本地 00:00 的 epoch ms（支持任意基准日期，种子数据由此获得确定性相对日期） */
export function siteMidnight(base = Date.now()) {
  const off = SITE_OFFSET_MIN * 60000;
  const shifted = Math.floor((base + off) / 86400000) * 86400000;
  return shifted - off;
}

export function addDays(ts, days) {
  return ts + days * 86400000;
}
export function addHours(ts, h) {
  return ts + h * 3600000;
}

/** epoch ms -> 站点本地 ISO 字符串（标注 +08:00） */
export function offsetISO(ts) {
  if (ts == null) return null;
  const d = new Date(ts + SITE_OFFSET_MIN * 60000);
  return (
    d.getUTCFullYear() +
    '-' + pad(d.getUTCMonth() + 1) +
    '-' + pad(d.getUTCDate()) +
    'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) +
    ':' + pad(d.getUTCSeconds()) + '+08:00'
  );
}

/** 解析：数字 epoch / Date / 'YYYY-MM-DD' / 本地无时区 ISO（默认 +08:00） */
export function parseOffsetISO(s) {
  if (typeof s === 'number') return s;
  if (s instanceof Date) return s.getTime();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00+08:00');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return Date.parse((s.includes('+') || s.endsWith('Z')) ? s : s + '+08:00');
  }
  return Date.parse(s);
}

/** 站点本地日期的 [00:00, 次日00:00) 半开区间；可跨日偏移 */
export function dayBounds(baseOrTs, dayOffset = 0) {
  const ms = typeof baseOrTs === 'number' ? baseOrTs : parseOffsetISO(baseOrTs);
  const start = addDays(siteMidnight(ms), dayOffset);
  return { start, end: addDays(start, 1) };
}

/** 半开区间求交；不相交返回 null */
export function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

export function subtractInterval(win, cut) {
  const c = intersect(win, cut);
  if (!c) return [win];
  const out = [];
  if (win.start < c.start) out.push({ start: win.start, end: c.start });
  if (c.end < win.end) out.push({ start: c.end, end: win.end });
  return out;
}

export function durationMin(win) {
  return Math.round((win.end - win.start) / 60000);
}

/** 合并相接/重叠区间 */
export function mergeIntervals(list) {
  const out = [];
  for (const iv of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function isoWin(w) {
  return w ? { start: offsetISO(w.start), end: offsetISO(w.end) } : null;
}
