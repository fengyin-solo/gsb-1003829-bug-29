<template>
  <section class="page" data-module="diary">
    <header class="page-head">
      <div>
        <h2>发掘日记管理</h2>
        <p class="page-desc">维护发掘日记，围绕日记编号、日期、当日气候、工作内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发掘日记</button>
        <button class="btn" type="button" @click="exportRows">导出发掘日记清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div v-if="notices.length" class="review-banner" role="alert">
      <p v-for="(notice, index) in notices" :key="index" class="banner-item" :class="notice.kind">
        <span class="banner-text">
          <strong>日记 {{ notice.diaryId }}</strong>：{{ notice.text }}
        </span>
        <button
          v-if="notice.action"
          class="link"
          type="button"
          @click="notice.action!"
        >
          {{ notice.actionLabel }}
        </button>
      </p>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>
            <span>{{ row.status }}</span>
            <span v-if="txOf(row.id)" class="tx-badge" :class="`tx-${txOf(row.id)!.status}`">
              {{ txLabel(txOf(row.id)!.status) }}
            </span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无发掘日记数据，可先登记发掘日记</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条发掘日记记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog.open" class="review-modal-mask" @click.self="closeDialog">
      <div class="review-modal" role="dialog" aria-modal="true" :aria-label="dialogTitle">
        <h3>{{ dialogTitle }}</h3>
        <p class="modal-sub">
          日记 {{ dialog.diaryId }} · 审核人：<strong>{{ dialog.tx?.reviewer }}</strong>
          <span v-if="dialog.resumed" class="resumed-hint">（断线续做，保留原审核人）</span>
        </p>

        <label class="modal-field">
          <span>主要发现<em v-if="dialog.tx?.action === '确认审核'"> *</em></span>
          <textarea
            v-model="dialog.findings"
            rows="3"
            placeholder="确认审核时必须填写主要发现"
            :disabled="dialog.busy"
          ></textarea>
        </label>
        <label class="modal-field">
          <span>退回理由<em v-if="dialog.tx?.action === '退回补充'"> *</em></span>
          <textarea
            v-model="dialog.returnReason"
            rows="3"
            placeholder="退回补充时必须填写退回理由"
            :disabled="dialog.busy"
          ></textarea>
        </label>

        <p v-if="dialog.message" class="dialog-message" :class="{ 'error-text': !dialog.ok }">
          {{ dialog.message }}
        </p>

        <div class="modal-actions">
          <button class="btn" type="button" :disabled="dialog.busy" @click="saveDraft">保存草稿</button>
          <button class="btn primary" type="button" :disabled="dialog.busy" @click="submitReview">
            {{ dialog.busy ? '提交中…' : '提交审核结果' }}
          </button>
          <button class="btn ghost" type="button" :disabled="dialog.busy" @click="abandonDraft">放弃草稿</button>
          <button class="btn ghost" type="button" :disabled="dialog.busy" @click="closeDialog">关闭</button>
        </div>
        <p class="modal-tip">草稿与提交分两阶段落盘，中途断线后重新进入会从提交中断处续做，不会写入空白审核。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  discardDraft,
  dismissStaleTx,
  finalizeReview,
  listDiaries,
  recoverReviewTransactions,
  saveReviewDraft,
  startReview,
  submitDiary,
  type ReviewAction,
} from '@/api/diary-service'
import { readReviewDoc } from '@/data/review-store'
import type { ReviewTx } from '@/data/review-store'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('diary')
const session = useSessionStore()
// 最后一列「日记状态」已由独立的「当前状态」列展示，避免重复。
const columns = meta.fields.filter((field) => field !== '日记状态')
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const activeTxs = ref<ReviewTx[]>([])

type NoticeKind = 'info' | 'success' | 'warn'
type Notice = { diaryId: number; text: string; kind: NoticeKind; actionLabel?: string; action?: () => void }
const notices = ref<Notice[]>([])

