import type { ReaderLike } from 'clustr'

import type { TextSegment, TextToken } from '../types'

import { readGraphemeClusters } from 'clustr'

import { createPushStream } from '../stream'

export const TTS_FLUSH_INSTRUCTION = '\u200B'
export const TTS_SPECIAL_TOKEN = '\u2063'

const regexpAnySingleDigit = /\d/

const keptPunctuations = new Set('?？!！')
const hardPunctuations = new Set('.。?？!！…⋯～~\n\t\r')
const softPunctuations = new Set(',，、–—:：;；《》「」')

export interface TtsInputChunk {
  text: string
  words: number
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export interface TtsInputChunkOptions {
  /**
   * How many opening chunks may end at soft punctuation instead of waiting for a sentence end.
   *
   * This lowers the time to the first audio. A boost chunk still has to reach `minimumWords`:
   * every TTS request carries a fixed cost that does not shrink with the text, so a two-word
   * fragment delays the audio it was meant to bring forward.
   *
   * @default 2
   */
  boost?: number
  /**
   * Word count a chunk must reach before a boost or a length limit may end it.
   *
   * @default 4
   */
  minimumWords?: number
  /** @default 12 */
  maximumWords?: number
  /**
   * Keep exact source substrings for authorization and played-text receipts.
   * Consecutive punctuation stays with its preceding phrase.
   * @default false
   */
  preserveSourceText?: boolean
  /** Keep punctuation inside one bounded utterance. Defaults to false. */
  wholeUtterance?: boolean
  stripNarrative?: boolean
  keepNarrativeText?: boolean
}

export interface TtsChunkItem {
  chunk: string
  special: string | null
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export async function* chunkTtsInput(
  input: string | ReaderLike,
  options?: TtsInputChunkOptions,
): AsyncGenerator<TtsInputChunk, void, unknown> {
  const {
    boost = 2,
    minimumWords = 4,
    maximumWords = 12,
  } = options ?? {}

  const reader = typeof input === 'string'
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(input))
          controller.close()
        },
      }).getReader()
    : input

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }) // I love Intl.Segmenter

  if (options?.preserveSourceText) {
    yield* chunkSourceText(readSourceGraphemes(reader), segmenter, { boost, minimumWords, maximumWords, wholeUtterance: options.wholeUtterance })
    return
  }

  const iterator = readGraphemeClusters(reader)

  let yieldCount = 0
  let buffer = ''
  let chunk = ''
  let chunkWordsCount = 0

  let previousValue: string | undefined
  let current = await iterator.next()

  while (!current.done) {
    let value = current.value

    // CRLF is one grapheme cluster. Use LF so Windows line endings match
    // the hard punctuation set and end the chunk.
    if (value === '\r\n')
      value = '\n'

    const flush = value === TTS_FLUSH_INSTRUCTION
    const special = value === TTS_SPECIAL_TOKEN
    const hard = hardPunctuations.has(value)
    const soft = softPunctuations.has(value)
    const kept = keptPunctuations.has(value)
    let next: IteratorResult<string, void> | undefined
    let afterNext: IteratorResult<string, void> | undefined

    if (flush || special || hard || soft) {
      switch (value) {
        case '.':
        case ',': {
          if (previousValue !== undefined && regexpAnySingleDigit.test(previousValue)) {
            next = await iterator.next()
            if (!next.done && next.value && regexpAnySingleDigit.test(next.value)) {
              buffer += value
              current = next
              next = undefined
              continue
            }
          }
          else if (value === '.') {
            next = await iterator.next()
            if (!next.done && next.value && next.value === '.') {
              afterNext = await iterator.next()
              if (!afterNext.done && afterNext.value && afterNext.value === '.') {
                value = '…'
                next = undefined
                afterNext = undefined
              }
            }
          }
        }
      }

      if (buffer.length === 0) {
        if (special) {
          yield {
            text: '',
            words: 0,
            reason: 'special',
          }
          yieldCount++
          chunkWordsCount = 0
        }

        previousValue = value
        current = await iterator.next()
        continue
      }

      const words = [...segmenter.segment(buffer)].filter(w => w.isWordLike)

      if (chunkWordsCount > minimumWords && chunkWordsCount + words.length > maximumWords) {
        const text = kept ? chunk.trim() + value : chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'limit',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      chunk += buffer + value
      chunkWordsCount += words.length
      buffer = ''

      if (special) {
        const text = chunk.slice(0, -1).trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'special',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }
      // A boost chunk ends early at soft punctuation only once it is long enough to be worth its
      // own TTS request. A shorter opening clause stays in the chunk and joins the next one.
      else if (flush || hard || chunkWordsCount > maximumWords || (yieldCount < boost && chunkWordsCount >= minimumWords)) {
        const text = chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: flush ? 'flush' : hard ? 'hard' : chunkWordsCount > maximumWords ? 'limit' : 'boost',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      previousValue = value
      if (next !== undefined) {
        if (afterNext !== undefined) {
          current = afterNext
          next = undefined
          afterNext = undefined
        }
        else {
          current = next
          next = undefined
        }
      }
      else {
        current = await iterator.next()
      }
      continue
    }

    buffer += value
    previousValue = value
    next = await iterator.next()
    current = next
  }

  if (chunk.length > 0 || buffer.length > 0) {
    const text = (chunk + buffer).trim()
    yield {
      text,
      words: chunkWordsCount + [...segmenter.segment(buffer)].filter(w => w.isWordLike).length,
      reason: 'flush',
    }
  }
}

/** Flush controls close a source record. Unlike text, they cannot acquire a later combining mark. */
async function* readSourceGraphemes(reader: ReaderLike): AsyncGenerator<string> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { value, done } = await reader.read()
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const segments = [...segmenter.segment(pending)]
    const last = segments.at(-1)
    const committed = last?.segment === TTS_FLUSH_INSTRUCTION || last?.segment === TTS_SPECIAL_TOKEN
    const count = done || committed ? segments.length : Math.max(0, segments.length - 1)
    for (let index = 0; index < count; index++)
      yield segments[index].segment
    pending = count < segments.length ? segments[count].segment : ''
    if (done)
      return
  }
}

