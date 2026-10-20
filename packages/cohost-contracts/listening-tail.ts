/** Finish only the last 180 ms of an already playing, subsecond reaction. */
export function listeningTailMs(durationMs: number, remainingMs: number): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(remainingMs)
    || durationMs <= 0 || durationMs > 700 || remainingMs <= 0 || remainingMs > 180 || remainingMs > durationMs) {
    return 0
  }
  return remainingMs
}
