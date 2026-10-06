import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

// 磁盘结构：版本号 + 各模块数据。版本号用于跨页面（多标签页）动作的并发裁决。
type StoredData = {
  version: number
  modules: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedData(): StoredData {
  return { version: 1, modules: clone(SEED_ROWS) }
}

function isModuleMap(value: unknown): value is Record<string, EntryRow[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every((item) => Array.isArray(item))
}

// 只在真正需要落盘时序列化；序列化或 setItem 失败都向外抛错，由业务层决定如何续做。
function persist(data: StoredData): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const serialized = JSON.stringify(data)
  window.localStorage.setItem(STORAGE_KEY, serialized)
}

function readStorage(): StoredData {
  const fallback = seedData()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 整盘 JSON 损坏：回退种子，绝不让页面读到空白结构。
    persist(fallback)
    return fallback
  }
  // 兼容旧版本：磁盘上直接是模块映射、没有 version/modules 外壳。
  const legacyModules =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('modules' in parsed)
      ? parsed
      : (parsed as { modules?: unknown } | null)?.modules
  if (!isModuleMap(legacyModules)) {
    persist(fallback)
    return fallback
  }
  // 逐模块校验：种子模块在磁盘上必须是"非空且每行带 id/status"的数组。
  // 空数组或行残缺都视为该模块写坏（典型就是断线后显示空白记录），只回退这一个模块。
  // 非种子模块（后续新增、可能合法为空）只要是数组就保留。
  function isSoundRows(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return false
    }
    return value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as EntryRow).id !== 'undefined' &&
        typeof (item as EntryRow).status !== 'undefined',
    )
  }
  const modules: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(SEED_ROWS)) {
    const stored = legacyModules[key]
    modules[key] =
      Array.isArray(stored) && stored.length > 0 && isSoundRows(stored)
        ? (stored as EntryRow[])
        : clone(SEED_ROWS[key])
  }
  for (const key of Object.keys(legacyModules)) {
    if (!(key in modules)) {
      modules[key] = legacyModules[key]
    }
  }
  const versionRaw = (parsed as { version?: unknown } | null)?.version
  return { version: typeof versionRaw === 'number' ? versionRaw : 1, modules }
}

// 不保留长生命周期缓存：每次都从磁盘读最新值，跨标签页/跨页面续做时才能看到对方的写入。
export function allRows(): Record<string, EntryRow[]> {
  return readStorage().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function tableSnapshot(key: string): { rows: EntryRow[]; version: number } {
  const data = readStorage()
  return { rows: data.modules[key] ?? [], version: data.version }
}

export type MutationResult =
  | { ok: true; version: number; rows: EntryRow[] }
  | { ok: false; reason: 'version-mismatch'; version: number; rows: EntryRow[] }

// 读-改-写一把完成：expectedVersion 与磁盘不一致说明期间有别的页面写过，
// 本次不写入，把裁决权交回调用方（用于审核确认/退回的冲突判定）。
export function mutateRows(
  key: string,
  updater: (rows: EntryRow[]) => EntryRow[],
  expectedVersion?: number,
): MutationResult {
  const current = readStorage()
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, reason: 'version-mismatch', version: current.version, rows: current.modules[key] ?? [] }
  }
  const nextRows = updater(clone(current.modules[key] ?? []))
  const next: StoredData = {
    version: current.version + 1,
    modules: { ...current.modules, [key]: nextRows },
  }
  // 先序列化（在 persist 内）再写盘；抛错时本函数没有任何内存状态可污染。
  persist(next)
  return { ok: true, version: next.version, rows: nextRows }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const result = mutateRows(key, () => rows)
  if (!result.ok) {
    // 无 expectedVersion 的全量写不应失败，保守处理为抛错，避免上层误以为已落盘。
    throw new Error(`模块 ${key} 写入失败：存储版本已变化`)
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
