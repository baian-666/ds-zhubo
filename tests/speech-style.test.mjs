import test from 'node:test'
import assert from 'node:assert/strict'
import { styledText, normalizeSpeechStyle } from '../apps/cohost/speech-style.mjs'
import { parseParticipation } from '../apps/cohost/participation-model.mjs'

test('manual style controls are hidden across every chunk boundary and cannot change after speech starts', async () => {
  const input='<voice:gentle>慢慢说，我在听。<voice:happy>不用勉强自己。'
  for (let i=0;i<=input.length;i++) {
    const styles=[],parts=[]
    for await (const chunk of styledText([input.slice(0,i),input.slice(i)],x=>styles.push(x))) parts.push(chunk)
    assert.equal(parts.join(''),'慢慢说，我在听。不用勉强自己。')
    assert.deepEqual(styles,['gentle'])
  }
})

test('missing, invalid and incomplete style controls safely fall back without becoming speech', async () => {
  for (const [input,expected,styles] of [
    ['普通聊天。','普通聊天。',[]],['<voice:evil>照常说。','照常说。',['neutral']],
    ['<voice:gent','',[]],['已经开始。<voice:happy>继续。','已经开始。继续。',[]],
    ['<voice:'+'a'.repeat(80)+'>正文','正文',['neutral']],
  ]) {
    const found=[],parts=[]
    for await (const chunk of styledText([...input],s=>found.push(s))) parts.push(chunk)
    assert.equal(parts.join(''),expected);assert.deepEqual(found,styles)
  }
  assert.equal(normalizeSpeechStyle({audio:'some.wav'}),'neutral')
})

test('automatic decision accepts a bounded style and keeps valid speech on an unknown style', () => {
  const base={action:'reply_host',hostIntent:'invited',reason:'在安慰主播。',text:'我在听。',targetId:'',platform:''}
  const parse=extra=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify({...base,...extra})}}]})
  assert.equal(parse({speechStyle:'gentle'}).speechStyle,'gentle')
  assert.equal(parse({speechStyle:'arbitrary-file'}).speechStyle,'neutral')
  assert.equal(parse({}).speechStyle,'neutral')
})
