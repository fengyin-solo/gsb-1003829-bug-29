// 发掘日记审核事务的行为测试：用可控故障的内存 localStorage，
// 模拟断线、写盘失败、跨页面并发。运行：npm test（经 tests/ts-loader.mjs 即时转译 TS）。
import assert from 'node:assert'

const ENTRIES_KEY = 'field-archaeology-digital:entries'
const DRAFTS_KEY = 'field-archaeology-digital:diary-review-drafts'

// ---- 可控故障的内存 localStorage ----
let storage = new Map<string, string>()
// 可注入的存储写拦截：返回 Error 则本次业务表写按断线处理
let entryWriteInterceptor: null | ((raw: string) => Error | null) = null

globalThis.window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (k === ENTRIES_KEY && entryWriteInterceptor) {
        const err = entryWriteInterceptor(v)
        if (err) {
          throw err
        }
      }
      storage.set(k, v)
    },
    removeItem: (k: string) => {
      storage.delete(k)
    },
    clear: () => {
      storage.clear()
    },
  },
} as unknown as Window & typeof globalThis

const mod = await import('../src/data/diary-review.ts')
const localStore = await import('../src/data/local-store.ts')

function resetEnv() {
  storage.clear() // 业务表与审核草稿都清空；不能替换 Map，shim 闭包持有原引用
  entryWriteInterceptor = null
  localStore.listRows('diary') // 触发种子播种
}
function getRow(id: number) {
  const data = JSON.parse(storage.get(ENTRIES_KEY)!)
  const row = data.modules.diary.find((r: { id: number }) => r.id === id)
  assert.ok(row, `日记 ${id} 应存在`)
  return row
}
function draftList() {
  return JSON.parse(storage.get(DRAFTS_KEY) ?? '[]') as Array<Record<string, unknown>>
}
function draftFor(reviewer: string, id = 1) {
  const d = draftList().find((x) => x.reviewer === reviewer && x.id === id)
  assert.ok(d, `${reviewer} 对日记 ${id} 的草稿应存在`)
  return d
}
function markStaged(token: string) {
  const all = draftList()
  const d = all.find((x) => x.token === token)
  d!.stage = 'staged'
  storage.set(DRAFTS_KEY, JSON.stringify(all))
}

let passed = 0
const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

test('提交审核：已录入 -> 待审核，重复提交被拒', () => {
  assert.equal(mod.submitDiaryForReview(1).ok, true)
  assert.equal(getRow(1).status, '待审核')
  assert.equal(getRow(1).pending, true)
  assert.equal(mod.submitDiaryForReview(1).ok, false)
  // 已审核状态也不能提交
  assert.equal(mod.beginDiaryReview(3, '确认审核', '甲').ok, false)
})

test('空白拦截：无主要发现不能确认；空退回理由不能退回；空白不动状态', () => {
  mod.submitDiaryForReview(1)
  const b1 = mod.beginDiaryReview(1, '确认审核', '甲')
  assert.equal(mod.submitDiaryReview(b1.draft!.token, { findings: '   ', reason: '' }).ok, false)
  const b2 = mod.beginDiaryReview(1, '退回补充', '乙')
  assert.equal(mod.submitDiaryReview(b2.draft!.token, { findings: '', reason: '' }).ok, false)
  assert.equal(getRow(1).status, '待审核')
  assert.equal(draftList().filter((d) => d.stage === 'staged').length, 0, '被拦截时不产生暂存残留')
})

test('正常确认：主要发现/审核人/时间写回，草稿清理', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '审核员张')
  const r = mod.submitDiaryReview(b.draft!.token, { findings: '发现灰坑一座', reason: '' })
  assert.equal(r.ok, true)
  const row = getRow(1)
  assert.equal(row.status, '已审核')
  assert.equal(row.主要发现, '发现灰坑一座')
  assert.equal(row.审核人, '审核员张')
  assert.ok(typeof row.审核时间 === 'string' && row.审核时间.length > 0)
  assert.ok(row.审核令牌)
  assert.equal(draftList().length, 0)
})

