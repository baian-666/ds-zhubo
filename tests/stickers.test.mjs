import test from 'node:test'
import assert from 'node:assert/strict'
import { StickerCatalog } from '../apps/cohost/stickers.mjs'

const config={stage:'desktop',owner:'desktop-owner',enabled:true,frequency:100,entries:[{id:'airi-happy',description:'开心'}]}

test('active renderer selection overrides desktop preference without borrowing another catalog',()=>{
 let owner='web-owner'
 const catalog=new StickerCatalog({owner:()=>owner})
 catalog.update(config)
 catalog.update({...config,stage:'web',owner,enabled:false})
 assert.deepEqual(catalog.select(),[])
 owner='desktop-owner';assert.equal(catalog.select()[0].id,'airi-happy')
 owner='unknown-window';assert.deepEqual(catalog.select(),[])
})
test('stickers honor frequency, disable, deletion and lease expiry',()=>{
  let now=0
  const catalog=new StickerCatalog({now:()=>now,random:()=>0.5})
  catalog.update(config)
  const offered=catalog.select()
  assert.equal(catalog.resolve('airi-happy',offered).description,'开心')
  assert.equal(catalog.resolve('made-up',offered),undefined)
  catalog.update({...config,frequency:0});assert.deepEqual(catalog.select(),[])
  catalog.update({...config,enabled:false});assert.equal(catalog.resolve('airi-happy',offered),undefined)
  catalog.update({...config,entries:[]});assert.equal(catalog.resolve('airi-happy',offered),undefined)
  catalog.update(config);now=30001;assert.deepEqual(catalog.select(),[])
})
test('desktop catalog wins while fresh and image URLs cannot become model actions',()=>{
  let now=0
  const catalog=new StickerCatalog({now:()=>now})
  catalog.update({...config,enabled:false})
  now=10000;catalog.update({...config,stage:'web',owner:'web-owner'})
  assert.deepEqual(catalog.select(),[])
  now=30001;assert.equal(catalog.select().length,1)
  assert.throws(()=>catalog.update({...config,entries:[{id:'https://evil/image',description:'bad'}]}))
})
