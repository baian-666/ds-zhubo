function failure(status, message) { return Object.assign(new Error(message), { status }) }

/** One delayed duplicate bounds occasional ASR stalls. Only one validated result is delivered. */
export function recognizeCloud({ fetchImpl, key, body, signal, hedgeMs = 2000, timeoutMs = 12000, onAttempt = () => {} }) {
  return new Promise((resolve, reject) => {
    const controllers = new Set()
    let settled = false, attempts = 0, running = 0, hedge, deadline
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(hedge); clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      for (const controller of controllers) controller.abort()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(failure(409, '已丢弃过期语音结果'))
    async function attempt() {
      if (settled || attempts >= 2) return
      attempts++; running++; onAttempt(attempts)
      const controller = new AbortController(); controllers.add(controller)
      try {
        const response = await fetchImpl('https://api.siliconflow.cn/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + key }, body,
          signal: controller.signal, redirect: 'error',
        })
        if (settled) { await response.body?.cancel(); return }
        if (!response.ok) {
          await response.body?.cancel()
          const error = failure(502, '云端语音调用失败，请检查账号额度和网络')
          // Authentication, quota and input errors cannot benefit from duplication.
          if (response.status < 500) { finish(error); return }
          throw error
        }
        const result = await response.json()
        if (!result || typeof result.text !== 'string') throw failure(502, '云端识别返回格式异常')
        finish(null, result)
      } catch (error) {
        if (settled) return
        if (attempts < 2) { clearTimeout(hedge); void attempt() }
        else if (running === 1) finish(failure(502, '云端语音连接失败'))
      } finally { running--; controllers.delete(controller) }
    }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    hedge = setTimeout(() => { void attempt() }, hedgeMs)
    deadline = setTimeout(() => finish(failure(504, '语音识别等待过久，请重说这一句')), timeoutMs)
    void attempt()
  })
}
