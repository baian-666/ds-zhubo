import {writeFileSync} from 'node:fs'
import {planParticipation} from '../apps/cohost/participation-model.mjs'
if(!process.argv.includes('--real')||!process.env.DEEPSEEK_API_KEY)throw Error('Use --real with the local credential configured')
const text='我接着讲跑步机的故事，你先别出声。听说年糕霸占跑步机睡了八小时，小鲸鱼你可以自己用几个连贯的小动作反应一下，我还没讲到结尾。'
const snapshot={scene:[{role:'host',text}],hostOpportunity:true,latestHost:{id:1,text,final:true,endedAt:Date.now()},
 proactiveCooldownMs:0,viewerWindow:false,active:false,hostSpeaking:false,eligibleViewers:[]}
const started=Date.now()
const result=await planParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-flash',signal:new AbortController().signal})
writeFileSync('data/free-motion-reaction-result.json',JSON.stringify({kind:'real DeepSeek tool decision; not human voice',elapsedMs:Date.now()-started,result},null,2))
console.log(JSON.stringify({elapsedMs:Date.now()-started,...result}))
