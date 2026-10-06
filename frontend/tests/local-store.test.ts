// 本地持久化层测试：残缺存储回退种子、旧格式迁移、跨页面版本裁决。
import assert from 'node:assert'

const ENTRIES_KEY = 'field-archaeology-digital:entries'

const storage = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
    clear: () => storage.clear(),
  },
} as unknown as Window & typeof globalThis

const store = await import('../src/data/local-store.ts')

function read() {
  return JSON.parse(storage.get(ENTRIES_KEY)!)
}
function reset(raw?: string) {
  storage.clear()
  if (raw !== undefined) {
    storage.set(ENTRIES_KEY, raw)
  }
}

let passed = 0
const tests: Array<[string, () => void]> = []
const test = (name: string, fn: () => void) => tests.push([name, fn])

test('空存储：首次读取播种种子且落盘', () => {
  reset()
  const rows = store.listRows('diary')
  assert.equal(rows.length, 3)
  assert.ok(read().modules.diary)
})

test('整盘 JSON 损坏：回退种子，不抛错、不白屏', () => {
  reset('{这不是合法JSON')
  assert.equal(store.listRows('diary').length, 3)
  assert.ok(read().modules.diary)
})

test('单模块被写成空数组：只该模块回退种子，其他模块保留磁盘值', () => {
  const data = {
    version: 2,
    modules: {
      diary: [], // 残缺：审核断线时可能写坏的模块
      trench: [{ id: 999, status: '待发掘', pending: true, abnormal: false }],
    },
  }
  reset(JSON.stringify(data))
  assert.equal(store.listRows('diary').length, 3, 'diary 回退种子，不再是空白列表')
  assert.equal(store.listRows('trench')[0].id, 999, '其他模块改动仍保留')
})

test('旧格式（直接是模块映射、无 version/modules 外壳）可正常迁移', () => {
  reset(JSON.stringify({ diary: [], trench: [{ id: 7, status: '待发掘', pending: true, abnormal: false }] }))
  assert.equal(store.listRows('diary').length, 3)
  assert.equal(store.listRows('trench')[0].id, 7)
})

test('写盘后无内存缓存：另一读取者能立刻看到新值（跨页面可见）', () => {
  reset()
  const rows = store.listRows('diary')
  store.saveRows('diary', rows.map((r) => (r.id === 1 ? { ...r, status: '待审核' } : r)))
  // 模拟"另一个页面/下一次调用"：直接从磁盘读
  assert.equal(store.listRows('diary')[0].status, '待审核')
})

test('版本号 CAS：期望版本不符则不写入（并发只一个成功）', () => {
  reset()
  const snap1 = store.tableSnapshot('diary')
  // 另一个页面先写了一次，版本前进
  store.mutateRows('diary', (rows) => rows)
  const conflict = store.mutateRows('diary', (rows) => rows, snap1.version)
  assert.equal(conflict.ok, false, '旧版本写回应被拒绝')
  if (!conflict.ok) {
    assert.equal(conflict.reason, 'version-mismatch')
  }
  const fresh = store.tableSnapshot('diary')
  const ok = store.mutateRows('diary', (rows) => rows, fresh.version)
  assert.equal(ok.ok, true)
})

for (const [name, fn] of tests) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}
console.log(`\n${passed} 个测试通过`)
