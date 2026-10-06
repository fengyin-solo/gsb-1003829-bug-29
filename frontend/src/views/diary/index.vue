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

    <div v-if="resumeNotice" class="resume-banner">
      {{ resumeNotice }}
      <button class="link" type="button" @click="resumeNotice = ''">知道了</button>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="{ 'conflict-text': row.审核冲突 }">{{ row.status }}</span>
            <p v-if="row.审核冲突" class="conflict-note">{{ row.审核冲突 }}</p>
          </td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              :class="{ strong: action === '继续审核' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
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

    <div v-if="reviewModal.open" class="modal-mask" @click.self="closeModal">
      <div class="modal-card">
        <h3>{{ reviewModal.action }} · 日记 {{ reviewModal.diaryCode }}</h3>
        <p class="modal-tip">
          审核人：<strong>{{ reviewModal.reviewer }}</strong>
          <span v-if="reviewModal.resumed" class="resume-tag">已从事务断点恢复</span>
        </p>
        <p v-if="reviewModal.busyBy" class="warn-text">
          注意：{{ reviewModal.busyBy }} 也在审核这条日记；双方同时提交时只生效一个动作，另一方进入冲突状态。
        </p>
        <label class="modal-field">
          <span>主要发现（确认审核必填）</span>
          <textarea v-model="reviewModal.findings" rows="4" placeholder="填写本次审核确认的主要发现"></textarea>
        </label>
        <label class="modal-field">
          <span>退回理由（退回补充必填）</span>
          <textarea v-model="reviewModal.reason" rows="3" placeholder="退回时必须写明退回理由"></textarea>
        </label>
        <p v-if="reviewModal.modalError" class="error-text">{{ reviewModal.modalError }}</p>
        <div class="modal-actions">
          <template v-if="!reviewModal.resumed">
            <button class="btn" type="button" @click="persistDraft">暂存草稿</button>
            <button class="btn ghost" type="button" @click="abandonDraft">放弃草稿</button>
          </template>
          <button class="btn primary" type="button" @click="commitReview">
            {{ reviewModal.action }}
          </button>
        </div>
        <p class="modal-hint">
          {{
            reviewModal.resumed
              ? '这是断线后从事务断点的续做，审核人沿用原审核人，提交后才会完成事务。'
              : '中途离开可随时暂存；写回若中断，再次进入会按当前审核人自动继续。'
          }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  beginDiaryReview,
  cancelDiaryReview,
  dismissDiaryConflict,
  downloadEntries,
  listEntries,
  listDiaryDrafts,
  moduleMeta,
  recoverDiaryReviews,
  saveDiaryDraft,
  submitDiaryForReview,
  submitDiaryReview,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { DiaryReviewDraft, EntryRow } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('diary')
const columns = ["日记编号", "日期", "当日气候", "工作内容", "主要发现", "参与人员", "记录人", "审核人", "审核时间", "退回理由"]
const statuses = ["已录入", "待审核", "需补充", "已审核", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const resumeNotice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '日记总数', value: rows.value.length },
  { label: '已审核数', value: rows.value.filter((row) => String(row.status) === '已审核').length },
  { label: '待审核数', value: rows.value.filter((row) => String(row.status) === '待审核').length },
])

const reviewModal = reactive({
  open: false,
  token: '',
  diaryId: 0,
  diaryCode: '',
  action: '确认审核' as DiaryReviewDraft['action'],
  findings: '',
  reason: '',
  reviewer: '',
  resumed: false,
  busyBy: '',
  modalError: '',
})

function ownDraftsOf(row: EntryRow): DiaryReviewDraft[] {
  return listDiaryDrafts()
    .filter(
      (draft) =>
        draft.id === Number(row.id) &&
        draft.reviewer === session.operator &&
        draft.stage !== 'conflict',
    )
    .sort((a, b) => (a.stage === 'staged' ? -1 : 0) || (a.updatedAt < b.updatedAt ? 1 : -1))
}

