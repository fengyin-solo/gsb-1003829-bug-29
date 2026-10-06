/* eslint-disable no-console */
// 日记审核事务的端到端验证：用内存版 localStorage 模拟刷新、断线与并发标签页。
// 运行：node --experimental-vm-modules 不需要，直接由 esbuild 打包后 node 执行。

function createMemoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  }
}

function freshEnv(storage = createMemoryStorage()) {
  ;(globalThis as any).window = {
    localStorage: storage,
    addEventListener: () => {},
  }
  ;(globalThis as any).localStorage = storage
  return storage
}

let passed = 0
let failed = 0

function assert(cond: boolean, message: string) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

async function main() {
  const {
    listDiaries,
    submitDiary,
    startReview,
    saveReviewDraft,
    finalizeReview,
    recoverReviewTransactions,
    discardDraft,
    dismissStaleTx,
  } = await import('./src/api/diary-service')
  const { readReviewDoc, writeReviewDoc } = await import('./src/data/review-store')
  const { storageKey } = await import('./src/data/local-store')

  const find = (id: number) => listDiaries().items.find((row) => row.id === id)!
  const ENTRIES_KEY = storageKey()

  // ---- 1. 提交审核：已录入 → 待审核 ----
  console.log('1) 提交审核流转')
  freshEnv()
  const r1 = submitDiary(1)
  assert(r1.ok, '已录入日记可以提交审核')
  assert(find(1).status === '待审核', '提交后状态为待审核')
  const r1b = submitDiary(1)
  assert(!r1b.ok, '重复提交被拒绝')

  // ---- 2. 审核事务 + 草稿：内容持久化，不覆盖主要发现 ----
  console.log('2) 开始审核与草稿')
  const started = startReview(1, '确认审核', '审核员甲')
  assert(started.ok && started.data, '开始确认审核事务')
  const txId = started.data!.tx.txId
  assert(started.data!.tx.reviewer === '审核员甲', '事务固化审核人')
  const saved = saveReviewDraft(txId, { findings: '发现陶片两件', returnReason: '' })
  assert(saved.ok, '草稿可以保存')
  const blankSubmit = finalizeReview(txId, { findings: '   ', returnReason: '' })
  assert(!blankSubmit.ok, '空白主要发现不能确认审核')
  assert(find(1).status === '待审核', '空白提交时业务行状态不变（不会写成空白已审核）')
  assert(readReviewDoc().active[0].status === 'draft', '校验不过仍停留在草稿态')

  // ---- 3. 断线发生在「提交中」：恢复自动续做 ----
  console.log('3) finalizing 中断后自动续做')
  const entriesAfterDraft = JSON.parse((globalThis as any).localStorage.getItem(ENTRIES_KEY))
  // 模拟另一次进程：新环境但共享同一份持久化数据
  freshEnv(createMemoryStorage({
    [ENTRIES_KEY]: JSON.stringify(entriesAfterDraft),
    'field-archaeology-digital:diary-review-tx': JSON.stringify({
      active: [{
        ...readReviewDoc().active[0],
        status: 'finalizing',
        findings: '发现陶片两件',
        returnReason: '',
        updatedAt: Date.now(),
      }],
      history: [],
    }),
  }))
  const report = recoverReviewTransactions()
  assert(report.resumed.length === 1, '进入页面检测到 1 个中断提交并自动续做')
  const row = find(1)
  assert(row.status === '已审核', '续做后日记为已审核')
  assert(String(row.主要发现) === '发现陶片两件', '主要发现已写回，没有被空白覆盖')
  assert(String(row.审核人) === '审核员甲', '写回审核人为原审核人')
  assert(Boolean(row.审核时间), '写回审核时间')
  assert(readReviewDoc().active.length === 0, '成功事务已归档，无残留草稿')

  // ---- 4. 跨页面续做保留原审核人 ----
  console.log('4) 草稿跨页面续做保留原审核人')
  submitDiary(2) // id2 原本是需补充
  const s2 = startReview(2, '退回补充', '审核员乙')
  saveReviewDraft(s2.data!.tx.txId, { findings: '', returnReason: '工作内容缺失' })
  const snapshot2 = {
    [ENTRIES_KEY]: (globalThis as any).localStorage.getItem(ENTRIES_KEY),
    'field-archaeology-digital:diary-review-tx':
      (globalThis as any).localStorage.getItem('field-archaeology-digital:diary-review-tx'),
  }
  freshEnv(createMemoryStorage(snapshot2))
  const reopen = startReview(2, '退回补充', '另一个登录人')
  assert(reopen.ok, '同动作重新进入自动续做')
  assert(reopen.data!.tx.reviewer === '审核员乙', '续做保留原审核人，不替换成当前登录人')
  assert(reopen.data!.tx.returnReason === '工作内容缺失', '退回理由草稿被保留')
  const fin = finalizeReview(reopen.data!.tx.txId)
  assert(fin.ok, '续做提交成功')
  const row2 = find(2)
  assert(row2.status === '需补充' && String(row2.退回理由) === '工作内容缺失', '退回理由已写回')
  assert(String(row2.审核人) === '审核员乙', '退回也保留原审核人')
  assert(String(row2.主要发现).length > 0, '退回补充不抹掉原主要发现')

  // ---- 5. 并发：确认与退回只允许一个成功，另一个进入冲突态 ----
  console.log('5) 并发确认/退回仲裁')
  freshEnv()
  submitDiary(1)
  const approve = startReview(1, '确认审核', '审核员甲')
  const reject = startReview(1, '退回补充', '审核员乙')
  // 同一进程第二次 start 会命中已有事务：动作不同直接拒绝，避免同会话串动作
  assert(approve.ok, '甲开始确认')
  assert(!reject.ok && reject.data?.tx.action === '确认审核', '同进程对同一日记发起另一动作被拒绝，提示已有事务')

  // 真正的跨标签并发：手工塞入两条不同事务
  const baseVersion = Number(find(1)._version ?? 0)
  const now = Date.now()
  writeReviewDoc({
    active: [
      {
        txId: 'tx-approve', diaryId: 1, action: '确认审核', reviewer: '审核员甲',
        findings: '并发确认的发现', returnReason: '', baseVersion,
        status: 'finalizing', createdAt: now, updatedAt: now,
      },
      {
        txId: 'tx-reject', diaryId: 1, action: '退回补充', reviewer: '审核员乙',
        findings: '', returnReason: '并发退回的理由', baseVersion,
        status: 'finalizing', createdAt: now, updatedAt: now,
      },
    ],
    history: [],
  })
  const a = finalizeReview('tx-approve')
  const b = finalizeReview('tx-reject')
  const outcomes = [a, b].filter((x) => x.ok)
  const conflicts = [a, b].filter((x) => !x.ok)
  assert(outcomes.length === 1, '两个并发动作只有一个成功')
  assert(conflicts.length === 1, '另一个动作失败并给出明确冲突信息')
  const doc = readReviewDoc()
  const loser = doc.active.find((tx) => tx.status === 'conflict')
  assert(Boolean(loser), '失败事务进入 conflict 明确冲突状态')
  assert(Boolean(loser?.note) && loser!.note.includes('审核人'), '冲突说明指出已完成方审核人')
  assert(find(1).status === '已审核' || find(1).status === '需补充', '日记只呈现一个终态')
  const cleared = dismissStaleTx(loser!.txId)
  assert(cleared.ok && readReviewDoc().active.length === 0, '冲突记录可清除，无残留')

  // ---- 6. 幂等：finalizing 已写回后再次恢复不重复改 ----
  console.log('6) finalizing 归档前断线的幂等续做')
  freshEnv()
  submitDiary(1)
  const s6 = startReview(1, '确认审核', '审核员甲')
  const id6 = s6.data!.tx.txId
  finalizeReview(id6, { findings: '最终发现', returnReason: '' })
  const versionDone = Number(find(1)._version ?? 0)
  // 手工把已归档事务复活成 finalizing（模拟写回成功、归档前断线）
  const doc6 = readReviewDoc()
  const hist = doc6.history[0]
  writeReviewDoc({ active: [{ ...hist, status: 'finalizing' }], history: [] })
  const rep6 = recoverReviewTransactions()
  assert(rep6.resumed.length === 1, '识别为已写回并续完归档')
  assert(Number(find(1)._version ?? 0) === versionDone, '幂等续做不重复推进版本')
  assert(readReviewDoc().active.length === 0, '无残留')

  // ---- 7. 空白审核记录自愈（旧脏数据迁移）----
  console.log('7) 旧的空白已审核记录自愈')
  const storage7 = createMemoryStorage()
  freshEnv(storage7)
  listDiaries() // 先触发播种
  const broken = JSON.parse(storage7.getItem(ENTRIES_KEY)!)
  broken.diary[0].status = '已审核'
  broken.diary[0].pending = false
  broken.diary[0].主要发现 = ''
  broken.diary[0].审核人 = '旧审核人'
  storage7.setItem(ENTRIES_KEY, JSON.stringify(broken))
  freshEnv(storage7)
  const repaired = find(1)
  assert(repaired.status === '待审核', '空白已审核记录退回待审核，绝不保留空白审核')
  assert(String(repaired.审核人 ?? '') === '', '不臆造/不保留空白审核的审核留痕')

  // ---- 8. 放弃草稿 ----
  console.log('8) 草稿放弃')
  submitDiary(1)
  const s8 = startReview(1, '退回补充', '审核员甲')
  saveReviewDraft(s8.data!.tx.txId, { findings: '', returnReason: '待补' })
  const d8 = discardDraft(s8.data!.tx.txId)
  assert(d8.ok, '草稿可主动放弃')
  assert(find(1).status === '待审核', '放弃草稿不改变日记状态')
  assert(!readReviewDoc().active.some((tx) => tx.status === 'draft'), '草稿不再残留在活动事务')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
