/** A floor decision applies only to the input revision and output that produced it. */
export type FloorIntent = 'backchannel' | 'takeover' | 'uncertain'
export type FloorAction = 'play' | 'hold' | 'yield'

/** Only standalone acknowledgments qualify. Quotes and extra clauses need semantic review. */
export function isBackchannel(text: string): boolean {
  const words = text.replace(/[\s，,。.!！?？、；;]/gu, '')
  return words.length > 0 && words.length <= 24
    && /^(?:[嗯唔哦噢对]|是的|没错|确实|好的?|明白了?|我在听|你继续(?:说|讲)?|继续(?:说|讲)|接着(?:说|讲))+$/u.test(words)
}

function acknowledgmentPrefix(text: string): boolean {
  const words = text.replace(/[\s，,。.!！?？、；;]/gu, '')
  const tail = words.match(/(?:你继?|我在?)$/u)
  // A partial "你" after an acknowledgment can become "你继续" or a new question.
  // Only a bounded permit survives this unfinished token. The next revision replaces it.
  return Boolean(tail && isBackchannel(words.slice(0, -tail[0].length)))
}

function acknowledgmentTail(text: string): boolean {
  // A short, unstable leading token may precede a clear acknowledgment clause.
  // It earns only a settling window, never a final acknowledgment decision.
  if (/[不没别先等停反]/u.test(text))
    return false
  const clauses = text.split(/[，,]/u)
  if (clauses.length === 2)
    return /^[\p{L}\s]{1,2}$/u.test(clauses[0]) && isBackchannel(clauses[1])
  // The first partial can omit its comma. Only two or three letters can use
  // the same one-time window; further content must pass the ordinary floor rules.
  if (!/^\p{L}{2,3}$/u.test(text))
    return false
  return isBackchannel(text.slice(1)) || isBackchannel(text.slice(2))
}

export function acknowledgmentExtension(source: string, text: string, final: boolean): boolean {
  const previous = source.replace(/[\s，,。.!！?？、；;]/gu, '')
  const current = text.replace(/[\s，,。.!！?？、；;]/gu, '')
  if (!previous || !current.startsWith(previous) || current.length > 24)
    return false
  const unfinished = previous.match(/(?:你继?|我在?)$/u)?.[0] ?? ''
  const added = unfinished + current.slice(previous.length)
  return !added || isBackchannel(added)
    || (!final && (acknowledgmentPrefix(added) || /^(?:你继?|我在?)$/u.test(added)))
}

/**
 * The renderer holds uncertain speech before it cancels an answer.
 * Input revisions revoke old permits. A yield is terminal until the next input.
 */
export class SpeechFloor {
  private text = ''
  private voiced = 0
  private silence = 0
  private evidenceAt = 0
  private permitAt = -Infinity
  private heldAt: number | null = null
  private intent: FloorIntent = 'uncertain'
  private finished = false
  private yielded = false
  private everPermitted = false
  private settlingAt: number | null = null
  private reviewedAcknowledgment = ''

  reset(held = false, now = Date.now()) {
    this.text = ''
    this.voiced = 0
    this.silence = 0
    this.evidenceAt = 0
    this.permitAt = -Infinity
    this.heldAt = held ? this.heldAt ?? now : null
    this.intent = 'uncertain'
    this.finished = false
    this.yielded = false
    this.everPermitted = false
    this.settlingAt = null
    this.reviewedAcknowledgment = ''
  }

  transcript(text: string, final = false, now = Date.now()) {
    if (text !== this.text || final !== this.finished) {
      this.text = text
      const continued = acknowledgmentExtension(this.reviewedAcknowledgment, text, final)
      this.intent = (isBackchannel(text) || (!final && acknowledgmentPrefix(text)) || continued) ? 'backchannel' : 'uncertain'
      if (!continued)
        this.reviewedAcknowledgment = ''
      this.evidenceAt = now
      this.permitAt = this.intent === 'backchannel' ? now : -Infinity
    }
    this.finished = final
    return this.action(now)
  }

  review(text: string, intent: FloorIntent, now = Date.now()) {
    const continued = intent === 'backchannel' && acknowledgmentExtension(text, this.text, this.finished)
    if ((text !== this.text && !continued) || this.yielded)
      return this.action(now)
    this.intent = intent
    this.reviewedAcknowledgment = intent === 'backchannel' ? text : ''
    this.permitAt = now
    return this.action(now)
  }

  observe(speech: boolean, samples: number, now = Date.now()) {
    if (speech) {
      this.voiced += samples
      this.silence = 0
    }
    else {
      this.silence += samples
      if (this.silence >= 2560 && this.heldAt === null)
        this.voiced = 0
    }
    return this.action(now)
  }

  action(now = Date.now()): FloorAction {
    if (this.yielded)
      return 'yield'
    // A stale partial cannot protect an unrelated continuation indefinitely.
    const permitted = this.intent === 'backchannel'
      && (this.finished || now - Math.max(this.evidenceAt, this.permitAt) <= 1200 || this.silence >= 2560)
    if (permitted) {
      this.everPermitted = true
      this.heldAt = null
      return 'play'
    }
    if (this.intent === 'takeover') {
      this.yielded = true
      return 'yield'
    }
    if (this.voiced < 10240 && this.heldAt === null)
      return 'play'
    // Let an arriving first partial settle once, without matching ASR mistakes.
    // This cannot extend on revisions or protect a continuation after an acknowledgment.
    if (this.heldAt === null && acknowledgmentTail(this.text) && !this.finished && !this.everPermitted) {
      this.settlingAt ??= now
      if (now - this.settlingAt < 400)
        return 'play'
    }
    this.heldAt ??= now
    if (now - this.heldAt >= 1800) {
      this.yielded = true
      return 'yield'
    }
    return 'hold'
  }
}
