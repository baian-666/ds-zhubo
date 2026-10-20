import { normalizeSpeechStyle, styledText } from './speech-style.mjs'
import {performanceTarget} from '../../packages/cohost-contracts/performance.ts'
import { isBackchannel } from '../../packages/cohost-contracts/floor.ts'
import { RuntimeProfile, defaultPersona } from './runtime-profile.mjs'
import { StickerCatalog } from './stickers.mjs'
import { AiriVoice } from './airi-voice.mjs'
import { SpeechOutput } from './speech-output.mjs'
import { PreparedSpeech } from './prepared-speech.mjs'
import { RuntimeSettings, speechSettings } from './runtime-settings.mjs'
import { ModuleSettings, verifyInference } from './module-settings.mjs'
import { CharacterCatalog } from './character-catalog.mjs'
import { inferenceProviders, recognitionProviders } from '../../packages/cohost-contracts/services.ts'
import { speechProviders } from '../../packages/cohost-contracts/speech.ts'
import { WindowsVoice } from './windows-voice.mjs'
import { parseMotionSequence } from '../../packages/cohost-contracts/motion.ts'
import { Performance, performedText, performances } from './performance.mjs'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Scheduler } from './scheduler.mjs'
import { Director } from './director.mjs'
import { streamReply } from './deepseek.mjs'
import { mockReply } from './mock.mjs'
import { RoomJournal } from './room-journal.mjs'
import { Scene } from './scene.mjs'
import { Hosting } from './hosting.mjs'
import { Participation } from './participation.mjs'
import { planParticipation } from './participation-model.mjs'
import { streamParticipation } from './participation-stream.mjs'
import { BilibiliLive } from './bilibili.mjs'
import { BlivechatRelay, blivechatConfig } from './blivechat.mjs'
import { parseEnv } from 'node:util'
import { StatusStream } from './status-stream.mjs'
import { SessionStore, SessionMemory, SessionPersistence, characterKey } from './session-store.mjs'
import { SessionContinuity } from './session-continuity.mjs'
import { DirectorHandbook, directorManual } from './director-handbook.mjs'
import { DirectorTools } from './director-tools.mjs'
import { liveClock } from './live-clock.mjs'
import { observeDirector } from './director-observation.mjs'

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readBody(request, limit = 16_384) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求过大')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body
  } catch { throw new HttpError(400, '需要 JSON 对象') }
}

function textField(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, `文本需为 1–${max} 个字符`)
  return value.trim()
}

