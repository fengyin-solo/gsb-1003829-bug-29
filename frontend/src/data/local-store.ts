import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isEntryRows(value: unknown): value is Record<string, EntryRow[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every(
    (rows) => Array.isArray(rows) && rows.every((row) =>
      typeof row === 'object' && row !== null
      && typeof (row as EntryRow).id === 'number'
      && typeof (row as EntryRow).status === 'string',
    ),
  )
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    // 持久层被写坏（半截 JSON 之外的结构损坏）时回退种子，绝不把坏数据当空列表渲染。
    if (!isEntryRows(parsed)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
    // 以持久层为准，缺模块才补种子，避免旧版本缓存把新写入的模块冲掉。
    const merged = { ...fallback, ...parsed }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 其他标签页（例如另一个审核人）写了 localStorage 时，本页内存缓存立即失效，
// 否则旧缓存整块写回会覆盖别人已提交的审核结果。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function invalidateCache(): void {
  cache = null
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 绕过内存缓存强制回读持久层：审核事务提交前必须拿到最新数据做并发仲裁。
export function readRowsFresh(key: string): EntryRow[] {
  cache = null
  return listRows(key)
}

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    // 整块原子写：localStorage 的 setItem 本身是同步原子的，写完才更新内存缓存。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

// 带版本号乐观锁的原子更新：updater 基于最新持久层数据计算结果。
// 若 expectedVersion 与当前行版本不一致（已被别的事务改过），返回 null，调用方进入冲突处理。
export function commitRows<T>(
  key: string,
  id: number,
  expectedVersion: number,
  updater: (current: EntryRow) => EntryRow,
): { row: EntryRow } | null {
  const rows = readRowsFresh(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  const currentVersion = Number(rows[index]._version ?? 0)
  if (currentVersion !== expectedVersion) {
    return null
  }
  const updated: EntryRow = {
    ...updater(rows[index]),
    _version: currentVersion + 1,
  }
  const next = [...rows]
  next[index] = updated
  persist({ ...allRows(), [key]: next })
  return { row: updated }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