function rowActions(row: EntryRow): string[] {
  if (row.审核冲突) {
    return ['解除冲突']
  }
  const status = String(row.status)
  if (status === '已录入' || status === '需补充') {
    return ['提交审核']
  }
  if (status === '待审核') {
    return ownDraftsOf(row).length > 0
      ? ['继续审核', '确认审核', '退回补充']
      : ['确认审核', '退回补充']
  }
  return []
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
    const result = submitDiaryForReview(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
    return
  }
  if (action === '解除冲突') {
    const result = dismissDiaryConflict(Number(row.id))
    errorMessage.value = result.ok ? '' : result.message
    reload()
    return
  }
  if (action === '退回补充' || action === '确认审核') {
    openReview(row, action)
    return
  }
  // 继续审核：沿用草稿里原来的动作（确认/退回），不允许入口改动作。
  if (action === '继续审核') {
    const draft = ownDraftsOf(row)[0]
    if (!draft) {
      errorMessage.value = '未找到待继续的审核草稿'
      reload()
      return
    }
    openReview(row, draft.action, draft.token)
  }
}

function openReview(row: EntryRow, action: DiaryReviewDraft['action'], tokenHint?: string) {
  const result = beginDiaryReview(Number(row.id), action, session.operator)
  if (!result.ok || !result.draft) {
    errorMessage.value = result.message
    reload()
    return
  }
  const draft = result.draft
  // 续做时以草稿动作与原审核人为准（跨页面事务续做保留原审核人）。
  const effectiveAction = tokenHint && draft.token === tokenHint ? draft.action : action
  reviewModal.open = true
  reviewModal.token = draft.token
  reviewModal.diaryId = Number(row.id)
  reviewModal.diaryCode = String(row['日记编号'] ?? row.id)
  reviewModal.action = effectiveAction
  reviewModal.findings = draft.findings
  reviewModal.reason = draft.reason
  reviewModal.reviewer = draft.reviewer
  reviewModal.resumed = Boolean(result.resumed)
  reviewModal.busyBy = (result as { busyBy?: string }).busyBy ?? ''
  reviewModal.modalError = result.resumed ? '' : result.message
}

function persistDraft() {
  const result = saveDiaryDraft(reviewModal.token, {
    findings: reviewModal.findings,
    reason: reviewModal.reason,
  })
  reviewModal.modalError = result.ok ? '' : result.message
}

function commitReview() {
  const result = submitDiaryReview(reviewModal.token, {
    findings: reviewModal.findings,
    reason: reviewModal.reason,
  })
  if (result.ok) {
    closeModal()
    reload()
    return
  }
  reviewModal.modalError = result.message
  if (result.conflict) {
    // 失败动作进入冲突状态：关闭弹窗，列表展示冲突标记供人工解除。
    closeModal()
    errorMessage.value = result.message
    reload()
  }
}

function abandonDraft() {
  const result = cancelDiaryReview(reviewModal.token)
  reviewModal.modalError = result.ok ? '' : result.message
  if (result.ok) {
    closeModal()
    reload()
  }
}

function closeModal() {
  reviewModal.open = false
  reviewModal.modalError = ''
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发掘日记列表读取失败'
  }
}

onMounted(() => {
  // 再次进入页面：先把断线时停在写回环节的事务从断点继续，再渲染列表，
  // 避免列表先显示空白/旧审核记录。
  const summary = recoverDiaryReviews()
  if (summary.resumed > 0) {
    resumeNotice.value = `已自动完成 ${summary.resumed} 条中断的审核写回`
  }
  if (summary.conflicted > 0) {
    resumeNotice.value = `${resumeNotice.value}${resumeNotice.value ? '；' : ''}${summary.conflicted} 条审核因并发冲突未完成，请处理冲突标记`
  }
  reload()
})
</script>

<style scoped>
.strong {
  font-weight: 600;
}
.conflict-text {
  color: #b42318;
  font-weight: 600;
}
.conflict-note {
  margin: 4px 0 0;
  color: #b42318;
  font-size: 12px;
}
.resume-banner {
  background: #eef7ee;
  border: 1px solid #b7dcb7;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 10px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  width: 560px;
  max-width: calc(100vw - 40px);
  padding: 18px 20px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.modal-card h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.modal-tip {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted);
}
.resume-tag {
  margin-left: 8px;
  background: #fef3c7;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
}
.warn-text {
  color: #b45309;
  font-size: 12px;
  margin: 0 0 8px;
}
.modal-field {
  display: block;
  margin-bottom: 10px;
}
.modal-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.modal-field textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  resize: vertical;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
