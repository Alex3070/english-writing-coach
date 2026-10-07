/**
 * DeepSeek（OpenAI 兼容）流式对话客户端。零依赖，只用全局 fetch。
 */

export class LlmError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

/**
 * 以流的方式请求 /chat/completions，逐段 yield 正文增量。
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.baseURL
 * @param {string} options.model
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {string} [options.reasoningEffort] 推理档位（如 low / high / max），留空用接口默认值
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} [options.onReasoning] 思维链增量回调（用于进度提示）
 */
export async function* streamChat({
  apiKey,
  baseURL,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 8000,
  reasoningEffort,
  signal,
  onReasoning,
}) {
  if (!apiKey) throw new LlmError('缺少 DEEPSEEK_API_KEY，无法调用模型', 401)

  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new LlmError(`连接模型接口失败：${error?.message ?? error}`, 502)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new LlmError(
      `模型接口返回 ${response.status} ${response.statusText}${detail ? `：${detail.slice(0, 400)}` : ''}`,
      response.status,
    )
  }
  if (!response.body) throw new LlmError('模型接口没有返回可读流', 502)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue // 忽略心跳/半截数据
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          onReasoning?.(delta.reasoning_content)
        }
        if (typeof delta.content === 'string' && delta.content) yield delta.content
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** 非流式调用，取完整正文（用于探测脚本等简单场景）。 */
export async function completeChat({ apiKey, baseURL, model, messages, temperature = 0.3, maxTokens = 8000, signal }) {
  let text = ''
  for await (const delta of streamChat({ apiKey, baseURL, model, messages, temperature, maxTokens, signal })) {
    text += delta
  }
  return text
}
