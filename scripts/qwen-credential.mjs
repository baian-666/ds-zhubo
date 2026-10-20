// Accept pasted wrappers without altering characters inside the credential.
// Never include credential content in validation messages.
export function normalizeQwenKey(input) {
  if (typeof input !== 'string') return ''
  let value = input.replace(/^[\s\u200B]+|[\s\u200B]+$/g, '')
  value = value.replace(/^(?:export\s+)?DASHSCOPE_API_KEY\s*=\s*/, '')
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim()
  return value.replace(/^Bearer\s+/i, '').trim()
}

export function qwenKeyIssue(key) {
  if (typeof key !== 'string' || !key) return '请粘贴百炼 API Key。'
  if (/[*…]|\.{3}/.test(key)) return '粘贴的内容含隐藏符号，请使用百炼的复制按钮获取原始 API Key。'
  if (/\s|[\u200B-\u200D\uFEFF]/.test(key)) return '密钥中间含空格或换行，请从百炼复制原始 API Key。'
  // RFC 6750 bearer-token characters; do not assume an undocumented vendor format.
  if (!/^[A-Za-z0-9._~+/-]{16,512}={0,2}$/.test(key)) return '密钥格式无法用于连接，请只粘贴 API Key，不要粘贴网页说明。'
  return null
}

export const keyValid = key => qwenKeyIssue(key) === null
