// 历史域：守塔人资料。历史事实与实时交通/天气公告属于不同内容流：
// 临时取消船班不会让历史资料失效；历史资料各自带独立的“资料核对时间”，不随公告代次更新。
import { load, save } from '../db/store.js';
import { parseOffsetISO, offsetISO } from '../util/time.js';

let seq = 0;
export function addKeeper(input, now = Date.now()) {
  const db = load();
  const rec = {
    id: input.id || `keeper_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    name: input.name,
    lighthouse: input.lighthouse,
    yearsOfService: input.yearsOfService || null,
    biography: input.biography || '',
    sources: input.sources || [],
    // 资料自身的核对时间（独立于公告 generation），及资料有效期（如档案截止年份）
    verifiedAt: parseOffsetISO(input.verifiedAt) ?? now,
    validUntil: input.validUntil ? parseOffsetISO(input.validUntil) : null,
    superseded: false, // 仅在出现更权威史料时置 true，不被任何实时公告影响
  };
  db.history.push(rec);
  save();
  return rec;
}

export function listKeepers() {
  return load().history.map((k) => ({
    ...k,
    verifiedAt: offsetISO(k.verifiedAt),
    validUntil: offsetISO(k.validUntil),
    note: '历史资料独立成流：船班/场所临时取消不会令其失效，也不构成现场安全或交通保证',
  }));
}
