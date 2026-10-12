/** Keeps pause-separated recognition results in speech order until the host finishes. */
export class RecognitionTurns {
  private segments: { utterance: number, text: string | null }[] = []

  begin(utterance: number) {
    if (this.segments.length >= 8)
      return false
    this.segments.push({ utterance, text: null })
    return true
  }

  /** Returns one final transcript for the latest director utterance, regardless of response order. */
  complete(utterance: number, text: string) {
    const segment = this.segments.find(item => item.utterance === utterance)
    if (!segment || segment.text !== null)
      return null
    segment.text = text.trim()
    if (this.segments.some(item => item.text === null))
      return null
    const result = {
      utterance: this.segments[this.segments.length - 1].utterance,
      text: this.segments.map(item => item.text).filter(Boolean).join('，').slice(0, 2000),
    }
    this.reset()
    return result
  }

  reset() {
    this.segments = []
  }
}