async function* chunkSourceText(
  iterator: ReturnType<typeof readGraphemeClusters>,
  segmenter: Intl.Segmenter,
  options: Required<Pick<TtsInputChunkOptions, 'boost' | 'minimumWords' | 'maximumWords'>> & Pick<TtsInputChunkOptions, 'wholeUtterance'>,
): AsyncGenerator<TtsInputChunk, void, unknown> {
  let current = await iterator.next()
  let text = ''
  let yielded = 0
  const closingPunctuation = new Set('”’"\'」』》】）)]}')
  while (!current.done) {
    const value = current.value
    const flush = value === TTS_FLUSH_INSTRUCTION
    const special = value === TTS_SPECIAL_TOKEN
    if (flush || special) {
      if (text.trim() || special) {
        const words = [...segmenter.segment(text)].filter(word => word.isWordLike).length
        yield { text: text.trim(), words, reason: special ? 'special' : 'flush' }
        yielded++
      }
      text = ''
      current = await iterator.next()
      continue
    }
    const next = await iterator.next()
    const hard = hardPunctuations.has(value) || value === '\r\n'
    const soft = softPunctuations.has(value)
    const decimal = (value === '.' || value === ',') && /\d$/.test(text) && !next.done && /^\d/.test(next.value)
    text += value
    current = next
    if ((!hard && !soft) || decimal || options.wholeUtterance)
      continue
    // Keep punctuation runs and closing quotes in the same exact source slice.
    let hasHardBoundary = hard
    while (!current.done
      && (hardPunctuations.has(current.value) || softPunctuations.has(current.value) || closingPunctuation.has(current.value) || current.value === '\r\n')) {
      hasHardBoundary ||= hardPunctuations.has(current.value) || current.value === '\r\n'
      text += current.value
      current = await iterator.next()
    }
    const words = [...segmenter.segment(text)].filter(word => word.isWordLike).length
    const limit = words > options.maximumWords
    const boost = yielded < options.boost && words >= options.minimumWords
    // A tiny lead-in shares synthesis with its continuation. An explicit record flush still releases it immediately.
    const tinyOpening = yielded === 0 && words < options.minimumWords
    if (words > 0 && ((hasHardBoundary && !tinyOpening) || limit || boost)) {
      if (text.trim()) {
        yield { text: text.trim(), words, reason: hasHardBoundary ? 'hard' : limit ? 'limit' : 'boost' }
        yielded++
      }
      text = ''
    }
  }
  if (text.trim())
    yield { text: text.trim(), words: [...segmenter.segment(text)].filter(word => word.isWordLike).length, reason: 'flush' }
}

