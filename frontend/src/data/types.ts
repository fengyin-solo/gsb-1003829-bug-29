/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 发掘日记审核写回的额外字段；未审核的老数据这些字段缺省，页面按缺省渲染。
export type DiaryAuditFields = {
  审核人?: string
  审核时间?: string
  退回理由?: string
  /** 已完成审核动作的令牌；同令牌重放视为续做（幂等），他令牌重放进入冲突。 */
  审核令牌?: string
  /** 行级冲突标记：并发确认/退回中的失败方，需要人工解除。 */
  审核冲突?: string
}

// 审核事务的阶段：填写中是普通草稿；已暂存说明写回环节中断，回来必须从这里续做；
// conflict 是并发失败方，禁止继续提交，需人工解除。
export type DiaryReviewStage = 'drafting' | 'staged' | 'conflict'

export type DiaryReviewDraft = {
  id: number
  token: string
  action: '确认审核' | '退回补充'
  findings: string
  reason: string
  reviewer: string
  stage: DiaryReviewStage
  createdAt: string
  updatedAt: string
}

export type DiaryActionResult = ActionResult & {
  /** 是否为跨页面的事务续做（恢复了之前中断的暂存）。 */
  resumed?: boolean
  /** 失败方动作进入冲突状态。 */
  conflict?: boolean
  draft?: DiaryReviewDraft
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
