import { mutateRows, tableSnapshot } from './local-store'
import type {
  DiaryActionResult,
  DiaryAuditFields,
  DiaryReviewDraft,
  EntryRow,
} from './types'

// 发掘日记审核专用流程。通用 runAction 只改状态，不承担审核意见写回、事务续做与并发裁决；
// 日记页的提交/审核/退回统一走这里。
const MODULE_KEY = 'diary'
const DRAFTS_KEY = 'field-archaeology-digital:diary-review-drafts'

const STATUS_RECORDED = '已录入'
const STATUS_PENDING = '待审核'
const STATUS_NEED_MORE = '需补充'
const STATUS_APPROVED = '已审核'
const FINAL_STATUSES = [STATUS_APPROVED, STATUS_NEED_MORE]

export function timestamp(): string {
  return new Date().toISOString()
}

function createToken(reviewer: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `rev-${Date.now().toString(36)}-${random}-${reviewer}`
}

// ---- 审核草稿（事务意图）的持久化：与业务表分开存，写回失败不会污染业务数据 ----

function readDrafts(): DiaryReviewDraft[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(DRAFTS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    // 只认领结构完整的草稿，残缺条目直接忽略，不让它盖掉正常记录。
    return parsed.filter(
      (item): item is DiaryReviewDraft =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.id === 'number' &&
        typeof item.token === 'string' &&
        typeof item.reviewer === 'string' &&
        (item.action === '确认审核' || item.action === '退回补充') &&
        (item.stage === 'drafting' || item.stage === 'staged' || item.stage === 'conflict'),
    )
  } catch {
    return []
  }
}

