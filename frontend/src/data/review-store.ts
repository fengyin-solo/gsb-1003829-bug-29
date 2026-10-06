import type { ReviewAction } from '@/api/diary-service'

/**
 * 日记审核事务日志（WAL）。
 *
 * 审核不是「点一下按钮改状态」，而是一个跨阶段、可能断线的事务：
 *   1. 开始审核：落一条 draft 事务（原审核人在此固化，续做不再改人）；
 *   2. 填写表单：只更新事务里的草稿，绝不碰业务行；
 *   3. 提交：先把事务置为 finalizing（提交阶段已落盘），再校验非空、
 *      回读最新业务行做版本仲裁，最后才把审核结果合并写回业务行；
 *   4. 写回成功：事务归档到 history。
 * 任一步之后断线，重进页面都能凭这份日志续做或判定冲突，不会留下空白审核记录。
 */
const REVIEW_STORAGE_KEY = 'field-archaeology-digital:diary-review-tx'
const HISTORY_LIMIT = 50

export type ReviewTxStatus =
  | 'draft' // 草稿：表单内容已持久化，尚未提交
  | 'finalizing' // 已提交，正在把审核结果写回业务行（断线后可从此位置续做）
  | 'conflict' // 与并发事务冲突，本动作未生效
  | 'broken' // 事务记录损坏或引用的日记已不存在，等待人工处理
  | 'done' // 审核结果已写回业务行，归档在 history

export type ReviewTx = {
  txId: string
  diaryId: number
  action: ReviewAction
  reviewer: string
  findings: string
  returnReason: string
  /** 事务开启时业务行的版本号，提交时做乐观锁仲裁。 */
  baseVersion: number
  status: ReviewTxStatus
  createdAt: number
  updatedAt: number
  finalizedAt?: number
  /** 冲突或异常的明确说明，页面原样展示。 */
  note?: string
}

export type ReviewStoreDoc = {
  active: ReviewTx[]
  history: ReviewTx[]
}

function emptyDoc(): ReviewStoreDoc {
  return { active: [], history: [] }
}

function isReviewAction(value: unknown): value is ReviewAction {
  return value === '确认审核' || value === '退回补充'
}

function isTx(value: unknown): value is ReviewTx {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const tx = value as Record<string, unknown>
  return typeof tx.txId === 'string'
    && typeof tx.diaryId === 'number'
    && isReviewAction(tx.action)
    && typeof tx.reviewer === 'string'
    && typeof tx.findings === 'string'
    && typeof tx.returnReason === 'string'
    && typeof tx.baseVersion === 'number'
    && ['draft', 'finalizing', 'conflict', 'broken', 'done'].includes(String(tx.status))
    && typeof tx.createdAt === 'number'
    && typeof tx.updatedAt === 'number'
}

function isDoc(value: unknown): value is ReviewStoreDoc {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const doc = value as Record<string, unknown>
  return Array.isArray(doc.active) && Array.isArray(doc.history)
    && doc.active.every(isTx) && doc.history.every(isTx)
}

/** 读事务日志；结构损坏时不静默清空，先按空文档运行，坏记录由恢复逻辑兜底。 */
export function readReviewDoc(): ReviewStoreDoc {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyDoc()
  }
  const raw = window.localStorage.getItem(REVIEW_STORAGE_KEY)
  if (!raw) {
    return emptyDoc()
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isDoc(parsed)) {
      return emptyDoc()
    }
    return parsed
  } catch {
    return emptyDoc()
  }
}

/** 整块原子写事务日志。 */
export function writeReviewDoc(doc: ReviewStoreDoc): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(doc))
}

export function updateReviewTx(txId: string, patch: Partial<ReviewTx>): ReviewTx | null {
  const doc = readReviewDoc()
  const index = doc.active.findIndex((tx) => tx.txId === txId)
  if (index < 0) {
    return null
  }
  const next = { ...doc.active[index], ...patch, updatedAt: Date.now() }
  doc.active = [...doc.active]
  doc.active[index] = next
  writeReviewDoc(doc)
  return next
}

export function getReviewTx(txId: string): ReviewTx | null {
  const doc = readReviewDoc()
  return doc.active.find((tx) => tx.txId === txId) ?? null
}

/** 找到某条日记上尚未终结（草稿/提交中）的审核事务。 */
export function findActiveTx(diaryId: number): ReviewTx | null {
  const doc = readReviewDoc()
  return doc.active.find((tx) =>
    tx.diaryId === diaryId && (tx.status === 'draft' || tx.status === 'finalizing'),
  ) ?? null
}

export function insertReviewTx(tx: ReviewTx): void {
  const doc = readReviewDoc()
  doc.active = [...doc.active, tx]
  writeReviewDoc(doc)
}

/** 事务终态归档：已完成进 history（限量保留），冲突/废弃也从 active 摘掉。 */
export function archiveReviewTx(txId: string, patch: Partial<ReviewTx>): void {
  const doc = readReviewDoc()
  const index = doc.active.findIndex((tx) => tx.txId === txId)
  if (index < 0) {
    return
  }
  const finalized: ReviewTx = {
    ...doc.active[index],
    ...patch,
    updatedAt: Date.now(),
    finalizedAt: patch.finalizedAt ?? Date.now(),
  }
  doc.active = doc.active.filter((tx) => tx.txId !== txId)
  if (finalized.status === 'done') {
    doc.history = [finalized, ...doc.history].slice(0, HISTORY_LIMIT)
  }
  writeReviewDoc(doc)
}

export function reviewStorageKey(): string {
  return REVIEW_STORAGE_KEY
}
