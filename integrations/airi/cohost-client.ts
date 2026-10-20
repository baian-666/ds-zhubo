/** Shares authenticated local requests across the live panel and native settings page. */
export class CohostClient {
  private readonly pending = new Set<AbortController>()
  constructor(
    private readonly token: () => string,
    private readonly timeoutMessage: () => string,
    private readonly unauthorized: () => void,
  ) {}

  async request(path: string, body?: object): Promise<unknown> {
    const controller = new AbortController()
    this.pending.add(controller)
    const timer = setTimeout(
      () => controller.abort(new Error(this.timeoutMessage())),
      ['speech/config', 'speech/preview', 'airi/start'].includes(path) ? 90000 : path === 'director-tools/check' ? 25000 : 5000,
    )
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.token())
        headers.Authorization = `Bearer ${this.token()}`
      const response = await fetch(`http://127.0.0.1:8787/api/${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (response.status === 401)
        this.unauthorized()
      const data: unknown = await response.json()
      if (!response.ok) {
        const message
          = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : `HTTP ${response.status}`
        throw new Error(message)
      }
      return data
    }
    finally {
      clearTimeout(timer)
      this.pending.delete(controller)
    }
  }

  dispose() {
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
  }
}