function writeDrafts(drafts: DiaryReviewDraft[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先序列化再写：序列化失败不触碰已有数据。
  window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
}

function saveDraft(draft: DiaryReviewDraft): DiaryReviewDraft {
  const drafts = readDrafts()
  const index = drafts.findIndex((item) => item.token === draft.token)
  if (index >= 0) {
    drafts[index] = draft
  } else {
    drafts.push(draft)
  }
  writeDrafts(drafts)
  return draft
}

function removeDraft(token: string): DiaryReviewDraft | undefined {
  const drafts = readDrafts()
  const index = drafts.findIndex((item) => item.token === token)
  if (index < 0) {
    return undefined
  }
  const [removed] = drafts.splice(index, 1)
  writeDrafts(drafts)
  return removed
}

function dropDraftsFor(id: number): DiaryReviewDraft[] {
  const drafts = readDrafts()
  const removed = drafts.filter((item) => item.id === id)
  if (removed.length === 0) {
    return []
  }
  writeDrafts(drafts.filter((item) => item.id !== id))
  return removed
}

export function listDiaryDrafts(): DiaryReviewDraft[] {
  return readDrafts()
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function fail(message: string, extra: Partial<DiaryActionResult> = {}): DiaryActionResult {
  return { ok: false, message, ...extra }
}

// ---- 提交审核：已录入 -> 待审核。顺带清理这一条上已经作废的草稿/冲突标记 ----

export function submitDiaryForReview(id: number): DiaryActionResult {
  const { rows, version } = tableSnapshot(MODULE_KEY)
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的发掘日记`)
  }
  const current = String(row.status)
  if (current === STATUS_PENDING) {
    return fail('发掘日记已提交，正在审核中，无需重复提交')
  }
  if (current !== STATUS_RECORDED && current !== STATUS_NEED_MORE) {
    return fail(`当前状态「${current}」不允许提交审核`)
  }
  const result = mutateRows(
    MODULE_KEY,
    (latest) =>
      latest.map((item) =>
        Number(item.id) === id
          ? {
              ...item,
              status: STATUS_PENDING,
              pending: true,
              abnormal: false,
              审核冲突: '',
            }
          : item,
      ),
    version,
  )
  if (!result.ok) {
    return fail('提交失败：期间有其他页面改动了日记列表，请刷新后重试', { conflict: true })
  }
  // 提交后旧草稿全部作废（含之前退回残留的填写内容），避免草稿状态残留。
  dropDraftsFor(id)
  return { ok: true, message: '发掘日记已提交审核，当前状态「待审核」' }
}

// ---- 开始审核：认领草稿（含跨页面续做），保证继续动作沿用原审核人 ----

export type BeginReviewResult = DiaryActionResult & {
  draft?: DiaryReviewDraft
  busyBy?: string
}

export function beginDiaryReview(
  id: number,
  action: DiaryReviewDraft['action'],
  reviewer: string,
): BeginReviewResult {
  const { rows } = tableSnapshot(MODULE_KEY)
  const row = findRow(rows, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的发掘日记`)
  }
  if (String(row.status) !== STATUS_PENDING) {
    return fail(`发掘日记当前为「${row.status}」，只有待审核状态可以审核`)
  }

  const drafts = readDrafts().filter((item) => item.id === id)

  // 1. 本人中断在写回环节的事务必须续完：无论从哪个动作入口进来，都回到原事务。
  const ownStaged = drafts.find(
    (item) => item.reviewer === reviewer && item.stage === 'staged',
  )
  if (ownStaged) {
    return {
      ok: true,
      message: `检测到审核在写回时中断，已为你（${ownStaged.reviewer}）从事务断点继续`,
      resumed: true,
      draft: ownStaged,
    }
  }

  // 2. 本人动作一致的填写中草稿：直接续做，审核人沿用草稿里的原审核人。
  const own = drafts.find(
    (item) => item.reviewer === reviewer && item.action === action && item.stage === 'drafting',
  )
  if (own) {
    return {
      ok: true,
      message: `已恢复你（${own.reviewer}）未提交的审核草稿`,
      resumed: true,
      draft: own,
    }
  }

  // 3. 别人留了未完成的审核（含中断在写回环节的 staged）：不阻止当前审核人发起自己的审核，
  //    但明确告知；写回时由版本号 CAS 裁决，先完成者生效，另一方进入冲突状态。
  const otherActive = drafts
    .filter((item) => item.reviewer !== reviewer && item.stage !== 'conflict')
    .sort((a, b) => (a.stage === 'staged' ? -1 : 1))[0]

  const now = timestamp()
  const draft: DiaryReviewDraft = {
    id,
    token: createToken(reviewer),
    action,
    findings: '',
    reason: '',
    reviewer,
    stage: 'drafting',
    createdAt: now,
    updatedAt: now,
  }
  saveDraft(draft)
  return {
    ok: true,
    message: otherActive
      ? `${otherActive.reviewer} 正在审核这条日记，写回时若双方同时提交，仅一个动作生效`
      : '审核草稿已建立，可填写审核内容',
    draft,
    busyBy: otherActive?.reviewer,
  }
}

// 暂存填写内容：不动业务表，空白允许保存（只是草稿），绝不把空白写成已审核。
export function saveDiaryDraft(
  token: string,
  payload: { findings: string; reason: string },
): DiaryActionResult {
  const drafts = readDrafts()
  const draft = drafts.find((item) => item.token === token)
  if (!draft) {
    return fail('审核草稿不存在或已失效，请重新进入审核')
  }
  if (draft.stage === 'conflict') {
    return fail('该审核已在并发冲突中失败，请先解除冲突再重新审核', { conflict: true })
  }
  if (draft.stage === 'staged') {
    // 已停在写回断点的事务不能退回填写阶段，否则中断点会丢失；请直接继续完成写回。
    return fail('审核已停在写回环节，请继续完成本次审核，不能再改成草稿', {
      resumed: true,
      draft,
    })
  }
  saveDraft({
    ...draft,
    findings: payload.findings,
    reason: payload.reason,
    stage: 'drafting',
    updatedAt: timestamp(),
  })
  return { ok: true, message: '审核草稿已暂存，可中断后回来继续' }
}

// ---- 审核写回：两段式事务 ----
// 阶段1：校验非空白 + 把意图标记为 staged（业务表尚未改动）；
// 阶段2：基于版本号的 CAS 写回，成功后清理草稿。阶段2失败则意图保留，下次进入可续做。

const CAS_RETRIES = 3

