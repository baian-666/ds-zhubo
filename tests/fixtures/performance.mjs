import {emptyCapabilities} from '../../packages/cohost-contracts/performance.ts'
import {poseLimits} from '../../packages/cohost-contracts/motion.ts'
export function testCapabilities(expressions=['开心兴奋','问号','感叹号','生气'],components=true,modelId='whale') {
 const aliases=Object.entries({smile:'开心兴奋',think:'问号',surprise:'感叹号',pout:'生气'}).filter(([,expression])=>expressions.includes(expression)).map(([name,expression])=>({name,expression}))
 return {...emptyCapabilities(modelId),adapter:'test-rig',presets:['idle','listen','nod',...aliases.map(x=>x.name)],poses:Object.keys(poseLimits),expressions,aliases,
 components:components?[{name:'tailBase',min:-1,max:1,discrete:false,description:'尾巴'}]:[]}
}
