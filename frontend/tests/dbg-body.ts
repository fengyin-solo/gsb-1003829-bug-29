const mod = await import('../src/data/diary-review.ts')
const storage = new Map<string,string>()
let failNext = true
;(globalThis as any).window = { localStorage: {
  getItem: (k:string)=>storage.has(k)?storage.get(k)!:null,
  setItem: (k:string,v:string)=>{ if(k.endsWith(':entries')&&failNext){failNext=false;throw new Error('断线')} storage.set(k,v)},
  removeItem:(k:string)=>{storage.delete(k)}, clear:()=>storage.clear(),
}}
const { listRows } = await import('../src/data/local-store.ts')
void listRows('diary')
mod.submitDiaryForReview(1)
const b = mod.beginDiaryReview(1,'确认审核','王')
mod.saveDiaryDraft(b.draft!.token, { findings: '发现', reason:''})
const all = JSON.parse(storage.get('field-archaeology-digital:diary-review-drafts')!)
all.find((d:any)=>d.id===1).stage='staged'
storage.set('field-archaeology-digital:diary-review-drafts', JSON.stringify(all))
const r1 = mod.submitDiaryReview(b.draft!.token)
console.log('r1', r1)
console.log('row status', JSON.parse(storage.get('field-archaeology-digital:entries')!).modules.diary[0].status)