export function submitDiaryReview(
  token: string,
  payload?: { findings: string; reason: string },
): DiaryActionResult {
  const drafts = readDrafts()
  const existing = drafts.find((item) => item.token === token)
  if (!existing) {
    return fail('审核草稿不存在或已失效，请重新进入审核')
  }
  if (existing.stage === 'conflict') {
    return fail('该审核已在并发冲突中失败，请先解除冲突再重新审核', {
      conflict: true,
      draft: existing,
    })
  }

  // 续做时入参允许为空：以已暂存内容为准，绝不因重放入参为空而把空白写成已审核。
  const findings = payload ? payload.findings : existing.findings
  const reason = payload ? payload.reason : existing.reason
  const action = existing.action
  const target = action === '确认审核' ? STATUS_APPROVED : STATUS_NEED_MORE
  // 进入时已经是 staged：本次是断线后的事务续做，成功结果要带上续做标记。
  const resumed = existing.stage === 'staged'

  // 空白拦截：确认必须有主要发现，退回必须有理由；二者都不允许以空值落盘。
  if (action === '确认审核' && findings.trim() === '') {
    return fail('确认审核前必须填写主要发现，不能提交空白审核')
  }
  if (action === '退回补充' && reason.trim() === '') {
    return fail('退回补充前必须填写退回理由，不能提交空退回')
  }

  // 阶段1：暂存意图。已有 staged 说明上次就倒在这之后，保持原意图不变。
  if (existing.stage !== 'staged') {
    saveDraft({
      ...existing,
      findings,
      reason,
      stage: 'staged',
      updatedAt: timestamp(),
    })
  }
  const staged = { ...existing, findings, reason, stage: 'staged' as const }

  // 幂等快判：同一审核人同一动作已写回成功（上次其实已落盘，只是断在清理前）。
  const snapshot = tableSnapshot(MODULE_KEY)
  const currentRow = findRow(snapshot.rows, existing.id)
  if (!currentRow) {
    return fail(`编号为 ${existing.id} 的发掘日记已不存在`)
  }
  if (
    String(currentRow.status) === target &&
    (currentRow as DiaryAuditFields).审核令牌 === existing.token
  ) {
    removeDraft(existing.token)
    return { ok: true, message: `审核此前已写回，已继续完成事务：当前状态「${target}」`, resumed: true }
  }

  // 阶段2：CAS 写回。仅在无人插队时成功；被其他终态动作插队则进入明确冲突状态。
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { rows, version } = tableSnapshot(MODULE_KEY)
    const row = findRow(rows, existing.id)
    if (!row) {
      return fail(`编号为 ${existing.id} 的发掘日记已不存在`)
    }
    const status = String(row.status)
    if (status === target && (row as DiaryAuditFields).审核令牌 === existing.token) {
      removeDraft(existing.token)
      return { ok: true, message: `审核此前已写回，已继续完成事务：当前状态「${target}」`, resumed: true }
    }
    if (FINAL_STATUSES.includes(status)) {
      return markConflict(
        existing,
        `冲突：你要「${action}」时，该日记已被${(row as DiaryAuditFields).审核人 ?? '另一审核人'}处理为「${status}」，本次动作未生效`,
      )
    }
    if (status !== STATUS_PENDING) {
      return markConflict(
        existing,
        `冲突：日记当前状态为「${status}」，不在待审核状态，本次「${action}」未生效`,
      )
    }

    const audit: DiaryAuditFields & EntryRow = {
      ...row,
      status: target,
      pending: target !== STATUS_APPROVED,
      abnormal: action === '退回补充',
      审核人: existing.reviewer,
      审核时间: timestamp(),
      审核令牌: existing.token,
      审核冲突: '',
    }
    if (action === '确认审核') {
      // 只有非空白的主要发现才允许覆盖，空值保留原值。
      audit.主要发现 = findings.trim()
      audit.退回理由 = ''
    } else {
      audit.退回理由 = reason.trim()
    }

    let result: ReturnType<typeof mutateRows>
    try {
      result = mutateRows(
        MODULE_KEY,
        (latest) =>
          latest.map((item) => (Number(item.id) === existing.id ? ({ ...item, ...audit } as EntryRow) : item)),
        version,
      )
    } catch {
      // 写盘失败（配额满/存储不可用/断线）：意图已在阶段1暂存，保持 staged 等下次续做。
      return {
        ok: false,
        message: '写回时本地存储失败，审核内容已暂存，再次进入将从断点继续',
        resumed: true,
        draft: staged,
      }
    }
    if (result.ok) {
      removeDraft(existing.token)
      return {
        ok: true,
        resumed,
        message: resumed
          ? `已从断线位置继续完成${action}，当前状态「${target}」，审核人：${existing.reviewer}`
          : `发掘日记已${action}，当前状态「${target}」，审核人：${existing.reviewer}`,
      }
    }
    // 版本失配：有跨页面写入，循环重读后判定是冲突还是可重试。
  }

  // CAS 多次失败：意图保持 staged，下次进入从事务断点继续，不丢任何已填内容。
  return {
    ok: false,
    message: '写回时检测到其他页面在并发修改，审核内容已暂存，请稍后继续完成',
    resumed: true,
    draft: staged,
  }
}

