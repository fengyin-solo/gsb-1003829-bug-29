import { listEntries } from '@/api/local-service'
import {
  archiveReviewTx,
  findActiveTx,
  getReviewTx,
  insertReviewTx,
  readReviewDoc,
  updateReviewTx,
} from '@/data/review-store'
import { commitRows, readRowsFresh, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'
import type { ReviewTx } from '@/data/review-store'

/**
 * 发掘日记审核专用服务。
 *
 * 与通用 runAction 不同，这里把审核建模成可恢复的事务（WAL 见 data/review-store.ts）：
 * 提交审核只做受保护的状态流转；确认/退回必须经「开始事务 → 草稿 → 提交中 → 写回业务行」
 * 四个阶段，任何阶段断线都能从最后落盘位置续做，且提交前强制回读持久层做版本仲裁。
 */
export const DIARY_KEY = 'diary'

export type ReviewAction = '确认审核' | '退回补充'

export type ReviewOutcome = {
  tx: ReviewTx
  resumed?: boolean
}

export type RecoveryReport = {
  drafts: ReviewTx[]
  resumed: { tx: ReviewTx; result: ActionResult }[]
  conflicts: ReviewTx[]
  broken: ReviewTx[]
}

const STATUS_SUBMITTED = '待审核'
const STATUS_APPROVED = '已审核'
const STATUS_RETURNED = '需补充'

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function timestamp(): string {
  const d = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function actionOfStatus(status: string): string {
  if (status === STATUS_APPROVED) {
    return '确认审核'
  }
  if (status === STATUS_RETURNED) {
    return '退回补充'
  }
  return `流转到「${status}」`
}

/**
 * 旧数据自愈：只处理「明显被中断写坏」的记录——已审核却没有主要发现（空白审核）。
 * 这类记录退回待审核重新走流程，绝不保留空白的已审核记录；缺字段的老数据不臆造审核人。
 */
function migrateDiaryRows(): EntryRow[] {
  const rows = readRowsFresh(DIARY_KEY)
  let changed = false
  const repaired = rows.map((row) => {
    const next: EntryRow = { ...row }
    if (next._version === undefined) {
      next._version = 0
      changed = true
    }
    const findings = String(next.主要发现 ?? '').trim()
    if (String(next.status) === STATUS_APPROVED && findings === '') {
      next.status = STATUS_SUBMITTED
      next.pending = true
      next.abnormal = false
      next.审核人 = ''
      next.审核时间 = ''
      next.退回理由 = ''
      changed = true
    }
    return next
  })
  if (changed) {
    saveRows(DIARY_KEY, repaired)
    return repaired
  }
  return rows
}

export function listDiaries(filters: Record<string, string> = {}): PageResult {
  migrateDiaryRows()
  return listEntries(DIARY_KEY, filters)
}

/** 提交审核：仅允许从已录入/需补充进入待审核，受版本保护的原子流转。 */
export function submitDiary(id: number): ActionResult {
  const rows = readRowsFresh(DIARY_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的发掘日记`)
  }
  const status = String(row.status)
  if (status === STATUS_SUBMITTED) {
    return fail('该日记已在待审核队列，不用重复提交')
  }
  if (status === STATUS_APPROVED || status === '已归档') {
    return fail(`日记当前状态为「${status}」，不能再提交审核`)
  }
  if (status !== '已录入' && status !== STATUS_RETURNED) {
    return fail(`日记当前状态为「${status}」，不能提交审核`)
  }
  if (findActiveTx(id)) {
    return fail('该日记存在未完成的审核事务，请先结束该事务后再提交')
  }
  const result = commitRows(DIARY_KEY, id, Number(row._version ?? 0), (current) => ({
    ...current,
    status: STATUS_SUBMITTED,
    pending: true,
    abnormal: false,
  }))
  if (!result) {
    return fail('日记刚被其他人改动过，请刷新列表后再提交')
  }
  return ok('日记已提交审核，等待审核人确认或退回')
}

/**
 * 开始审核：已有进行中事务时直接续做，并保留原审核人（跨页面/断线续做）。
 * 返回 resumed=true 表示复用了旧事务，页面应按事务里的动作和审核人打开。
 */
export function startReview(id: number, action: ReviewAction, reviewer: string): ActionResult & { data?: ReviewOutcome } {
  if (!reviewer.trim()) {
    return fail('当前没有审核人信息，无法开始审核')
  }
  const active = findActiveTx(id)
  if (active) {
    const message = active.action === action
      ? `该日记存在未完成的「${active.action}」事务，已按原审核人「${active.reviewer}」续做`
      : `该日记已有进行中的「${active.action}」事务（审核人：${active.reviewer}），请先完成或放弃该事务`
    return { ok: active.action === action, message, data: { tx: active, resumed: true } }
  }
  const rows = readRowsFresh(DIARY_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的发掘日记`)
  }
  if (String(row.status) !== STATUS_SUBMITTED) {
    return fail(`日记当前状态为「${row.status}」，只有待审核日记可以执行${action}`)
  }
  const now = Date.now()
  const tx: ReviewTx = {
    txId: `rv-${id}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    diaryId: id,
    action,
    reviewer: reviewer.trim(),
    // 预填已有内容：确认审核时主要发现来自日记原文，绝不以空白表单覆盖。
    findings: String(row.主要发现 ?? ''),
    returnReason: String(row.退回理由 ?? ''),
    baseVersion: Number(row._version ?? 0),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }
  insertReviewTx(tx)
  return { ok: true, message: `已开始${action}，填写内容会先存为草稿`, data: { tx, resumed: false } }
}

/** 保存草稿：只写事务日志，不碰业务行；提交中的事务锁定，草稿不会被空白表单覆盖。 */
export function saveReviewDraft(
  txId: string,
  patch: { findings?: string; returnReason?: string },
): ActionResult & { data?: ReviewOutcome } {
  const tx = getReviewTx(txId)
  if (!tx) {
    return fail('审核事务不存在或已结束')
  }
  if (tx.status === 'finalizing') {
    return fail('审核正在提交中，草稿已锁定')
  }
  if (tx.status === 'conflict' || tx.status === 'broken') {
    return fail(tx.note ?? '审核事务已中断，不能再保存草稿')
  }
  const next = updateReviewTx(txId, {
    status: 'draft',
    findings: patch.findings ?? tx.findings,
    returnReason: patch.returnReason ?? tx.returnReason,
  })
  if (!next) {
    return fail('草稿保存失败：事务日志写入失败，请重试')
  }
  return { ok: true, message: '审核草稿已保存，断线或离开页面后都可继续', data: { tx: next } }
}

function appliedBySameTx(row: EntryRow, tx: ReviewTx): boolean {
  if (String(row.审核人 ?? '') !== tx.reviewer) {
    return false
  }
  if (tx.action === '确认审核') {
    return String(row.status) === STATUS_APPROVED
      && String(row.主要发现 ?? '') === tx.findings
  }
  return String(row.status) === STATUS_RETURNED
    && String(row.退回理由 ?? '') === tx.returnReason
}

function conflictTx(tx: ReviewTx, row: EntryRow | null): ReviewTx {
  const note = row
    ? `该日记已由审核人「${String(row.审核人 ?? '').trim() || '其他审核人'}」`
      + `完成「${actionOfStatus(String(row.status))}」，你发起的「${tx.action}」未生效`
    : '该日记已不存在，审核事务无法继续'
  const next = updateReviewTx(tx.txId, { status: 'conflict', note })
  return next ?? { ...tx, status: 'conflict', note }
}

/**
 * 提交审核结果（可重入，支持断线续做）：
 * 1. 先在内存校验非空（空白内容停留在草稿态，不进入提交阶段）；
 * 2. 事务置 finalizing 并落盘——失败位置即从此处续做；
 * 3. 强制回读持久层，按 baseVersion 乐观锁仲裁并发；
 * 4. 只显式合并审核字段，退回时保留主要发现，绝不写入空白值；
 * 5. 成功后事务归档。
 */
export function finalizeReview(
  txId: string,
  input: { findings?: string; returnReason?: string } = {},
): ActionResult & { data?: ReviewOutcome } {
  const existed = getReviewTx(txId)
  if (!existed) {
    return fail('审核事务不存在或已结束，请勿重复提交')
  }
  if (existed.status === 'conflict') {
    return fail(existed.note ?? '该审核事务已处于冲突状态')
  }
  if (existed.status === 'broken') {
    return fail(existed.note ?? '该审核事务已中断，无法自动恢复')
  }

  let tx = existed
  const findings = (input.findings ?? tx.findings).trim()
  const returnReason = (input.returnReason ?? tx.returnReason).trim()
  const reviewer = tx.reviewer.trim()

  // 非空校验在推进阶段之前：校验不过仍是草稿，业务行一字不动。
  if (!reviewer) {
    return fail('审核人为空，无法提交审核')
  }
  if (tx.action === '确认审核' && !findings) {
    return fail('请先填写主要发现，不能以空白内容确认审核')
  }
  if (tx.action === '退回补充' && !returnReason) {
    return fail('请先填写退回理由，不能以空白理由退回日记')
  }

  const target = tx.action === '确认审核' ? STATUS_APPROVED : STATUS_RETURNED

  // WAL：提交阶段先落盘。若此前已是 finalizing（断线续做），内容以日志为准。
  if (tx.status !== 'finalizing') {
    const marked = updateReviewTx(txId, { status: 'finalizing', findings, returnReason })
    if (!marked) {
      return fail('提交失败：审核事务日志无法写入，请重试')
    }
    tx = marked
  }

  const finishAsConflict = (row: EntryRow | null): ActionResult & { data?: ReviewOutcome } => {
    const conflicted = conflictTx(tx, row)
    return { ok: false, message: conflicted.note ?? '审核冲突', data: { tx: conflicted } }
  }

  const classifyAndCommit = (): ActionResult & { data?: ReviewOutcome } => {
    const rows = readRowsFresh(DIARY_KEY)
    const row = rows.find((item) => Number(item.id) === tx.diaryId)
    if (!row) {
      const broken = updateReviewTx(tx.txId, {
        status: 'broken',
        note: '日记记录已不存在，审核事务中断',
      })
      return { ok: false, message: '日记记录已不存在，审核事务中断', data: broken ? { tx: broken } : undefined }
    }

    const status = String(row.status)
    if (status === target) {
      // 可能是本事务上次写回成功后、归档前断线：幂等识别，直接续完。
      if (appliedBySameTx(row, tx)) {
        archiveReviewTx(tx.txId, { status: 'done', findings, returnReason })
        const done = getReviewTx(tx.txId) ?? { ...tx, status: 'done' as const, findings, returnReason }
        return { ok: true, message: '检测到审核结果此前已写回，事务已续做完成', data: { tx: done, resumed: true } }
      }
      return finishAsConflict(row)
    }
    if (status !== STATUS_SUBMITTED) {
      return finishAsConflict(row)
    }

    const stamp = timestamp()
    const result = commitRows(DIARY_KEY, tx.diaryId, tx.baseVersion, (current) => {
      if (tx.action === '确认审核') {
        return {
          ...current,
          主要发现: findings,
          退回理由: '',
          审核人: reviewer,
          审核时间: stamp,
          status: STATUS_APPROVED,
          pending: false,
          abnormal: false,
        }
      }
      // 退回补充：只写退回理由与审核留痕，主要发现原样保留。
      return {
        ...current,
        退回理由: returnReason,
        审核人: reviewer,
        审核时间: stamp,
        status: STATUS_RETURNED,
        pending: true,
        abnormal: false,
      }
    })

    if (!result) {
      // 版本不一致：回读最新行，判定为已被他人完成或其他冲突。
      const latest = readRowsFresh(DIARY_KEY).find((item) => Number(item.id) === tx.diaryId) ?? null
      if (latest && String(latest.status) === target && appliedBySameTx(latest, tx)) {
        archiveReviewTx(tx.txId, { status: 'done', findings, returnReason })
        return ok('检测到审核结果此前已写回，事务已续做完成')
      }
      return finishAsConflict(latest)
    }

    archiveReviewTx(tx.txId, { status: 'done', findings, returnReason })
    return ok(tx.action === '确认审核'
      ? `日记已确认审核，审核人「${reviewer}」`
      : `日记已退回补充，退回理由已留存，审核人「${reviewer}」`)
  }

  return classifyAndCommit()
}

/** 放弃自己尚未提交的草稿（提交中的事务不允许放弃，只能续做完成）。 */
export function discardDraft(txId: string): ActionResult {
  const tx = getReviewTx(txId)
  if (!tx) {
    return fail('审核事务不存在或已结束')
  }
  if (tx.status === 'finalizing') {
    return fail('审核正在提交中，不能放弃，请等待提交结果或断线后续做')
  }
  if (tx.status === 'conflict' || tx.status === 'broken') {
    return fail('请使用「清除冲突记录」处理该事务')
  }
  archiveReviewTx(txId, { status: 'broken', note: '草稿已被审核人主动放弃' })
  return ok('审核草稿已放弃')
}

/** 清除已明确终结的冲突/损坏记录，消除残留。 */
export function dismissStaleTx(txId: string): ActionResult {
  const tx = getReviewTx(txId)
  if (!tx) {
    return ok('残留记录已清除')
  }
  if (tx.status !== 'conflict' && tx.status !== 'broken') {
    return fail('只有冲突或中断的事务可以清除')
  }
  archiveReviewTx(txId, {})
  return ok('残留事务记录已清除')
}

/**
 * 进入日记页时恢复事务现场：
 * - finalizing：自动从失败位置继续提交（幂等）；
 * - draft：日记仍处于待审核且未被改动则保留为可续做草稿，否则按冲突/损坏显式标出；
 * - conflict/broken：原样暴露给页面提示，等待清除。
 */
export function recoverReviewTransactions(): RecoveryReport {
  const doc = readReviewDoc()
  const report: RecoveryReport = { drafts: [], resumed: [], conflicts: [], broken: [] }

  for (const tx of doc.active) {
    if (tx.status === 'finalizing') {
      const result = finalizeReview(tx.txId)
      const latest = getReviewTx(tx.txId)
      if (result.ok) {
        report.resumed.push({ tx: latest ?? { ...tx, status: 'done' }, result })
      } else if (latest?.status === 'broken') {
        report.broken.push(latest)
      } else {
        report.conflicts.push(latest ?? tx)
      }
      continue
    }
    if (tx.status === 'conflict') {
      report.conflicts.push(tx)
      continue
    }
    if (tx.status === 'broken') {
      report.broken.push(tx)
      continue
    }

    const row = readRowsFresh(DIARY_KEY).find((item) => Number(item.id) === tx.diaryId)
    if (!row) {
      const broken = updateReviewTx(tx.txId, {
        status: 'broken',
        note: '日记记录已不存在，审核草稿无法继续',
      })
      if (broken) {
        report.broken.push(broken)
      }
      continue
    }
    const version = Number(row._version ?? 0)
    if (String(row.status) !== STATUS_SUBMITTED || version !== tx.baseVersion) {
      const conflicted = conflictTx(tx, row)
      report.conflicts.push(conflicted)
      continue
    }
    report.drafts.push(tx)
  }

  return report
}
