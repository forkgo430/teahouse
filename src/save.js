/**
 * 存档与回溯
 *
 * 三件事：
 *   1. 序列化：状态 → 单文件 JSON，可导出、可粘贴、可放进 URL 参数。
 *   2. 版本迁移：数据结构一定会变（第 7 期改 UI、将来加字段都会改）。
 *      存档里带 version，读档时逐级升级。查不到迁移函数就**明确报错**，
 *      绝不猜测字段含义——猜错比报错危险得多。
 *   3. 完整性校验：存档带状态指纹，导入时比对。损坏的存档要当场发现，
 *      而不是读进去之后在第 12 轮变成莫名其妙的数值。
 */

import { SCHEMA_VERSION } from './schema.js';
import { cloneState, hashState } from './state.js';

export const SAVE_FORMAT = 'narrative-engine/save';
export const SAVE_VERSION = 1;

export class SaveError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SaveError';
    this.detail = detail;
  }
}

/**
 * 迁移表：{ [fromVersion]: (save) => saveWithVersionPlusOne }
 *
 * 目前没有历史版本，表是空的。但机制必须先在位——等到真的需要改结构时
 * 才补，那时已经有一堆玩家的存档要照顾了。
 * 每个迁移函数**必须**把 save.version 推进一位，否则 migrate 会报错。
 */
export const MIGRATIONS = Object.freeze({});

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ *
 * 形状校验
 * ------------------------------------------------------------------ */