function markConflict(draft: DiaryReviewDraft, message: string): DiaryActionResult {
  // 冲突标记是追加信息：以磁盘最新行为准做无条件写，不能因为版本又变了把标记丢掉。
  mutateRows(MODULE_KEY, (latest) =>
    latest.map((item) =>
      Number(item.id) === draft.id ? { ...item, 审核冲突: `${draft.reviewer}：${message}` } : item,
    ),
  )
  // 无论冲突标记是否写上（极端并发），失败方草稿都进入 conflict 阶段，不再允许提交。
  saveDraft({ ...draft, stage: 'conflict', updatedAt: timestamp() })
  return {
    ok: false,
    conflict: true,
    message,
    draft: { ...draft, stage: 'conflict' },
  }
}

// 放弃填写中的草稿；staged 的中断事务不允许随手删，必须续做完或解除冲突。
export function cancelDiaryReview(token: string): DiaryActionResult {
  const drafts = readDrafts()
  const draft = drafts.find((item) => item.token === token)
  if (!draft) {
    return { ok: true, message: '草稿已清理' }
  }
  if (draft.stage === 'staged') {
    return fail('审核在写回环节中断，需先继续完成事务，不能直接丢弃')
  }
  removeDraft(token)
  return { ok: true, message: '审核草稿已放弃，记录仍为待审核' }
}

// 解除行级冲突：清掉冲突标记与失败方草稿，日记回到对方写回后的状态，再走正常流程。
export function dismissDiaryConflict(id: number, token?: string): DiaryActionResult {
  const drafts = readDrafts()
  const targetDrafts = drafts.filter(
    (item) =>
      item.id === id &&
      item.stage === 'conflict' &&
      (token === undefined || item.token === token),
  )
  if (targetDrafts.length > 0) {
    const tokens = new Set(targetDrafts.map((item) => item.token))
    writeDrafts(drafts.filter((item) => !tokens.has(item.token)))
  }
  const { rows, version } = tableSnapshot(MODULE_KEY)
  const row = findRow(rows, id)
  if (row && (row as DiaryAuditFields).审核冲突) {
    mutateRows(
      MODULE_KEY,
      (latest) =>
        latest.map((item) =>
          Number(item.id) === id ? { ...item, 审核冲突: '' } : item,
        ),
      version,
    )
  }
  return { ok: true, message: '冲突状态已解除，可按当前状态继续操作' }
}

// 页面重入时的事务恢复：把所有 staged 的意图从断点继续；冲突草稿原样保留待人工处理。
export function recoverDiaryReviews(): { resumed: number; conflicted: number } {
  let resumed = 0
  let conflicted = 0
  // 复制 token 列表，处理过程中草稿集合会变化。
  const staged = readDrafts().filter((item) => item.stage === 'staged')
  for (const draft of staged) {
    const result = submitDiaryReview(draft.token)
    if (result.ok) {
      resumed += 1
    } else if (result.conflict) {
      conflicted += 1
    }
  }
  return { resumed, conflicted }
}