test('正常退回：退回理由/审核人写回，状态需补充、标记异常', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '退回补充', '审核员李')
  const r = mod.submitDiaryReview(b.draft!.token, { findings: '', reason: '层位描述不清' })
  assert.equal(r.ok, true)
  const row = getRow(1)
  assert.equal(row.status, '需补充')
  assert.equal(row.退回理由, '层位描述不清')
  assert.equal(row.审核人, '审核员李')
  assert.equal(row.abnormal, true)
  // 退回后重新提交可再走一轮，冲突残留标记被清
})

test('退回后重新提交审核，旧草稿被清理不残留', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '退回补充', '李')
  mod.submitDiaryReview(b.draft!.token, { findings: '', reason: '理由' })
  mod.submitDiaryForReview(1)
  assert.equal(getRow(1).status, '待审核')
  assert.equal(draftList().length, 0)
  assert.equal(getRow(1).审核冲突, '')
})

test('暂存草稿不动业务表；重入按原审核人恢复未提交内容', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '审核员张')
  mod.saveDiaryDraft(b.draft!.token, { findings: '草稿里的发现', reason: '' })
  assert.equal(getRow(1).status, '待审核')
  const again = mod.beginDiaryReview(1, '确认审核', '审核员张')
  assert.equal(again.resumed, true)
  assert.equal(again.draft!.findings, '草稿里的发现')
  assert.equal(again.draft!.reviewer, '审核员张')
})

test('跨页面续做保留原审核人：另一值班人进入也只能沿用草稿审核人', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '白班张')
  mod.saveDiaryDraft(b.draft!.token, { findings: '待续内容', reason: '' })
  // 模拟换页面/换人值班后从“继续”路径进入：token 不变
  const token = b.draft!.token
  const r = mod.submitDiaryReview(token, { findings: '待续内容补完', reason: '' })
  assert.equal(r.ok, true)
  assert.equal(getRow(1).审核人, '白班张', '写回审核人是原审核人')
})

test('阶段2写盘断线：意图保持 staged，重入无参续做成功，空白不能覆盖', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '审核员王')
  mod.saveDiaryDraft(b.draft!.token, { findings: '日记1的发现', reason: '' })
  markStaged(b.draft!.token)
  // 业务表第一次写终态时抛错（阶段1草稿已在盘上）
  let failedOnce = false
  entryWriteInterceptor = () => {
    if (!failedOnce) {
      failedOnce = true
      return new Error('模拟断线：业务表写入失败')
    }
    return null
  }
  const r1 = mod.submitDiaryReview(b.draft!.token)
  assert.equal(r1.ok, false, '写盘失败时本次提交不成功')
  assert.equal(getRow(1).status, '待审核', '业务表不得半写')
  assert.equal(draftFor('审核员王', 1).stage, 'staged')
  // 重新进入页面：无参续做，以暂存内容为准，不会写成空白
  const r2 = mod.submitDiaryReview(b.draft!.token)
  assert.equal(r2.ok, true)
  assert.equal(r2.resumed, true)
  assert.equal(getRow(1).status, '已审核')
  assert.equal(getRow(1).主要发现, '日记1的发现')
  assert.equal(getRow(1).审核人, '审核员王')
})

test('页面重入 recover：staged 事务自动完成，填写中草稿不动', () => {
  mod.submitDiaryForReview(1)
  mod.submitDiaryForReview(2)
  const b1 = mod.beginDiaryReview(1, '确认审核', '甲')
  mod.saveDiaryDraft(b1.draft!.token, { findings: '甲对1', reason: '' })
  markStaged(b1.draft!.token)
  const b2 = mod.beginDiaryReview(2, '确认审核', '乙')
  mod.saveDiaryDraft(b2.draft!.token, { findings: '乙还没写完', reason: '' })
  const summary = mod.recoverDiaryReviews()
  assert.equal(summary.resumed, 1)
  assert.equal(summary.conflicted, 0)
  assert.equal(getRow(1).status, '已审核')
  assert.equal(getRow(1).审核人, '甲')
  assert.equal(getRow(2).status, '待审核', '填写中草稿不被自动提交')
  assert.ok(draftList().some((d) => d.reviewer === '乙'), '未提交草稿保留')
})

