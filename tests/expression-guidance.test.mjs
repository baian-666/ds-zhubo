import test from 'node:test'
import assert from 'node:assert/strict'
import { expressionGuidance } from '../apps/cohost/expression-guidance.mjs'
import { streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'
import { testCapabilities } from './fixtures/performance.mjs'

test('whale expression guidance follows effective permissions without widening tool controls',()=>{
  const caps={...testCapabilities(['脸红','流汗'],false),adapter:'airi-live2d-whale-v1'}
  const guide=expressionGuidance(caps)
  assert.ok(guide.includes('脸红：'));assert.ok(guide.includes('流汗：'))
  assert.ok(!guide.includes('星星眼：'))
  const request=streamingParticipationRequest({hostOpportunity:true},{model:'fixture',profile:{capabilities:caps}})
  const records=request.tools[0].function.parameters.properties.records.items.anyOf
  const presentation=records.find(r=>r.properties.kind.enum[0]==='presentation')
  assert.deepEqual(presentation.properties.motion.properties.frames.items.properties.expression.properties.name.enum,['脸红','流汗'])
  assert.deepEqual(presentation.properties.performance.enum,caps.presets)
  const revoked={...caps,expressions:[]}
  assert.equal(expressionGuidance(revoked),'')
  const after=streamingParticipationRequest({}, {model:'fixture',profile:{capabilities:revoked}})
  assert.ok(!after.messages[0].content.includes('脸红：'))
})

test('a different adapter with matching names does not inherit whale semantics',()=>{
  assert.equal(expressionGuidance(testCapabilities(['脸红','流汗'],false)),'')
})