export async function chunkEmitter(
  reader: ReaderLike,
  pendingSpecials: string[],
  options: TtsInputChunkOptions | undefined,
  handler: (ttsSegment: TtsChunkItem) => Promise<void> | void,
) {
  function sanitizeChunk(text: string) {
    return text
      .replaceAll(TTS_SPECIAL_TOKEN, '')
      .replaceAll(TTS_FLUSH_INSTRUCTION, '')
      .trim()
  }

  try {
    for await (const chunk of chunkTtsInput(reader, options)) {
      const cleanedText = sanitizeChunk(chunk.text)
      if (!cleanedText && chunk.reason !== 'special') {
        continue
      }

      if (chunk.reason === 'special') {
        const specialToken = pendingSpecials.shift()
        await handler({ chunk: cleanedText, special: specialToken ?? null, reason: chunk.reason })
      }
      else {
        await handler({ chunk: cleanedText, special: null, reason: chunk.reason })
      }
    }
  }
  catch (e) {
    console.error('Error chunking stream to TTS queue:', e)
  }
}

const BRACKET_MAP: Record<string, string> = {
  '[': ']',
  '(': ')',
  '（': '）',
  '【': '】',
  '<': '>',
}

const OPENERS = Object.keys(BRACKET_MAP)
const CLOSERS = Object.values(BRACKET_MAP)
const isUnicodeLetter = (char: string) => /\p{L}/u.test(char)

const NARRATIVE_KEYWORDS = [
  'laugh',
  'sigh',
  'action',
  'note',
  'breath',
  'giggle',
  'whisper',
  'cry',
  'smile',
  'thought',
]