const stats = computed(() => [
  { label: '日记总数', value: rows.value.length },
  { label: '已审核数', value: rows.value.filter((row) => String(row.status) === '已审核').length },
  { label: '待审核数', value: rows.value.filter((row) => String(row.status) === '待审核').length },
])

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  return value === undefined || value === null || String(value) === '' ? '—' : String(value)
}

function txOf(id: number): ReviewTx | undefined {
  return activeTxs.value.find((tx) => tx.diaryId === id)
}

function txLabel(status: ReviewTx['status']): string {
  switch (status) {
    case 'draft':
      return '审核草稿'
    case 'finalizing':
      return '提交中断·可续做'
    case 'conflict':
      return '审核冲突'
    case 'broken':
      return '事务中断'
    default:
      return ''
  }
}

function actionsFor(row: EntryRow): string[] {
  const tx = txOf(row.id)
  if (tx) {
    if (tx.status === 'draft') {
      return ['继续审核']
    }
    if (tx.status === 'finalizing') {
      return ['继续提交']
    }
    return []
  }
  switch (String(row.status)) {
    case '已录入':
    case '需补充':
      return ['提交审核']
    case '待审核':
      return ['确认审核', '退回补充']
    default:
      return []
  }
}

function refreshTxs(): void {
  activeTxs.value = readReviewDoc().active
}

function buildNotices(): void {
  const result = recoverReviewTransactions()
  refreshTxs()
  const next: Notice[] = []
  for (const item of result.resumed) {
    next.push({
      diaryId: item.tx.diaryId,
      kind: 'success',
      text: `「${item.tx.action}」此前在提交阶段中断，已自动续做完成（审核人：${item.tx.reviewer}）。`,
    })
  }
  for (const tx of result.drafts) {
    next.push({
      diaryId: tx.diaryId,
      kind: 'info',
      text: `存在未提交的「${tx.action}」草稿（审核人：${tx.reviewer}），内容已保留，可继续审核。`,
      actionLabel: '继续审核',
      action: () => openReviewWithTx(tx),
    })
  }
  for (const tx of [...result.conflicts, ...result.broken]) {
    next.push({
      diaryId: tx.diaryId,
      kind: 'warn',
      text: tx.note ?? `「${tx.action}」事务处于${txLabel(tx.status)}状态，本动作未生效。`,
      actionLabel: '清除记录',
      action: () => {
        const cleared = dismissStaleTx(tx.txId)
        errorMessage.value = cleared.message
        reload()
      },
    })
  }
  notices.value = next
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '发掘日记登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交审核') {
    const result = submitDiary(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    errorMessage.value = result.message
    reload()
    return
  }
  if (action === '继续审核' || action === '继续提交') {
    const tx = txOf(row.id)
    if (tx) {
      openReviewWithTx(tx)
    }
    return
  }
  openReview(action as ReviewAction, row)
}

const dialog = reactive({
  open: false,
  busy: false,
  diaryId: 0,
  tx: null as ReviewTx | null,
  findings: '',
  returnReason: '',
  resumed: false,
  ok: true,
  message: '',
})

const dialogTitle = computed(() => {
  if (!dialog.tx) {
    return '发掘日记审核'
  }
  return dialog.tx.action === '确认审核' ? '确认审核' : '退回补充'
})

function fillDialog(tx: ReviewTx, resumed: boolean, message = '') {
  dialog.open = true
  dialog.busy = false
  dialog.diaryId = tx.diaryId
  dialog.tx = tx
  dialog.findings = tx.findings
  dialog.returnReason = tx.returnReason
  dialog.resumed = resumed
  dialog.ok = true
  dialog.message = message
}

function openReview(action: ReviewAction, row: EntryRow) {
  errorMessage.value = ''
  dialog.message = ''
  const result = startReview(Number(row.id), action, session.operator)
  if (!result.ok || !result.data) {
    errorMessage.value = result.message
    return
  }
  fillDialog(result.data.tx, result.data.resumed ?? false, result.data.resumed ? result.message : '')
  dialog.ok = true
}

