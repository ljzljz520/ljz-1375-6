// 极简文档数据库（零依赖 JSON 持久化）。
// 关键：公告保存“来源时间 sourceTime、适用日期/窗口 applicableWindows、内容代次 generation”；
// 计划随内容代次失效（plan.generation 落后于当前 generation 即标 stale）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = new URL('../../data/db.json', import.meta.url).pathname;

const EMPTY = () => ({
  generation: 0,                  // 内容代次：仅在“新增/变更公告”时递增
  importedAt: null,               // 最近一次管理端导入（服务器时间）
  notices: [],
  history: [],
  routes: [],
  plans: { byDate: {} },         // 'YYYY-MM-DD'(站点本地) -> 预计算计划
  favorites: {},                  // id -> { id, name, createdAt, snapshot }
});

let cache = null;
let readCount = 0;
let writeCount = 0;

export function load() {
  if (cache) { readCount++; return cache; }
  try {
    cache = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, 'utf8')) : EMPTY();
  } catch {
    cache = EMPTY();
  }
  readCount++;
  return cache;
}

export function save() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(cache, null, 2));
  writeCount++;
}

export function reset() {
  cache = EMPTY();
  save();
  return cache;
}

export function nextGeneration() {
  const db = load();
  db.generation += 1;
  return db.generation;
}

export function dbStats() {
  return {
    generation: load().generation,
    notices: load().notices.length,
    history: load().history.length,
    routes: load().routes.length,
    planDates: Object.keys(load().plans.byDate).length,
    reads: readCount,
    writes: writeCount,
  };
}