export function validateSaveShape(raw) {
  const issues = [];

  if (!isPlainObject(raw)) {
    return ['存档根节点必须是对象'];
  }
  if (raw.format !== SAVE_FORMAT) {
    issues.push(`format 应为 ${JSON.stringify(SAVE_FORMAT)}，实得 ${JSON.stringify(raw.format)}`);
  }
  if (!Number.isInteger(raw.version) || raw.version < 0) {
    issues.push(`version 必须是非负整数，实得 ${JSON.stringify(raw.version)}`);
  }
  if (!isPlainObject(raw.state)) {
    issues.push('state 缺失或不是对象');
  } else {
    if (!isPlainObject(raw.state.clock) || !Number.isInteger(raw.state.clock?.day)) {
      issues.push('state.clock.day 缺失或不是整数');
    }
    if (!isPlainObject(raw.state.actors)) {
      issues.push('state.actors 缺失或不是对象');
    }
    if (!Array.isArray(raw.state.history)) {
      issues.push('state.history 缺失或不是数组');
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * 迁移
 * ------------------------------------------------------------------ */

/**
 * 逐级迁移到目标版本。
 * @param {object} save
 * @param {object} [migrations] 迁移表
 * @param {number} [targetVersion] 目标版本，默认当前 SAVE_VERSION
 */
export function migrate(save, migrations = MIGRATIONS, targetVersion = SAVE_VERSION) {
  if (!isPlainObject(save)) {
    throw new SaveError('待迁移的存档不是对象');
  }
  if (!Number.isInteger(save.version)) {
    throw new SaveError(`存档 version 非法：${JSON.stringify(save.version)}`);
  }

  if (save.version > targetVersion) {
    throw new SaveError(
      `存档版本 v${save.version} 高于当前程序支持的 v${targetVersion}，请升级程序后再读`,
      { saveVersion: save.version, supported: targetVersion },
    );
  }

  let cur = save;
  let guard = 0;

  while (cur.version < targetVersion) {
    const step = migrations[cur.version];
    if (typeof step !== 'function') {
      throw new SaveError(
        `缺少 v${cur.version} → v${cur.version + 1} 的迁移函数，无法读取该存档`,
        { stuckAt: cur.version },
      );
    }
    const next = step(cur);
    if (!isPlainObject(next) || next.version !== cur.version + 1) {
      throw new SaveError(
        `迁移函数 v${cur.version} 没有把 version 推进到 v${cur.version + 1}（实得 ${JSON.stringify(next?.version)}）`,
        { from: cur.version },
      );
    }
    cur = next;

    guard += 1;
    if (guard > 1000) throw new SaveError('迁移链疑似死循环，已中止');
  }

  return cur;
}

/* ------------------------------------------------------------------ *
 * 构造与序列化
 * ------------------------------------------------------------------ */

export function makeSave(state, meta = {}, options = {}) {
  if (!isPlainObject(state)) throw new SaveError('state 必须是对象');

  const now = options.now ?? new Date().toISOString();

  // 先做一次 JSON 往返：让指纹与实际写进文件的字节严格一致。
  // 否则 undefined 这类值会在 stringify 时被丢掉，读档重算指纹就会误报「存档损坏」。
  const snapshot = JSON.parse(JSON.stringify(state));
  if (options.includeHistory === false) snapshot.history = [];

  const save = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
    createdAt: options.createdAt ?? now,
    updatedAt: now,
    dataVersion: options.dataVersion ?? null,
    meta: { ...meta },
    stateHash: hashState(snapshot),
    state: snapshot,
  };

  if (Array.isArray(options.timeline) && options.timeline.length > 0) {
    save.timeline = JSON.parse(JSON.stringify(options.timeline));
  }

  return save;
}

export function serialize(save, options = {}) {
  const issues = validateSaveShape(save);
  if (issues.length > 0) {
    throw new SaveError(`待序列化的存档结构不合法：\n  - ${issues.join('\n  - ')}`, { issues });
  }
  return JSON.stringify(save, null, options.pretty === false ? 0 : 2);
}

export function deserialize(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new SaveError('存档内容为空');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SaveError(`存档不是合法 JSON：${e.message}`);
  }

  const issues = validateSaveShape(raw);
  if (issues.length > 0) {
    throw new SaveError(`存档结构不合法：\n  - ${issues.join('\n  - ')}`, { issues });
  }

  const migrated = migrate(raw, options.migrations ?? MIGRATIONS);

  if (options.verifyHash !== false && migrated.stateHash) {
    const actual = hashState(migrated.state);
    if (actual !== migrated.stateHash) {
      throw new SaveError(
        `存档校验和不符，文件可能已损坏或被手工改动（期望 ${migrated.stateHash}，实得 ${actual}）`,
        { expected: migrated.stateHash, actual },
      );
    }
  }

  return migrated;
}

/* ------------------------------------------------------------------ *
 * 便捷入口
 * ------------------------------------------------------------------ */

/** 状态 → JSON 字符串 */
export function exportState(state, meta = {}, options = {}) {
  return serialize(makeSave(state, meta, options), options);
}

/** JSON 字符串 → 存档对象 */
export function importState(text, options = {}) {
  const save = deserialize(text, options);
  return { state: save.state, meta: save.meta, save };
}

/** 连同时间线一起导出（回档能力也一并保存） */
export function exportStore(store, meta = {}, options = {}) {
  return serialize(makeSave(store.getState(), meta, {
    ...options,
    timeline: store.allSnapshots(),
  }), options);
}

/** 读到 store 里，时间线一并恢复 */
export function importToStore(store, text, options = {}) {
  const save = deserialize(text, options);
  store.replace(save.state, save.timeline);
  return { state: store.getState(), meta: save.meta, save };
}

/** 存档摘要（给 UI 显示，不读全量状态） */
export function describeSave(save) {
  return {
    format: save.format,
    version: save.version,
    createdAt: save.createdAt,
    updatedAt: save.updatedAt,
    turn: save.state?.history?.length ?? 0,
    day: save.state?.clock?.day ?? null,
    slot: save.state?.clock?.slot ?? null,
    achievements: save.state?.achievements?.length ?? 0,
    endings: save.state?.endings?.length ?? 0,
    hasTimeline: Array.isArray(save.timeline) && save.timeline.length > 0,
    meta: { ...(save.meta ?? {}) },
  };
}