test('并发确认与退回：仅一个动作完成，失败方进入冲突状态且打冲突标记', () => {
  mod.submitDiaryForReview(1)
  const a = mod.beginDiaryReview(1, '确认审核', '审核员甲')
  const b = mod.beginDiaryReview(1, '退回补充', '审核员乙')
  assert.equal(mod.submitDiaryReview(a.draft!.token, { findings: '甲的发现', reason: '' }).ok, true)
  const rb = mod.submitDiaryReview(b.draft!.token, { findings: '', reason: '乙的理由' })
  assert.equal(rb.ok, false)
  assert.equal(rb.conflict, true)
  const row = getRow(1)
  assert.equal(row.status, '已审核', '先完成者生效，不被覆盖')
  assert.equal(row.审核人, '审核员甲')
  assert.ok(String(row.审核冲突).includes('审核员乙'), '行上有失败方冲突标记')
  assert.equal(draftFor('审核员乙').stage, 'conflict')
  // 冲突草稿继续提交仍被明确拒绝
  assert.equal(mod.submitDiaryReview(b.draft!.token).conflict, true)
  // 解除冲突：标记清除，甲方结果保留
  assert.equal(mod.dismissDiaryConflict(1, b.draft!.token).ok, true)
  assert.equal(getRow(1).审核冲突, '')
  assert.equal(getRow(1).status, '已审核')
})

test('甲写回中断(staged)后乙插队退回，甲续做进入冲突而非覆盖', () => {
  mod.submitDiaryForReview(1)
  const a = mod.beginDiaryReview(1, '确认审核', '甲')
  mod.saveDiaryDraft(a.draft!.token, { findings: '甲的发现', reason: '' })
  markStaged(a.draft!.token)
  const b = mod.beginDiaryReview(1, '退回补充', '乙')
  assert.equal(mod.submitDiaryReview(b.draft!.token, { findings: '', reason: '乙的退回理由' }).ok, true)
  const r = mod.submitDiaryReview(a.draft!.token)
  assert.equal(r.conflict, true)
  assert.equal(getRow(1).status, '需补充')
  assert.equal(getRow(1).审核人, '乙')
  assert.equal(getRow(1).退回理由, '乙的退回理由')
})

test('同审核人同令牌重放（写回已成功、清理前断线）幂等完成', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '甲')
  assert.equal(mod.submitDiaryReview(b.draft!.token, { findings: 'X', reason: '' }).ok, true)
  const token = getRow(1).审核令牌
  // 手工塞回一个"清理前断线"的 staged 草稿
  const all = draftList()
  all.push({
    id: 1, token, action: '确认审核', findings: 'X', reason: '',
    reviewer: '甲', stage: 'staged', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  storage.set(DRAFTS_KEY, JSON.stringify(all))
  const r = mod.submitDiaryReview(token as string)
  assert.equal(r.ok, true)
  assert.equal(r.resumed, true)
  assert.equal(getRow(1).status, '已审核')
  assert.equal(draftList().length, 0, '续做后草稿被清理')
})

test('放弃草稿只删填写中草稿；staged 中断事务不允许丢弃', () => {
  mod.submitDiaryForReview(1)
  const b = mod.beginDiaryReview(1, '确认审核', '甲')
  mod.saveDiaryDraft(b.draft!.token, { findings: '还没写完', reason: '' })
  assert.equal(mod.cancelDiaryReview(b.draft!.token).ok, true)
  assert.equal(getRow(1).status, '待审核')
  const b2 = mod.beginDiaryReview(1, '确认审核', '甲')
  markStaged(b2.draft!.token)
  assert.equal(mod.cancelDiaryReview(b2.draft!.token).ok, false)
})

for (const [name, fn] of tests) {
  resetEnv()
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}
console.log(`\n${passed} 个测试通过`)
