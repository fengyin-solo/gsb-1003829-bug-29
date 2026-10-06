const mod = await import('../src/data/diary-review.ts')
const localStore = await import('../src/data/local-store.ts')
const ENTRIES_KEY='field-archaeology-digital:entries'
const storage = new Map<string,string>()
;(globalThis as any).window = { localStorage: {
  getItem:(k:string)=>storage.has(k)?storage.get(k)!:null,
  setItem:(k:string,v:string)=>storage.set(k,v),
  removeItem:(k:string)=>storage.delete(k), clear:()=>storage.clear(),
}}
localStore.listRows('diary')
mod.submitDiaryForReview(1)
const a = mod.beginDiaryReview(1,'确认审核','审核员甲')
const b = mod.beginDiaryReview(1,'退回补充','审核员乙')
console.log(mod.submitDiaryReview(a.draft!.token,{findings:'甲',reason:''}))
const rb = mod.submitDiaryReview(b.draft!.token,{findings:'',reason:'乙理由'})
console.log('rb', rb)
console.log(JSON.stringify(JSON.parse(storage.get(ENTRIES_KEY)!).modules.diary[0], null, 1))