function authorized(request, token) {
  if (!token) return true
  const actual = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createApp({ apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || 'deepseek-flash', token = process.env.COHOST_ACCESS_TOKEN || '', scheduler = new Scheduler(), director = new Director({ scheduler }), reply = streamReply, semanticEnabled = false, planner, observer, participationStreaming = process.env.PARTICIPATION_STREAM !== '0', participationOptions = {}, rehearsal = false, voiceOptions = {}, airiOptions = {}, speechOptions = {}, serviceOptions = {}, bilibiliOptions = {}, bilibiliEnvPath = new URL('../../.env',import.meta.url), roomSnapshot, sessionPath } = {}) {
  const lifetime=new AbortController()
  const directorTools=new DirectorTools()
  const store=sessionPath ? new SessionStore(sessionPath) : null
  if(store?.restored && roomSnapshot) {store.close();throw new Error('A saved session already exists. Room snapshots can only seed an empty database.')}
  let settings,modules,catalog,handbook
  try {
    settings=new RuntimeSettings({store,seed:{engine:speechOptions.engine??(process.env.COHOST_TTS_PROVIDER||'siliconflow'),voice:speechOptions.voice??process.env.COHOST_TTS_VOICE}})
    modules=new ModuleSettings({store,model});catalog=new CharacterCatalog(store);model=modules.snapshot('inference').value.model
    handbook=new DirectorHandbook({store})
  }
  catch(error) {store?.close();throw error}
  let speech = new SpeechOutput({...speechOptions,...settings.snapshot().speech})
  speech.revision=settings.snapshot().revision
  const recovered=store?.restored
  const memory=new SessionMemory(recovered?.memories)
  let persistence
  const onChange=()=>persistence?.schedule()
  const room = new RoomJournal({snapshot:recovered?.room??roomSnapshot,onChange})
  let initializing=true
  const scene = new Scene({snapshot:recovered?.scene,onChange,onEntry:entry=>continuity.observe(entry,entry.characterId??characterKey(profiles.snapshot()))})
  const continuity=new SessionContinuity({snapshot:recovered?.continuity,onChange,
    idle:()=>!scheduler.active && !scheduler.hostSpeaking && !participation.job && !participation.timer && !director.candidate})
  persistence=new SessionPersistence(store,()=>({format:2,room:room.status(),scene:scene.checkpoint(),memories:memory.records,continuity:continuity.checkpoint()}))
  const performance = new Performance()
  const stickers = new StickerCatalog({owner:()=>airi.session?.owner})
  const profiles = new RuntimeProfile({owner:()=>airi.session?.owner,catalog})
  const hosting = new Hosting()
  let live = false
  // Kept opt-in until the same-waveform latency and acknowledgment trials pass.
  const participation = new Participation({ openingPreparationEnabled:false, ...participationOptions, director, scheduler, scene, continuity,hosting,character:()=>characterKey(profiles.snapshot()),history:()=>memory.history(characterKey(profiles.snapshot())),
    observe:(snapshot,options)=>{
      const profile=profiles.snapshot(),characterId=characterKey(profile)
      return (observer??observeDirector)({...snapshot,scene:scene.snapshot('deepseek',characterId),history:memory.history(characterId)},
        {...options,apiKey,model,profile})
    },
    onCoaching:result=>result.commitCoaching?.(),
    preparationText:(utterance,listening)=>utterance?airi.previewRecognition(utterance.id,listening.text):null,
    prepareSpeech:candidate=>airi.session?.ready && speech.engine!=='siliconflow' ?
      candidate.firstSentenceOnly?PreparedSpeech.firstSentence(speech,candidate.preparedReply,candidate.speechStyle):
      new PreparedSpeech(speech,candidate.preparedReply,candidate.speechStyle,Date.now,{streaming:Boolean(candidate.streaming) && !candidate.listening,trimStart:Boolean(candidate.listening)}) : undefined,
    onReaction: result => {
      const applied=playPerformance({...result,performance:result.performance ?? 'nod'}, {source:'reaction'})
      const reactionText=result.text || (applied.motion || applied.performance!=='idle' ? '（姿态回应）' : '（暂不表演）')
      const characterId=characterKey(profiles.snapshot())
      room.add('assistant',reactionText,{status:'completed',delivery:'reaction',engine:'deepseek',model,characterId,sticker:result.sticker,performance:applied.motion ? 'sequence' : applied.performance,motionLabel:applied.motion?.label})
      scene.add('assistant',result.text || (applied.motion || applied.performance!=='idle' ? '非语音回应' : '动作未执行'),{engine:'deepseek',characterId,delivery:'reaction'})
    },
    plan:(planner || apiKey) ? async (snapshot, options) => {
      const offered=stickers.select()
      const profile=profiles.snapshot()
      const characterId=characterKey(profile)
      const evidence=scene.snapshot('deepseek',characterId)
      const coachingContext=handbook.capture({snapshot,characterId,session:room.session,evidence})
      const information=directorTools.session({characterId,signal:AbortSignal.any([lifetime.signal,...(options.signal?[options.signal]:[])]),
        urls:(snapshot.latestHost?.text?.match(/https?:\/\/[^\s<>"）)]+/g)??[]).map(url=>url.replace(/[.,;，。；]+$/,'')),
        readLive:()=>({clock:liveClock(),live,mode:director.mode,muted:scheduler.muted,hostSpeaking:scheduler.hostSpeaking,latestHost:director.utterance,
          topic:scene.topic,hosting:hosting.context(scheduler),playing:scheduler.active?{delivered:scheduler.active.answer.slice(0,scheduler.active.playedChars??0).slice(-500),current:scheduler.active.playingSegment??null}:null,
          recentMessages:scene.snapshot('deepseek',characterId).slice(-8).map(({role,text})=>({role,text:text.slice(-500)}))})})
      let result
      try {result=await (planner ?? (participationStreaming?streamParticipation:planParticipation))({...snapshot,scene:evidence,history:memory.history(characterId),directorHandbook:handbook.context(characterId),coachingWritable:Boolean(coachingContext),recentPerformancePlans:performance.recentPlans(characterId,performanceTarget(profile.capabilities)),stickers:offered},{...options,apiKey,model,profile,information})}
      finally {await information.close()}
      if(characterKey(profiles.snapshot())!==characterId) {result.replyStream?.close();throw new Error('Character changed during participation')}
      const commitCoaching=value=>{
        if(lifetime.signal.aborted || options.signal?.aborted)return
        const saved=handbook.learn(value,coachingContext,{characterId:characterKey(profiles.snapshot()),session:room.session,host:director.utterance})
        if(saved && saved.operation!=='unchanged')director.record('hold','director_handbook',{
          explanation:saved.error??(saved.operation==='forget'?'已移除导演反馈。':`导演手册${store?'已保存':'已临时记录（重启不保留）'}：${saved.note.situation}；${saved.note.guidance}`)})
      }
      result.commitCoaching=()=>commitCoaching(result.coaching)
      if(result.replyStream) {
        const original=result.replyStream
        const wrapped=Object.create(original)
        let closed=false
        wrapped.close=()=>{closed=true;original.close()}
        wrapped[Symbol.asyncIterator]=async function*() {
          let coaching=result.coaching
          for await(const record of original) {
            if(record.coaching)coaching=record.coaching
            yield record
          }
          // A completed generation acknowledges the instruction, independently of
          // audio delivery. Cancelled/failed streams never reach this commit.
          if(!closed)commitCoaching(coaching)
        }
        result.replyStream=wrapped
      }
      if (result.replyStream) result.replyStream.resolveSticker=id=>stickers.resolve(id,offered)
      return {...profiles.filter(result,performanceTarget(profile.capabilities)),sticker:stickers.resolve(result.stickerId,offered)}
    } : null, enabled:semanticEnabled && Boolean(apiKey || planner) })
  function playPerformance(result, options={}, offered) {
    const filtered=profiles.filter(result,offered)
    performance.play(filtered.performance,{...options,scope:characterKey(profiles.snapshot()),motion:filtered.motion,target:filtered.performanceTarget,issues:filtered.performanceIssues})
    return filtered
  }
  function acceptDanmaku(message) {
    if(!scheduler.enqueue(message))return false
    const fields={userId:message.userId,displayName:message.displayName,platform:message.platform,messageId:message.id,real:message.real===true}
    scene.add('viewer',message.text,fields)
    room.add('viewer',message.text,fields)
    hosting.input()
    participation.notify()
    return true
  }
  const BilibiliSource=(bilibiliOptions.source ?? process.env.BILIBILI_SOURCE)==='blivechat'?BlivechatRelay:BilibiliLive
  let bilibili=new BilibiliSource({...bilibiliOptions,onMessage:acceptDanmaku})
  let reloadingBilibili=false
  function directorEvent(body) {
    if(body.type==='speech-start')hosting.cancelReview()
    if(['topic-change','mode','interrupt'].includes(body.type))hosting.pause('control')
    const previousRevision = director.revision
    const wasFinal=director.utterance?.final
    const result = director.event(body)
    if (director.revision !== previousRevision || director.intent==='stop') participation.invalidate({clearThought:['topic-change','mode','interrupt'].includes(body.type) || director.intent==='stop',
      preserveFloor:body.type==='transcript' && body.final && director.intent!=='stop',
      preserveOpening:director.intent!=='stop' && ['speech-start','speech-progress','transcript'].includes(body.type),
      preserveAnswer:body.type==='transcript' && body.final && director.intent!=='stop' && participation.answerPreparation.matches(body.utterance,body.text)})
    if (director.revision !== previousRevision && (['topic-change','mode'].includes(body.type) || (body.type==='speech-start' && !scheduler.active))) performance.clear()
    if(body.type==='transcript' && body.final && !wasFinal && result.utterance===body.utterance && director.intent!=='stop')hosting.input()
    if (body.type === 'topic-change') scene.nextTopic()
    participation.notify()
    consumeCandidate()
    return result
  }
  let changingSpeech = false
  let changingServices = false
  const voice = new WindowsVoice({ ...voiceOptions,
    onSpeech: body => {
      directorEvent(body)
      if (body.type === 'transcript' && body.final) {
        const entry = room.entries.findLast(item => item.role === 'host' && item.utterance === body.utterance)
        if (entry) room.update(entry, {input:'microphone'})
      }
    },
    onPlayback: body => {
      const turn=scheduler.active
      const entry = room.entries.find(item => item.role === 'assistant' && item.turn === body.turn)
      const accepted = scheduler.playbackEvent(body)
      if (accepted && body.event === 'started') performance.start(body.turn)
      if (accepted && entry) room.update(entry, {status: body.event === 'ended' ? 'completed' : body.event === 'error' ? 'failed' : body.event === 'stopped' ? 'cancelled' : 'speaking', playedChars:body.playedChars, ...(body.event === 'error' ? {errorCode:'speech_playback_failed'} : {})})
      if(accepted && turn?.playedChars) rememberDelivered(turn,turn.answer.slice(0,turn.playedChars))
      persistence.flush()
      return accepted
    },
    onStop: () => {
      participation.invalidate({clearThought:true})
      director.reset('voice_stopped', {clearSpeech:true})
      if (scheduler.active?.voiceOwned) scheduler.interrupt()
    },
  })
  const airi = new AiriVoice({...airiOptions, recognition:()=>modules.snapshot('recognition').value, onCaptureStop:() => {
    speech.cancelWarmth()
    if(airi.session?.utterance && director.utterance?.id===airi.session.utterance) {
      participation.invalidate()
      director.reset('capture_stopped',{clearSpeech:true})
    }
  }, onStop:() => {
    speech.cancelWarmth()
    participation.invalidate({clearThought:true})
    director.reset('voice_stopped', {clearSpeech:true})
    if (scheduler.active?.airiRun) scheduler.interrupt()
  }})
  function playback(body) {
    const turn=scheduler.active
    if(body.event==='started' && turn?.listening && !director.canSpeakListening(turn.listening.text)) {
      scheduler.interrupt('host_resumed');return false
    }
    const entry = room.entries.find(item => item.role === 'assistant' && item.turn === body.turn)
    const accepted = scheduler.playbackEvent(body)
    if (accepted && body.event === 'started') performance.start(body.turn)
    if (accepted && body.event === 'ended') performance.finish(body.turn)
    if (accepted && ['error','stopped'].includes(body.event)) performance.cancel(body.turn)
    if (accepted && entry) room.update(entry, {status:body.event === 'ended' ? 'completed' : body.event === 'error' ? 'failed' : body.event === 'stopped' ? 'cancelled' : 'speaking',playedChars:body.playedChars, ...(body.event === 'started' ? {firstAudioMs:Date.now()-entry.at} : {}), ...(body.event === 'error' ? {errorCode:'speech_playback_failed'} : {})})
    if(accepted && turn?.playedChars) rememberDelivered(turn,turn.answer.slice(0,turn.playedChars))
    persistence.flush()
    return accepted
  }
  director.onRecord = entry => {
    // Do not evict restored bubbles just to display the startup mode switches.
    if((roomSnapshot || recovered) && initializing)return
    if (entry.action === 'stop') {hosting.pause('stop');performance.clear()}
    if (entry.reason === 'needs_semantic_evidence' && participation.enabled) entry = {...entry, explanation:'我正在听这句话的意思，判断该接话还是继续等。'}
    const previous = room.entries.at(-1)
    // The transcript and speech-end can repeat one rule decision; show one explanation.
    if (previous?.role === 'director' && previous.reason === entry.reason &&
      previous.action === entry.action && previous.directorRevision === entry.revision) return
    room.add('director', '', { action: entry.action, reason: entry.reason, traceId: entry.id,
      directorRevision: entry.revision, at: entry.at, explanation:entry.explanation, decisionMs:entry.decisionMs,
      errorCode:entry.errorCode,performanceWarnings:entry.performanceWarnings })
  }
  director.onTranscript = ({ text, utterance }) => { room.host(text, utterance); scene.host(text, utterance) }
  function rememberDelivered(turn,answer) {
    if(turn.input.source==='preview')return
    const record=memory.remember(turn,answer,scene.topic)
    if(record.complete && turn.input.engine==='deepseek')continuity.commit(turn.continuation)
    scene.delivered(answer,{engine:turn.input.engine??'deepseek',characterId:turn.characterId,deliveryId:turn.deliveryId,delivery:turn.delivery,
      deliveryState:record.complete?'complete':record.interrupted?'interrupted':'partial'})
    persistence.schedule()
  }
  scheduler.onDelivered = (input, answer, turn) => {
    if (input.source === 'preview') return
    const engine = input.engine ?? 'deepseek'
    rememberDelivered(turn,answer)
    if(engine==='deepseek' && input.pendingThoughtId!==undefined)participation.thought.take(input.pendingThoughtId,scene.topic)
  }
  if (rehearsal) {
    director.event({type:'mode',value:'auto'})
    director.event({type:'viewer-window',value:true})
  }
  initializing=false
  persistence.schedule();persistence.flush()
  async function executeTurn(turn, engine, delivery = 'text', response) {
      if(engine==='deepseek')hosting.track(turn)
      performance.clear()
      turn.controller.signal.addEventListener('abort',()=>performance.cancel(turn.id),{once:true})
      turn.input.engine = engine
      turn.characterId=characterKey(profiles.snapshot())
      turn.deliveryId=randomUUID()
      const carriedThought=engine==='deepseek'?participation.thought.snapshot(scene.topic):null
      if(carriedThought)turn.input.pendingThoughtId=carriedThought.id
      turn.voiceOwned = Boolean(voice.worker)
      turn.airiRun = airi.session?.ready && engine !== 'mock' ? airi.session.id : null
      if(!turn.listening)turn.canStart=()=>isBackchannel(director.listening.text)
      turn.speechRevision = speech.revision
      turn.timings = { ...turn.timings, executionAt: Date.now() }
      turn.speechBoundaries = []
      turn.speechStyle = normalizeSpeechStyle(turn.speechStyle)
      turn.delivery = turn.airiRun ? 'audio' : voice.ready && voice.output && engine === 'deepseek' ? 'audio' : delivery ?? 'text'
      turn.controller.signal.addEventListener('abort', () => {
        turn.timings.cancelRequestedAt = Date.now()
        if(turn.playedChars)rememberDelivered(turn,turn.answer.slice(0,turn.playedChars))
        if (turn.voiceOwned) voice.cancel(turn.id)
        const entry = room.entries.find(item => item.role === 'assistant' && item.turn === turn.id)
        if (entry && !['completed','failed'].includes(entry.status)) room.update(entry, {
          status:turn.controller.signal.reason==='speech_timeout'?'failed':'cancelled', playedChars:turn.playedChars,
          interruptionReason:typeof turn.controller.signal.reason==='string' ? turn.controller.signal.reason : 'interrupted',
          timings:{...turn.timings},
          ...(turn.controller.signal.reason==='speech_timeout'?{errorCode:'speech_playback_failed'}:{})
        })
      }, {once:true})
      const turnProfile=profiles.snapshot()
      const offeredPerformance=turn.performanceTarget ?? performanceTarget(turnProfile.capabilities)
      const initialPerformance=turn.performance || turn.motion ? playPerformance(turn,{turn:turn.id,audioId:turn.airiRun ? turn.audioId : undefined,defer:turn.delivery==='audio'},offeredPerformance) : undefined
      const answerSession = room.session
      const generatedAt = Date.now()
      const answerEntry = room.add('assistant', '', { turn: turn.id, engine, model: engine === 'mock' ? '模拟回复' : model,
        inferenceRevision:modules.snapshot('inference').revision,profileRevision:turnProfile.revision,
        delivery:turn.delivery,playedChars:0,characterId:turn.characterId,deliveryId:turn.deliveryId,
        speechStyle:turn.speechStyle, sticker:turn.sticker, performance:initialPerformance?.motion ? 'sequence' : initialPerformance?.performance, motionLabel:initialPerformance?.motion?.label, source: turn.input.source, replyingTo: turn.input.text, status: 'generating', firstMs: null, decisionMs:turn.decisionMs, speechRevision:turn.speechRevision })
      const updateAnswer = fields => room.update(answerEntry, fields)
      response?.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      const send = value => { if (response && !response.destroyed) response.write(`${JSON.stringify({ ...value, turn: turn.id, audioId: turn.audioId })}\n`) }
      const disconnected = () => {
        if (response && !response.writableEnded && scheduler.isCurrent(turn)) scheduler.interrupt()
        if (response && !response.writableEnded) updateAnswer({ status: 'cancelled' })
      }
      response?.on('close', disconnected)
      send({ type: 'start', engine, model: engine === 'mock' ? '模拟回复' : model, turn: turn.id, source: turn.input.source, entry: { ...answerEntry }, session: answerSession })
      let completed = false
      try {
        const chunks = turn.preparedReply && engine !== 'mock' ? [turn.preparedReply] :
          (engine === 'mock' ? mockReply : reply)({ apiKey, model, history:memory.history(turn.characterId,engine), scene:scene.snapshot(engine,turn.characterId), currentTopic:scene.topic, pendingThought:carriedThought, continuity:engine==='deepseek'?{...continuity.context(turn.characterId,scene.topic),directorHandbook:handbook.context(turn.characterId)}:{},input: turn.input, profile:turnProfile, signal: turn.controller.signal })
        const present = (name,motion) => {
          if (scheduler.isCurrent(turn)) {
            const filtered=playPerformance({performance:name,motion},{turn:turn.id,audioId:turn.airiRun ? turn.audioId : undefined,defer:turn.delivery==='audio' && turn.playback!=='playing'},offeredPerformance)
            updateAnswer({performance:filtered.performance,motionLabel:filtered.motion?.label})
          }
        }
        async function* preparedChunks() {
          for await (const record of turn.replyStream) {
            if (!scheduler.isCurrent(turn)) return
            if (record.kind==='speech') yield record.text
            else {
              if(record.continuation && turn.continuationContext)turn.continuation=continuity.prepare(record.continuation,turn.continuationContext)
              if (record.performance || record.motion) present(record.performance ?? 'idle',record.motion)
              const sticker=turn.replyStream.resolveSticker?.(record.stickerId)
              if (sticker) updateAnswer({sticker})
            }
          }
        }
        for await (const chunk of turn.replyStream ? preparedChunks() : performedText(styledText(chunks, style => { if (scheduler.isCurrent(turn)) { turn.speechStyle=style; updateAnswer({speechStyle:style}) } }),present)) {
          if (!scheduler.isCurrent(turn)) break
          turn.answer += chunk
          if (turn.replyStream) turn.speechBoundaries.push(turn.answer.length)
          turn.timings.firstTextAt ??= Date.now()
          updateAnswer({ text: turn.answer, firstMs: answerEntry.firstMs ?? Date.now() - generatedAt })
          send({ type: 'delta', text: chunk, entry: { ...answerEntry }, session: answerSession })
        }
        if (scheduler.isCurrent(turn)) {
          completed = true
          updateAnswer({ status: turn.delivery === 'audio' ? (turn.playback === 'playing' ? 'speaking' : 'awaitingPlayback') : 'completed' })
          send({ type: 'done', awaitingPlayback: turn.delivery === 'audio', entry: { ...answerEntry }, session: answerSession })
        } else {
          updateAnswer({ status: 'cancelled' })
          send({ type: 'cancelled', entry: { ...answerEntry }, session: answerSession })
        }
      } catch (error) {
        const message = error.name === 'TimeoutError' ? '模型响应超时，请稍后重试' : '模型调用失败，请检查服务端密钥、额度和网络'
        updateAnswer({ status: turn.controller.signal.aborted ? 'cancelled' : 'failed', error: turn.controller.signal.aborted ? undefined : message })
        send({ type: turn.controller.signal.aborted ? 'cancelled' : 'error', message, entry: { ...answerEntry }, session: answerSession })
      } finally {
        turn.replyStream?.close()
        turn.timings.generationFinishedAt = Date.now()
        updateAnswer({timings:{...turn.timings}})
        if (completed) {
          scheduler.finish(turn)
          if(turn.delivery==='text')updateAnswer({playedChars:turn.answer.length})
          if (turn.voiceOwned && turn.delivery === 'audio' && scheduler.isCurrent(turn)) {
            if (scheduler.hostSpeaking || !voice.speak(turn)) {
              updateAnswer({status:'cancelled', error:'主播正在讲话或语音已关闭，未朗读这轮回复'})
              scheduler.interrupt()
            }
          }
        }
        else { performance.cancel(turn.id); if (scheduler.isCurrent(turn)) scheduler.interrupt() }
        persistence.flush()
        response?.end()
        response?.off('close', disconnected)
      }
  }
  const snapshot = () => ({ directorKnowledge:{handbookRevision:handbook.value.revision,toolsRevision:directorTools.revision}, ...scheduler.status(), live, bilibili:bilibili.status(), configuration:{provider:'DeepSeek', model, persona:profiles.snapshot().name, recognition:modules.snapshot('recognition').value.model,catalogRevision:catalog.status().revision,inferenceRevision:modules.snapshot('inference').revision,recognitionRevision:modules.snapshot('recognition').revision, speech:speech.snapshot().model, voice:speech.voice, speechBackend:speech.engine,speechRevision:speech.revision,cardId:profiles.snapshot().cardId,cardFingerprint:profiles.snapshot().cardFingerprint,profileStage:profiles.snapshot().stage,profileRevision:profiles.snapshot().revision}, director: director.status(), participation:participation.status(), hosting:hosting.status(), deepseekConfigured: Boolean(apiKey), model, persona:profiles.snapshot().name, voice:voice.snapshot(), airi:airi.snapshot(), performance:{...performance.snapshot({...scheduler.status(),target:performanceTarget(profiles.snapshot().capabilities), thinking:participation.status().busy}),session:room.session}, room: room.status(), sessionMemory:{...persistence.status(),turns:memory.history(characterKey(profiles.snapshot())).length/2,characterId:characterKey(profiles.snapshot()),continuity:continuity.status(characterKey(profiles.snapshot()),scene.topic)}, queue: scheduler.queue.map(item => ({id:item.id,platform:item.platform,userId:item.userId,text:item.text,mentioned:item.mentioned,selected:item.selected,expiresAt:scheduler.viewerExpiresAt(item)})), stage: '本机直播试播；AIRI 云端语音与口型，Windows 语音备用' })
  const statusStream = new StatusStream(snapshot)
  function handbookState() {
    const characterId=characterKey(profiles.snapshot())
    return {...handbook.status(characterId),manual:directorManual,tools:directorTools.status(characterId)}
  }
  const server = createServer(async (request, response) => {
    response.once('finish',()=>persistence.flush())
    const connection = new AbortController()
    const disconnected={signal:AbortSignal.any([connection.signal,lifetime.signal]),abort:()=>connection.abort()}
    response.on('close',()=>{if(!response.writableEnded)connection.abort()})
    try {
      if(lifetime.signal.aborted)throw new HttpError(503,'直播服务正在关闭')
      const path = request.url?.split('?')[0]

      const stageOrigin = request.headers.origin
      const stageOrigins = ['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:5174','http://localhost:5174']
      const stagePath = path?.startsWith('/api/airi/stage/')
      const localStage = stageOrigins.includes(stageOrigin) && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
      if (!stagePath && path?.startsWith('/api/') && stageOrigin) {
        if (!localStage && stageOrigin !== 'http://' + request.headers.host) throw new HttpError(403, '不接受此页面的控制请求')
        if (localStage) {
          response.setHeader('Access-Control-Allow-Origin', stageOrigin)
          response.setHeader('Vary', 'Origin')
          if (request.method === 'OPTIONS') {
            response.writeHead(204, {'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type'})
            response.end(); return
          }
        }
      }
      if (stagePath) {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || !stageOrigins.includes(stageOrigin))
          throw new HttpError(403, '仅接受本机 AIRI 舞台')
        response.setHeader('Access-Control-Allow-Origin', stageOrigin)
        response.setHeader('Vary','Origin')
        if (request.method === 'OPTIONS') {
          response.writeHead(204, {'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Cohost-Capture'})
          response.end(); return
        }
        if (request.method !== 'POST') throw new HttpError(405,'请使用 POST')
        if (path === '/api/airi/stage/pulse') {
          const body = await readBody(request, path === '/api/runtime-profile' ? 65536 : 16384)
          const expectedStage = stageOrigin.endsWith(':5174') ? 'desktop' : 'web'
          if (body.stage !== expectedStage) throw new HttpError(403, '舞台类型不匹配')
          const wasListening=airi.session?.captureReady
          consumeCandidate()
          const pulse=airi.pulse(body,scheduler.active)
          if(!wasListening && airi.session?.captureReady && participation.enabled && director.mode==='auto')hosting.observe()
          json(response,200,pulse);return
        }
        const session = airi.authenticate(request)
        if ((stageOrigin.endsWith(':5174') ? 'desktop' : 'web') !== session.stage) throw new HttpError(403,'舞台类型不匹配')
        if (path === '/api/airi/stage/audio/transcriptions') {
          if(modules.snapshot('recognition').value.provider!=='siliconflow')throw new HttpError(409,'请使用当前实时识别配置')
          const captureRevision=Number(request.headers['x-cohost-capture'])
          if(!airi.acceptsCapture(captureRevision))throw new HttpError(409,'收音批次已失效')
          if (!request.headers['content-type']?.startsWith('multipart/form-data;')) throw new HttpError(415,'需要音频上传')
          let size=0;const chunks=[]
          for await (const chunk of request) {size+=chunk.length;if(size>2_000_000)throw new HttpError(413,'录音过长，请说短句');chunks.push(chunk)}
          const form = await new Request('http://127.0.0.1',{method:'POST',headers:{'Content-Type':request.headers['content-type']},body:Buffer.concat(chunks)}).formData()
          const file = form.get('file')
          if (!(file instanceof Blob) || file.size<44 || file.size>1_950_000) throw new HttpError(400,'无效音频')
          const upload=new FormData();upload.set('model',modules.snapshot('recognition').value.model);upload.set('file',file,'recording.wav')
          if(!airi.acceptsCapture(captureRevision))throw new HttpError(409,'收音批次已失效')
          json(response,200,await airi.cloud('transcriptions',upload,{signal:disconnected.signal}));return
        }
        const body = await readBody(request, path.startsWith('/api/airi/stage/recognition/') ? 24000 : path === '/api/runtime-profile' ? 65536 : 16384)
        if(path.startsWith('/api/airi/stage/recognition/')) {
          const revision=Number(request.headers['x-cohost-capture'])
          if(!airi.acceptsCapture(revision))throw new HttpError(409,'收音批次已失效')
          if(path.endsWith('/prepare')) {await airi.prepareRecognition(revision,disconnected.signal);json(response,200,{ready:true});return}
          if(path.endsWith('/open')) {
            const task=airi.openRecognition(body.utterance,revision,event=>{
              if(event.type==='partial' && event.text.trim() && airi.acceptsCapture(revision) && session.utterance===body.utterance)
                directorEvent({type:'speech-progress',utterance:body.utterance,text:event.text,confirmed:event.confirmed})
              if(response.writableLength>64000)disconnected.abort()
              else if(!response.destroyed)response.write(JSON.stringify(event)+'\n')
            },disconnected.signal)
            response.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'})
            response.flushHeaders()
            try{await task.done}catch(error){
              if(airi.acceptsCapture(revision) && director.utterance?.id===body.utterance) {
                if(scheduler.active?.listening)scheduler.interrupt('recognition_failed')
                participation.invalidate();director.reset('recognition_failed')
              }
              if(!response.destroyed)response.write(JSON.stringify({type:'error',message:error.message})+'\n')
            }
            response.end();return
          }
          const task=airi.recognitionSegment(body.utterance,revision)
          if(path.endsWith('/chunk')) {
            if(typeof body.pcm!=='string'||body.pcm.length>22000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.pcm))throw new HttpError(400,'无效音频编码')
            task.write(Buffer.from(body.pcm,'base64'),body.sequence)
          }else if(path.endsWith('/finish')) {
            task.finish(body.sequence).catch(()=>{})
            participation.recognitionFinishing(body.utterance)
          }else throw new HttpError(404,'未找到')
          json(response,200,{accepted:true});return
        }
        if (path === '/api/airi/stage/event') {
          if (body.type === 'floor' || body.type === 'playing-segment') {
            const turn=scheduler.active
            if(!turn || turn.airiRun!==session.id || body.turn!==turn.id || body.audioId!==turn.audioId) {json(response,200,{accepted:false});return}
            if(body.type==='floor') {
              if(!airi.acceptsCapture(body.captureRevision) || body.utterance!==session.utterance || !['play','hold','yield'].includes(body.state)) {json(response,200,{accepted:false});return}
              turn.floorState=body.state
              if(body.state==='yield')scheduler.interrupt('host_takeover')
            } else {
              if(typeof body.text!=='string' || body.text.length>500 || !turn.answer.includes(body.text) || !Number.isFinite(body.offsetMs) || body.offsetMs<0)throw new HttpError(400,'无效播放位置')
              turn.playingSegment={text:body.text,offsetMs:body.offsetMs,at:Date.now(),partialDeliveryUnknown:true}
            }
            json(response,200,{accepted:true});return
          }
          if (body.type === 'capture-error') {
            const accepted=airi.acceptsCapture(body.captureRevision)
            if(accepted)airi.setCapture(session.control,false,'麦克风不可用，请检查设备后重新开始收音')
            json(response,200,{accepted});return
          }
          if (body.type === 'error') {airi.stop('AIRI 语音启动或播放失败，请重新开启');json(response,200,{accepted:true});return}
          if (body.type === 'stopped') {airi.stop();json(response,200,{accepted:true});return}
          if (body.type === 'timing') {
            const turn = scheduler.active
            const accepted = Boolean(turn?.airiRun === session.id && body.turn === turn.id && body.audioId === turn.audioId && body.point === 'playback-scheduled' && turn.playback === 'playing')
            if (accepted) {
              turn.timings.playbackScheduledReceiptAt ??= Date.now()
              const entry = room.entries.find(item => item.role === 'assistant' && item.turn === turn.id)
              if (entry) room.update(entry,{timings:{...turn.timings}})
            }
            json(response,200,{accepted});return
          }
          if (body.type === 'playback') {
            if (scheduler.active?.airiRun !== session.id) {json(response,200,{accepted:false});return}
            const turn = scheduler.active
            if (body.event === 'started' && body.turn === turn.id && body.audioId === turn.audioId) {
              turn.timings.playbackRequestedAt ??= Date.now()
              const entry = room.entries.find(item => item.role === 'assistant' && item.turn === turn.id)
              if (entry) room.update(entry, {timings:{...turn.timings}})
            }
            json(response,200,{accepted:playback(body)});return
          }
          if (!['speech-start','speech-end','speech-pause','transcript'].includes(body.type) || !Number.isSafeInteger(body.utterance) || body.utterance <= 0) throw new HttpError(400,'无效语音事件')
          if(!airi.acceptsCapture(body.captureRevision)){json(response,200,{accepted:false});return}
          if (body.type === 'speech-start') {
            if (body.utterance <= (session.utterance ?? 0)) {json(response,200,{accepted:false});return}
            session.utterance=body.utterance
          } else if(body.utterance !== session.utterance) {json(response,200,{accepted:false});return}
          directorEvent(body)
          if((body.type==='transcript' && body.final) || body.type==='speech-end')airi.acknowledgeRecognition(body.utterance)
          if (body.type === 'transcript' && body.final) {
            const entry=room.entries.findLast(item=>item.role==='host' && item.utterance===body.utterance)
            if(entry)room.update(entry,{input:'microphone',asrMs:airi.asrMs,asrAttempts:airi.asrAttempts})
          }
          json(response,200,{accepted:true});return
        }
        if (path === '/api/airi/stage/audio/speech') {
          const turn=scheduler.active
          if(!turn || turn.airiRun!==session.id || body.turn!==turn.id || turn.controller.signal.aborted) throw new HttpError(409,'话轮已失效')
          if(turn.speechRevision!==speech.revision) throw new HttpError(409,'声音配置已变化')
          turn.timings.ttsRequestedAt ??= Date.now()
          const input=textField(body.input,500)
          if(!turn.answer.includes(input)) throw new HttpError(400,'合成文本不属于当前回复')
          const finishSynthesis=scheduler.beginSynthesis(turn)
          if(!finishSynthesis) throw new HttpError(409,'话轮已失效')
          const trimStart=speech.engine==='qwen' && !turn.speechRequested
          turn.speechRequested=true
          try {
            if (speech.engine !== 'siliconflow') {
              response.writeHead(200, {'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'})
              response.flushHeaders()
              try {
                const options={speechStyle:turn.speechStyle,signal:disconnected.signal,turnSignal:turn.controller.signal,trimStart,
                  emit:event=>{if(event.type==='audio')turn.timings.firstPcmAt ??= Date.now();if(response.writableLength>1_000_000)disconnected.abort();else if(!response.destroyed)response.write(JSON.stringify(event)+'\n')} }
                if(turn.preparedSpeech?.text===input && !turn.preparedSpeech.failed)await turn.preparedSpeech.replay(input,options)
                else await speech.stream(input,options)
              } catch { if(!response.destroyed)response.write(JSON.stringify({type:'error',message:'当前语音服务请求失败或已停止，请查看声音配置。'})+'\n') }
              response.end(); return
            }
            const wav=await airi.cloud('speech',JSON.stringify({model:'FunAudioLLM/CosyVoice2-0.5B',voice:'FunAudioLLM/CosyVoice2-0.5B:'+speech.voice,input,response_format:'wav',sample_rate:24000,stream:false}),{signal:disconnected.signal,turnSignal:turn.controller.signal})
            response.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store'});response.end(wav);return
          } finally { finishSynthesis() }
        }
        throw new HttpError(404,'未找到')
      }
      if (path === '/healthz' && request.method === 'GET') { json(response, 200, { ok: true }); return }
      if (!path?.startsWith('/api/')) throw new HttpError(404, '未找到')
      if (!authorized(request, token)) throw new HttpError(401, '请填写正确的助播访问令牌')
      if(request.method==='GET' && path==='/api/director-handbook') {
        json(response,200,handbookState());return
      }
      if (request.method === 'GET' && path === '/api/stage-performance') {
        json(response,200,{performance:{...performance.snapshot({...scheduler.status(),target:performanceTarget(profiles.snapshot().capabilities),thinking:participation.status().busy}),session:room.session}});return
      }
      if (request.method === 'GET' && path === '/api/bilibili/status') {
        json(response,200,bilibili.status());return
      }
      if (request.method === 'GET' && path === '/api/character/default') { json(response,200,{name:'小鲸鱼',prompt:defaultPersona});return }
      if(request.method==='GET'&&path==='/api/characters'){json(response,200,{catalog:catalog.snapshot(),...catalog.status()});return}
      if(request.method==='GET'&&path==='/api/services/config') {
        json(response,200,{inference:modules.snapshot('inference'),recognition:modules.snapshot('recognition'),persistence:modules.status(),
          inferenceProviders,recognitionProviders,configured:{inference:Boolean(apiKey),recognition:airi.recognitionReady()},busy:Boolean(changingServices||scheduler.active||scheduler.hostSpeaking||participation.job),capture:Boolean(airi.session?.capture)})
        return
      }
      if (request.method === 'GET' && path === '/api/speech/config') {
        json(response,200,{effective:speech.snapshot(),persistence:settings.status(),providers:speechProviders,busy:Boolean(changingSpeech || scheduler.active || scheduler.hostSpeaking || speech.pending.size),preview:scheduler.active?.input.source==='preview'});return
      }
      if (request.method === 'GET' && path === '/api/speech/diagnostics') {
        json(response,200,{measurement:'server receipt timestamps, not physical speaker latency',turns:room.entries.filter(item=>item.timings).slice(-20).map(({turn,source,speechRevision,timings,status})=>({turn,source,speechRevision,timings,status}))});return
      }
      if (request.method === 'GET' && path === '/api/status/events') {
        if (!statusStream.subscribe(response)) throw new HttpError(429, '状态连接过多')
        return
      }
      if (request.method === 'GET' && path === '/api/status') {
        json(response, 200, snapshot())
        return
      }
      if (request.method === 'GET' && path === '/api/tasks') {
        json(response,200,{participation:participation.tasks.status(),semantic:director.tasks.status(),maintenance:continuity.tasks.status()})
        return
      }
      if (request.method !== 'POST') throw new HttpError(405, '请使用 POST')
      // Only the fixed local AIRI origins can use the authenticated control API.
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 application/json')
      if (request.headers['sec-fetch-site'] === 'cross-site' && !localStage) throw new HttpError(403, '不接受跨站请求')
      const body = await readBody(request, path === '/api/characters' ? 1_010_000 : path === '/api/runtime-profile' ? 65536 : 16384)
      if(disconnected.signal.aborted)throw new HttpError(409,'请求已取消')
      if(path==='/api/director-handbook') {
        handbook.edit(body,{characterId:characterKey(profiles.snapshot()),session:room.session})
        json(response,200,handbookState());return
      }
      if(path==='/api/director-tools/check') {
        await directorTools.check(AbortSignal.any([lifetime.signal,disconnected.signal]))
        json(response,200,handbookState());return
      }
      if(path==='/api/characters') {
        const previous=profiles.snapshot()
        const next=catalog.save(body.value,body.revision)
        const current=profiles.snapshot()
        if(characterKey(current)!==characterKey(previous)) {
          hosting.pause('character');participation.invalidate({clearThought:true});director.reset('character_changed',{clearSpeech:true});scheduler.interrupt();performance.clear()
        } else if(current.prompt!==previous.prompt||current.name!==previous.name) {
          participation.invalidate({clearThought:true});director.invalidate('profile_changed')
        }
        json(response,200,{catalog:next,...catalog.status()});return
      }
      if(path==='/api/services/config') {
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))throw new HttpError(403,'配置仅接受本机设置')
        if(changingServices||scheduler.active||scheduler.hostSpeaking||participation.job)throw new HttpError(409,'请等当前发言和判断结束后保存')
        if(!['inference','recognition'].includes(body.module))throw new HttpError(400,'未知服务配置')
        if(body.module==='recognition'&&airi.session?.capture)throw new HttpError(409,'请先关闭麦克风再更换识别配置')
        if(body.revision!==modules.snapshot(body.module).revision)throw new HttpError(409,'配置已在其他窗口更新，请重新载入后保存')
        changingServices=true
        try {
          if(body.module==='inference')await verifyInference(body.value,{...serviceOptions,key:apiKey,signal:disconnected.signal})
          else {
            if(!recognitionProviders.some(item=>item.id===body.value?.provider&&item.models.includes(body.value?.model)))throw new HttpError(400,'识别服务配置无效')
            await airi.verifyRecognition(body.value,disconnected.signal)
          }
          if(disconnected.signal.aborted||scheduler.active||scheduler.hostSpeaking||participation.job||(body.module==='recognition'&&airi.session?.capture))throw new HttpError(409,'现场状态已变化，请重新保存')
          const next=modules.save(body.module,body.value,body.revision)
          if(body.module==='inference'){model=next.value.model;participation.invalidate({clearThought:true});director.reset('config_changed',{clearSpeech:true})}
          json(response,200,next);return
        }finally{changingServices=false}
      }
      if (path === '/api/speech/config') {
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress) ||
          (request.headers.origin && request.headers.origin!=='http://'+request.headers.host && !localStage))throw new HttpError(403,'声音配置仅接受本机设置')
        if(changingSpeech || scheduler.active || scheduler.hostSpeaking || speech.pending.size)throw new HttpError(409,'请等当前发言结束后更换声音')
        if(body.revision !== speech.revision)throw new HttpError(409,'声音配置已在其他窗口更新，请刷新后重试')
        if(!['aqua','index','qwen','siliconflow'].includes(body.engine))throw new HttpError(400,'无效语音服务')
        changingSpeech=true
        let candidate
        try {
          candidate=new SpeechOutput({...speechOptions,...speechSettings(body.engine,body.voice)})
          await candidate.prepare({signal:disconnected.signal})
          if(disconnected.signal.aborted || scheduler.active || scheduler.hostSpeaking || speech.pending.size)throw new HttpError(409,'现场状态已变化，请重新选择声音')
          const saved=settings.saveSpeech({engine:candidate.engine,voice:candidate.voice},body.revision)
          candidate.revision=saved.revision
          participation.invalidate();director.invalidate('speech_changed')
          speech.close();speech=candidate;candidate=undefined
          json(response,200,speech.snapshot())
        } catch(error) {
          if(error.status)throw error
          throw new HttpError(502,'声音设置未完成，请检查语音服务')
        } finally {candidate?.close();changingSpeech=false}
        return
      }
      if (path === '/api/speech/preview') {
        if (body.revision !== speech.revision) throw new HttpError(409,'声音配置已变化，请刷新后试听')
        if (changingSpeech || scheduler.active || scheduler.hostSpeaking || scheduler.muted || voice.worker) throw new HttpError(409,'请结束当前发言并恢复回应后试听')
        const revision = speech.revision
        await speech.prepare({signal:disconnected.signal})
        if (disconnected.signal.aborted || changingSpeech || revision !== speech.revision || scheduler.active || scheduler.hostSpeaking || scheduler.muted) throw new HttpError(409,'现场状态已变化，请重试试听')
        if (!airi.session) {
          const available = airi.snapshot().stages.filter(item => item.ready)
          const target = available.find(item => item.stage === 'desktop') ?? available[0]
          if (!target) throw new HttpError(409,'请先打开小鲸鱼主窗口')
          airi.start(target.stage,target.owner,false,target.owner)
        }
        if (!airi.session.ready) throw new HttpError(409,'语音会话正在准备，请稍后试听')
        const turn = scheduler.begin({source:'preview',text:''})
        turn.preparedReply = '你好，我是小鲸鱼。今天有什么好玩的事情？'
        void executeTurn(turn,'preview')
        json(response,200,{turn:turn.id,revision,stage:airi.session.stage});return
      }
      if (path === '/api/bilibili/reload') {
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))throw new HttpError(403,'弹幕配置仅能在本机更新')
        if(reloadingBilibili)throw new HttpError(409,'正在更新弹幕配置')
        reloadingBilibili=true
        try {
          let env
          try{env=parseEnv(readFileSync(bilibiliEnvPath,'utf8'))}catch{throw new HttpError(400,'本机弹幕配置未完成')}
          const candidate=new BlivechatRelay({config:blivechatConfig(env),onMessage:acceptDanmaku})
          if(env.BILIBILI_SOURCE!=='blivechat' || !candidate.status().configured)throw new HttpError(400,'本机弹幕配置无效')
          await bilibili.stop();bilibili=candidate
          json(response,200,bilibili.status());return
        } finally {reloadingBilibili=false}
      }
      if (path === '/api/bilibili/start' || path === '/api/bilibili/stop') {
        if(reloadingBilibili)throw new HttpError(409,'正在更新弹幕配置')
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))throw new HttpError(403,'B站连接仅能在本机控制')
        json(response,200,path.endsWith('/start')?bilibili.start():await bilibili.stop());return
      }
      if (path === '/api/runtime-profile') {
        const previous=characterKey(profiles.snapshot())
        const revision=profiles.update(body)
        if(characterKey(profiles.snapshot())!==previous) {
          hosting.pause('character');participation.invalidate({clearThought:true});director.reset('character_changed',{clearSpeech:true})
          scheduler.interrupt();performance.clear()
        }
        json(response,200,{revision});return
      }
      if (path === '/api/stickers') {
        stickers.update(body);json(response,200,{ok:true});return
      }
      if (path === '/api/live/start') {
        if (!apiKey) throw new HttpError(503,'请先在本机 .env 配置 DeepSeek')
        if (!live || director.mode !== 'auto' || !director.viewerWindow || !participation.enabled) {
          if (scheduler.active || scheduler.hostSpeaking || voice.worker || airi.session?.capture) throw new HttpError(409,'请在当前发言和收音结束后进入直播模式')
          directorEvent({type:'mode',value:'auto'})
          directorEvent({type:'viewer-window',value:true})
          participation.setEnabled(true)
          live = true
        }
        json(response,200,{live});return
      }
      if (path === '/api/airi/start' || path === '/api/airi/stop' || path === '/api/airi/capture') {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress) ||
          (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host && !localStage)) throw new HttpError(403,'仅接受本机控制台')
        const owner=textField(body.owner,100)
        if(path === '/api/airi/capture') {json(response,200,airi.setCapture(owner,body.capture));return}
        if(path === '/api/airi/start') {
          if(voice.worker || scheduler.active || scheduler.hostSpeaking || changingSpeech) throw new HttpError(409,'请先结束当前发言或停止备用收音')
          await speech.prepare({signal:disconnected.signal})
          if(disconnected.signal.aborted)throw new HttpError(409,'收音启动已取消')
          if(voice.worker || scheduler.active || scheduler.hostSpeaking || changingSpeech) throw new HttpError(409,'现场状态已变化，请重新开启语音')
          const state=airi.start(body.stage,owner,body.capture ?? true,body.renderer)
          if(!state.capture && participation.enabled && director.mode==='auto')hosting.observe()
          json(response,200,state);return
        }
        if(airi.session && airi.session.control!==owner)throw new HttpError(409,'请在开启语音的页面停止')
        airi.stop();json(response,200,airi.snapshot());return
      }
      if (path.startsWith('/api/voice/')) {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new HttpError(403, '收音仅能在本机开启')
        if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) throw new HttpError(403, '收音仅接受当前页面请求')
        const owner = textField(body.owner, 100)
        if (path === '/api/voice/start') {
          if (airi.session) throw new HttpError(409, '请先停止 AIRI 收音')
          if (typeof body.output !== 'boolean') throw new HttpError(400, 'output 需要布尔值')
          if (scheduler.active || scheduler.hostSpeaking) throw new HttpError(409, '请先结束当前发言再开启收音')
          json(response, 200, voice.start(owner, body.output)); return
        }
        if (path === '/api/voice/heartbeat') { json(response, 200, voice.heartbeat(owner)); return }
        if (path === '/api/voice/stop') {
          voice.heartbeat(owner)
          json(response, 200, voice.stop()); return
        }
        throw new HttpError(404, '未找到')
      }
      if (path === '/api/performance') {
        if (body.motion !== undefined && !parseMotionSequence(body.motion)) throw new HttpError(400, '无效动作序列')
        if (!performances.includes(body.name) && !(body.name==='sequence' && body.motion)) throw new HttpError(400, '未知动作')
        if (scheduler.muted || scheduler.active) throw new HttpError(409, '请在未静音且空闲时试演')
        const checked=profiles.filter({performance:body.name,motion:body.motion})
        if(checked.performanceIssues.length)throw new HttpError(422,'当前模型不支持或未授权这个动作：'+checked.performanceIssues.join('、'))
        playPerformance(checked,{source:'preview',durationMs:3000})
        room.add('director','',{action:'hold',reason:'performance_preview',explanation:'我试演一下：' + (body.motion?.label ?? ({idle:'恢复待机',listen:'倾听',think:'思考',nod:'点头',smile:'轻笑',surprise:'惊讶',pout:'嘴硬'})[body.name])})
        json(response,200,{accepted:true});return
      }
      if(path==='/api/hosting') {
        if(!['start','pause','resume','stop'].includes(body.action))throw new HttpError(400,'主持操作无效')
        if(!hosting.acceptsControl(body.revision))throw new HttpError(409,'主持控制已变化，请刷新后重试')
        if(['start','resume'].includes(body.action)) {
          if(!apiKey || !participation.plan)throw new HttpError(503,'请先配置回复模型')
          if(!airi.session?.ready || airi.session.control!==body.owner)throw new HttpError(409,'请先连接当前舞台声音')
          if(body.action==='resume' && hosting.engaged){json(response,200,hosting.status());return}
          if(scheduler.active || scheduler.hostSpeaking || scheduler.muted)throw new HttpError(409,'请等当前说话结束，并恢复回应后再开始')
          if(body.action==='start' && (typeof body.topic!=='string' || body.topic.length>200))throw new HttpError(400,'主题最多200字')
          if(body.action==='resume' && !['paused','waiting'].includes(hosting.state))throw new HttpError(409,'当前主持不能继续，请重新开始')
          participation.invalidate({clearThought:true});director.reset('hosting_changed')
          director.mode='auto';participation.setEnabled(true)
          if(body.action==='start'){hosting.automatic=true;hosting.start(body.topic.trim());if(!body.topic.trim())hosting.state='observing'}else hosting.resume()
          live=true
        } else {
          participation.invalidate({clearThought:true});director.reset('hosting_changed')
          if(body.action==='stop')hosting.stop();else hosting.pause('manual')
          scheduler.interrupt('hosting_control')
        }
        room.add('director','',{action:'hold',reason:'hosting_changed',explanation:body.action==='start'?'接下来由我判断带话题还是听大家聊，不需要你替我选题。':body.action==='resume'?'我接着主持，沿着刚才的话题继续。':body.action==='stop'?'回到助播模式，等你和观众抛话题。':'主持先暂停，你准备好后再让我继续。'})
        participation.lastKey=null;participation.notify()
        json(response,200,hosting.status());return
      }
      if (path === '/api/participation') {
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 需要布尔值')
        if(!body.enabled)hosting.pause('control')
        participation.setEnabled(body.enabled)
        json(response, 200, participation.status()); return
      }
      if (path === '/api/director/event') {
        const state = directorEvent(body)
        if (body.type === 'speech-end' && director.mode === 'manual' && director.utterance?.id === body.utterance &&
          director.utterance.final && !['stop', 'backchannel'].includes(director.intent) &&
          !room.entries.some(x => x.reason === 'manual_wait' && x.utterance === body.utterance))
          room.add('director', '', { action: 'hold', reason: 'manual_wait', utterance: body.utterance })
        json(response, 200, { director: state, participation:participation.status(), ...scheduler.status(), room: room.status() })
        return
      }
      if (path === '/api/playback') {
        if (!Number.isSafeInteger(body.turn) || typeof body.audioId !== 'string' ||
          !['started', 'progress', 'ended', 'stopped', 'error'].includes(body.event) ||
          (body.event !== 'started' && (!Number.isInteger(body.playedChars) || body.playedChars < 0)))
          throw new HttpError(400, '无效播放反馈')
        json(response, 200, { accepted: playback(body), ...scheduler.status() })
        return
      }
      if (path === '/api/host-speaking' || path === '/api/mute') {
        if (typeof body.value !== 'boolean') throw new HttpError(400, 'value 需要布尔值')
        performance.clear()
        participation.invalidate({clearThought:true})
        director.reset(path === '/api/mute' ? 'manual_mute_changed' : 'manual_host_override')
        if (path === '/api/mute') {if(body.value)hosting.pause('muted');scheduler.setMuted(body.value)}
        else scheduler.setHostSpeaking(body.value)
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/interrupt') {
        hosting.pause('manual')
        performance.clear()
        participation.invalidate({clearThought:true})
        director.reset('manual_interrupt')
        scheduler.interrupt('manual_interrupt')
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/reset') {
        hosting.stop()
        if(body.session!==undefined && body.session!==room.session)throw new HttpError(409,'场次已在其他窗口更换，请刷新后重试')
        performance.clear()
        participation.invalidate({clearThought:true}); participation.lastDecision=null; participation.lastKey=null
        scheduler.interrupt()
        scheduler.queue = []
        handbook.clearSession();directorTools.reset()
        scene.clear();memory.clear();continuity.clear();room.clear()
        director.reset('reset', { clearSpeech: true })
        if(!persistence.flush())throw new HttpError(503,'本场记录未能从磁盘清空，请检查本机存储后重试')
        store?.eraseRetiredPages()
        persistence.recovered=false
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/session-memory') {
        if(body.session!==room.session || body.characterId!==characterKey(profiles.snapshot()))throw new HttpError(409,'场次或角色已更换，请刷新后重试')
        if(body.action==='clear-summary')continuity.clearSummary(body.characterId)
        else if(body.action==='remove-item') {
          if(!continuity.remove(textField(body.id,128),body.characterId))throw new HttpError(409,'待续事项已移除')
        } else throw new HttpError(400,'记忆操作无效')
        if(!persistence.flush())throw new HttpError(503,'记忆变更未能保存，请检查本机存储后重试')
        store?.eraseRetiredPages()
        json(response,200,{ok:true});return
      }
      if (path === '/api/danmaku/select') {
        if (!['bilibili', 'wechat', 'manual'].includes(body.platform)) throw new HttpError(400, '平台无效')
        const accepted = scheduler.selectViewer(body.platform, textField(body.id, 128))
        if (!accepted) throw new HttpError(409, '弹幕已经过期或被消费')
        director.invalidate('viewer_selected')
        json(response, 200, { accepted, ...scheduler.status() })
        return
      }
      if (path === '/api/danmaku') {
        if (!['bilibili', 'wechat', 'manual'].includes(body.platform)) throw new HttpError(400, '平台无效')
        const message = {
          id: textField(body.id, 128), platform: body.platform,
          userId: textField(body.userId, 128), text: textField(body.text, 500),
          mentioned: body.mentioned === true, selected: body.selected === true,
        }
        const accepted = acceptDanmaku(message)
        if (accepted) {
          const hostingViewers=scheduler.hostingViewers()
          const reason = director.mode === 'manual' ? 'viewer_manual_wait' :
            scheduler.muted ? 'viewer_muted' :
            !(director.viewerWindow || hostingViewers) ? 'viewer_window_closed' :
            scheduler.hostSpeaking ? 'viewer_host_speaking' :
            scheduler.active ? 'viewer_busy' :
            hostingViewers ? 'viewer_pending' :
            !scheduler.peekViewer() ? 'viewer_ineligible' : null
          const explanations={viewer_muted:'回应已暂停，这条弹幕不会触发发言。',
            viewer_pending:'弹幕已进入待选，我会结合现场挑选，不保证逐条回复。',
            viewer_host_speaking:'搭档正在说话，弹幕先留在待选里。',
            viewer_busy:'我正在说话，弹幕先留在待选里，讲完后再考虑。'}
          if (reason) room.add('director', '', { action: 'hold', reason,
            explanation:reason==='viewer_muted' || hostingViewers ? explanations[reason] : undefined })
        }
        json(response, 200, { accepted, ...scheduler.status(), room: room.status() })
        return
      }
      if (path !== '/api/reply') throw new HttpError(404, '未找到')
      if (airi.session && body.engine === 'mock') throw new HttpError(409,'云端语音请使用真实回复')
      if (airi.session && body.voiceOwner !== airi.session.control) throw new HttpError(409,'请在开启语音的页面控制回复')
      if (voice.worker && body.voiceOwner !== voice.owner) throw new HttpError(409, '请在开启收音的页面控制回复')
      const engine = body.engine ?? 'deepseek'
      if (!['deepseek', 'mock'].includes(engine)) throw new HttpError(400, 'engine 无效')
      if (engine === 'deepseek' && !apiKey) throw new HttpError(503, '请在本机忽略的 .env 配置 DEEPSEEK_API_KEY 并重启，或选择模拟回复')
      if (engine === 'mock' && body.delivery === 'audio') throw new HttpError(400, '模拟回复仅支持文字')
      if (!['host', 'viewer', 'director'].includes(body.source)) throw new HttpError(400, 'source 无效')
      if (body.delivery !== undefined && !['text', 'audio'].includes(body.delivery)) throw new HttpError(400, 'delivery 无效')
      if (body.source === 'director' && !Number.isSafeInteger(body.decision)) throw new HttpError(400, '需要 decision 编号')
      const text = body.source === 'host' ? textField(body.text) : null
      if (body.source === 'host') {
        const utterance = director.utterance?.final && director.utterance.text === text ? director.utterance.id : null
        room.host(text, utterance); scene.host(text, utterance)
      }
      if (engine === 'mock' && body.source === 'director' && director.candidate?.preparedReply) throw new HttpError(409, '切换到模拟回复前请关闭自主参与')
      if (body.source === 'director' && director.candidate?.id !== body.decision) throw new HttpError(409, '决定已经失效')
      participation.invalidate()
      if (body.source !== 'director') {
        director.invalidate('manual_reply')
        if (body.source === 'host' && director.utterance?.text === text) director.consumedUtterance = director.utterance.id
      }
      const turn = body.source === 'host' ? scheduler.beginHost(text) : body.source === 'director' ? director.consume(body.decision) : scheduler.beginViewer()
      if (!turn) throw new HttpError(409, '当前保持安静：主播在说话、已静音、正在回答、冷却中，或没有合适弹幕')
      await executeTurn(turn, engine, body.delivery, response)
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : '服务内部错误' })
      else response.end()
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  const tick = setInterval(() => {
    voice.tick(); airi.tick(); director.status(); hosting.tick(scheduler,Boolean(airi.session?.ready)); participation.notify()
    if(airi.session?.captureReady && scheduler.hostSpeaking && !scheduler.active)void speech.maintainWarmth()
    if(scheduler.active?.listening && !director.canContinueListening())scheduler.interrupt('listening_expired')
    consumeCandidate()
  }, 100)
  function consumeCandidate() {
    const candidate=director.candidate
    if((airi.session?.ready || (live && !airi.session && !voice.worker)) && apiKey && director.mode==='auto' && candidate && !scheduler.active && !participation.awaitingAnswer()) {
      participation.invalidate()
      const turn=director.consume(candidate.id)
      if(turn)void executeTurn(turn,'deepseek')
    }
  }
  tick.unref()
  const shutdown=()=>{
    if(lifetime.signal.aborted)return
    hosting.stop();lifetime.abort();statusStream.close();clearInterval(tick)
    participation.close();directorTools.close();void bilibili.stop().catch(()=>{})
    airi.stop();voice.stop();speech.close();director.close();scheduler.interrupt()
    continuity.close();persistence.close()
  }
  // Cancel producers before waiting for sockets, including long-lived status streams.
  const close=server.close
  server.close=function(callback){shutdown();return close.call(this,callback)}
  server.on('close',shutdown)
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (process.env.COHOST_ACCESS_TOKEN?.length ?? 0) < 24)
    throw new Error('Set COHOST_ACCESS_TOKEN (24+ characters) before binding beyond loopback.')
  const savedRoom=process.argv.find(arg=>arg.startsWith('--room-snapshot='))?.slice('--room-snapshot='.length)
  const server = createApp({semanticEnabled:Boolean(process.env.DEEPSEEK_API_KEY),rehearsal:true,
    sessionPath:process.argv.includes('--no-session-store')?undefined:fileURLToPath(new URL('../../data/cohost-session.sqlite',import.meta.url)),
    roomSnapshot:savedRoom ? JSON.parse(readFileSync(savedRoom,'utf8')) : undefined})
  server.listen(port, host, () => console.log(`文字联调台 http://${host}:${port} — 本机虚拟直播间 · AIRI 语音试播可按需开启`))
  const stop = () => { server.close(); server.closeAllConnections() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