function openReviewWithTx(tx: ReviewTx) {
  // 续做一律以事务日志里的审核人为准，不替换成当前登录人。
  fillDialog(tx, true, `已恢复「${tx.action}」草稿，审核人仍为「${tx.reviewer}」`)
}

function closeDialog() {
  dialog.open = false
  dialog.tx = null
  dialog.busy = false
  dialog.message = ''
  reload()
}

function syncTx(message: string, ok: boolean) {
  if (!dialog.tx) {
    return
  }
  const latest = readReviewDoc().active.find((item) => item.txId === dialog.tx!.txId) ?? null
  dialog.tx = latest
  dialog.message = message
  dialog.ok = ok
}

function saveDraft() {
  if (!dialog.tx) {
    return
  }
  dialog.busy = true
  const result = saveReviewDraft(dialog.tx.txId, {
    findings: dialog.findings,
    returnReason: dialog.returnReason,
  })
  dialog.busy = false
  if (!result.ok) {
    syncTx(result.message, false)
    return
  }
  if (result.data) {
    dialog.tx = result.data.tx
  }
  syncTx('草稿已保存', true)
  refreshTxs()
}

function submitReview() {
  if (!dialog.tx) {
    return
  }
  dialog.busy = true
  const result = finalizeReview(dialog.tx.txId, {
    findings: dialog.findings,
    returnReason: dialog.returnReason,
  })
  dialog.busy = false
  if (!result.ok) {
    syncTx(result.message, false)
    // 冲突已落为明确终态：关闭弹窗，列表与横幅展示冲突记录。
    refreshTxs()
    const latest = txOf(dialog.diaryId)
    if (latest && (latest.status === 'conflict' || latest.status === 'broken')) {
      dialog.open = false
      buildNotices()
      reload()
    }
    return
  }
  dialog.open = false
  dialog.tx = null
  errorMessage.value = result.message
  buildNotices()
  reload()
}

function abandonDraft() {
  if (!dialog.tx) {
    return
  }
  const result = discardDraft(dialog.tx.txId)
  if (!result.ok) {
    syncTx(result.message, false)
    return
  }
  dialog.open = false
  dialog.tx = null
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listDiaries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshTxs()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发掘日记列表读取失败'
  }
}

onMounted(() => {
  // 先恢复审核事务现场，再取数：中断的提交会先续做，列表读到的就是最终一致状态。
  buildNotices()
  reload()
})
</script>

<style scoped>
.tx-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;
}
.tx-draft {
  background: #eef4ff;
  color: #2b5cb8;
}
.tx-finalizing {
  background: #fff4e0;
  color: #b26a00;
}
.tx-conflict,
.tx-broken {
  background: #fdecec;
  color: #b3261e;
}
.muted {
  color: #999;
}
.review-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 12px;
}
.banner-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}
.banner-item.info {
  background: #eef4ff;
}
.banner-item.success {
  background: #e9f7ee;
}
.banner-item.warn {
  background: #fdecec;
}
.review-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.review-modal {
  width: 520px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.review-modal h3 {
  margin: 0 0 6px;
}
.modal-sub {
  margin: 0 0 14px;
  font-size: 13px;
  color: #555;
}
.resumed-hint {
  color: #b26a00;
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
}
.modal-field em {
  color: #b3261e;
  font-style: normal;
}
.modal-field textarea {
  resize: vertical;
  padding: 8px;
  border: 1px solid #d0d5dd;
  border-radius: 6px;
  font: inherit;
}
.modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dialog-message {
  margin: 4px 0 10px;
  font-size: 13px;
}
.modal-tip {
  margin: 12px 0 0;
  font-size: 12px;
  color: #888;
}
</style>