export function isProbablyAngleTag(index: number, text: string): boolean {
  if (text[index] !== '<')
    return false

  if (text[index + 1] === '/')
    return true

  const remainder = text.slice(index + 1).toLowerCase()
  const nextChar = remainder[0]
  const prevChar = index > 0 ? text[index - 1] : ''

  // 1. 闭合标签 </... 永远判定为标签
  if (nextChar === '/')
    return true

  // Lookahead: if followed by num, space or equals, not a label
  if (nextChar && /[0-9\s=]/.test(nextChar))
    return false

  if (prevChar && (isUnicodeLetter(prevChar) || /\d/.test(prevChar))) {
    // fix: check whether remainder is piefix with any keywords, or contains the whole keyword
    const isLikelyNarrative = NARRATIVE_KEYWORDS.some(kw =>
      (remainder.length > 1 && kw.startsWith(remainder)) || remainder.startsWith(kw),
    )
    return isLikelyNarrative
  }

  // Lookbehind: if before is non-empty/non-bracket character, then determine as code or any instead of a label
  if (prevChar && /[^\s([{（【<\])}>）】.,!?;:，。！？；：'"\-_]/.test(prevChar))
    return false

  return true
}

export function processNarrative(text: string, options?: TtsInputChunkOptions): string {
  if (!options?.stripNarrative)
    return text

  const rangesToRemove: [number, number][] = []
  const charsToRemove = new Set<number>()

  const stack: { char: string, index: number }[] = []
  let starOpenIndex = -1

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (char === '*') {
      if (starOpenIndex !== -1) {
        if (options?.keepNarrativeText) {
          charsToRemove.add(starOpenIndex)
          charsToRemove.add(i)
        }
        else {
          rangesToRemove.push([starOpenIndex, i])
        }
        starOpenIndex = -1
      }
      else {
        if (!/\s/.test(text[i + 1] || '')) {
          starOpenIndex = i
        }
      }
      continue
    }

    if (OPENERS.includes(char)) {
      if (char === '<' && !isProbablyAngleTag(i, text))
        continue
      stack.push({ char, index: i })
      continue
    }

    if (CLOSERS.includes(char)) {
      const last = stack[stack.length - 1]
      if (last && BRACKET_MAP[last.char] === char) {
        stack.pop()
        if (options?.keepNarrativeText) {
          charsToRemove.add(last.index)
          charsToRemove.add(i)
        }
        else {
          rangesToRemove.push([last.index, i])
        }
      }
    }
  }

  let result = ''

  if (options?.keepNarrativeText) {
    for (let i = 0; i < text.length; i++) {
      if (!charsToRemove.has(i))
        result += text[i]
    }

    return result
  }

  rangesToRemove.sort((a, b) => a[0] - b[0])
  let rangeIndex = 0

  for (let i = 0; i < text.length; i++) {
    while (
      rangeIndex < rangesToRemove.length
      && i > rangesToRemove[rangeIndex]![1]
    ) {
      rangeIndex += 1
    }

    const activeRange = rangesToRemove[rangeIndex]
    if (activeRange && i >= activeRange[0] && i <= activeRange[1])
      continue

    result += text[i]
  }

  return result
}

// ------------------------------------------------------------------
// Data flow processor
// ------------------------------------------------------------------

export function createTtsSegmentStream(
  tokens: ReadableStream<TextToken>,
  meta: { streamId: string, intentId: string, turnId?: string, wholeUtterance?: boolean },
  options?: TtsInputChunkOptions,
) {
  const { stream, write, close, error } = createPushStream<TextSegment>()
  const pendingSpecials: string[] = []
  const encoder = new TextEncoder()

  const { stream: byteStream, write: writeBytes, close: closeBytes, error: errorBytes } = createPushStream<Uint8Array>()

  void (async () => {
    const reader = tokens.getReader()
    let pendingText = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        if (!value)
          continue

        if (value.type === 'literal') {
          if (value.value) {
            if (!options?.stripNarrative) {
              writeBytes(encoder.encode(value.value))
              continue
            }

            pendingText += value.value
            const stack: string[] = []

            for (let i = 0; i < pendingText.length; i++) {
              const char = pendingText[i]
              if (OPENERS.includes(char)) {
                if (char === '<' && !isProbablyAngleTag(i, pendingText)) {
                  continue
                }
                stack.push(char)
              }
              else if (CLOSERS.includes(char)) {
                const lastOpen = stack[stack.length - 1]
                if (lastOpen && BRACKET_MAP[lastOpen] === char) {
                  stack.pop()
                }
              }
            }

            const bracketsUnclosed = stack.length > 0
            const starMatch = pendingText.match(/\*([^*]*)$/)
            const starsUnclosed = (pendingText.match(/\*/g) || []).length % 2 !== 0
              && starMatch !== null && !starMatch[1].startsWith(' ')
            const hasUnclosed = bracketsUnclosed || starsUnclosed
            const hasNarrativeUnclosed = stack.some(char => ['[', '【', '<', '（'].includes(char))
            const fallbackLimit = (options?.stripNarrative && hasNarrativeUnclosed) ? 800 : 200

            if (!hasUnclosed || pendingText.length > fallbackLimit) {
              const textToEmit = processNarrative(pendingText, options)
              writeBytes(encoder.encode(textToEmit))
              pendingText = ''
            }
          }
        }
        else if (value.type === 'special' || value.type === 'flush') {
          if (pendingText) {
            const textToEmit = processNarrative(pendingText, options)
            writeBytes(encoder.encode(textToEmit))
            pendingText = ''
          }

          if (value.type === 'special') {
            pendingSpecials.push(value.value ?? '')
            writeBytes(encoder.encode(TTS_SPECIAL_TOKEN))
          }
          else if (value.type === 'flush') {
            writeBytes(encoder.encode(TTS_FLUSH_INSTRUCTION))
          }
        }
      }
      if (pendingText) {
        let finalPunt = pendingText
        if (options?.stripNarrative) {
          finalPunt = processNarrative(finalPunt, options)
        }
        writeBytes(encoder.encode(finalPunt))
      }
      closeBytes()
    }
    catch (err) {
      errorBytes(err)
    }
    finally {
      reader.releaseLock()
    }
  })()

  void (async () => {
    const reader = byteStream.getReader()
    try {
      await chunkEmitter(reader, pendingSpecials, { ...options, wholeUtterance: meta.wholeUtterance, preserveSourceText: meta.wholeUtterance || options?.preserveSourceText }, async (chunk) => {
        write({
          turnId: meta.turnId,
          streamId: meta.streamId,
          intentId: meta.intentId,
          segmentId: `${meta.streamId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          text: chunk.chunk,
          special: chunk.special,
          reason: chunk.reason,
          createdAt: Date.now(),
        })
      })
      close()
    }
    catch (err) {
      error(err)
    }
    finally {
      reader.releaseLock()
    }
  })()

  return stream
}
