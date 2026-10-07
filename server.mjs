/**
 * 英语写作批改老师 —— 本地 Web 服务（零依赖，只用 Node 内置模块）。
 *
 * 路由：
 *   GET  /              前端页面
 *   GET  /api/config    可用模型与 Key 状态
 *   POST /api/review    批改：请求体 {english, chinese, options, model}
 *                       响应为 NDJSON 流，逐行推送 {kind:"card"|"status"|"error"|"done", ...}
 *   POST /api/ask       追问：请求体 {english, chinese, review, question, history, model}
 *                       响应为 NDJSON 流，逐行推送 {kind:"text", text} 增量
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { AVAILABLE_MODELS, PUBLIC_DIR, loadConfig } from './src/config.mjs'
import { streamChat } from './src/llm.mjs'
import {
  REQUIRED_CARD_TYPES,
  buildFollowUpMessages,
  buildRepairMessages,
  buildReviewMessages,
  countEnglishWords,
} from './src/prompts.mjs'

const config = loadConfig()

const MAX_BODY_BYTES = 512 * 1024
const MAX_ENGLISH_CHARS = 20000
const MAX_CHINESE_CHARS = 5000

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('请求内容过大，请缩短文本后再试。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(raw))
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON。'))
      }
    })
    req.on('error', rejectPromise)
  })
}

function pickModel(requested) {
  const known = AVAILABLE_MODELS.map(item => item.id)
  if (typeof requested === 'string' && known.includes(requested)) return requested
  return config.defaultModel
}

function sanitizeOptions(input) {
  const options = input && typeof input === 'object' ? input : {}
  const strictness = ['gentle', 'standard', 'strict'].includes(options.strictness)
    ? options.strictness
    : 'standard'
  const register = ['daily', 'academic', 'business', 'exam', 'email', 'custom'].includes(options.register)
    ? options.register
    : 'daily'
  return {
    strictness,
    register,
    customRegister: typeof options.customRegister === 'string' ? options.customRegister.slice(0, 200) : '',
    wantNative: options.wantNative !== false,
    focus: Array.isArray(options.focus)
      ? options.focus.filter(item => typeof item === 'string').slice(0, 8)
      : [],
  }
}

/** 从模型输出的一行里尽力取出一个 JSON 对象。 */
function extractCard(line) {
  const trimmed = line
    .trim()
    .replace(/^```(?:json|JSON)?/, '')
    .replace(/```$/, '')
    .trim()
  if (!trimmed) return null

  const candidates = [trimmed]
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first > 0 || last < trimmed.length - 1) {
    if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

function startStream(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  return event => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }
}

async function handleReview(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }

  const english = String(body.english ?? '').trim()
  const chinese = String(body.chinese ?? '').trim()

  if (!english) return sendJson(res, 400, { error: '请先把你写的英文粘贴进来。' })
  if (!chinese) return sendJson(res, 400, { error: '请用中文写下你本来想表达的意思，老师才能判断你的英文是否说到位。' })
  if (english.length > MAX_ENGLISH_CHARS) return sendJson(res, 400, { error: `英文太长了（${english.length} 字符），请分段批改，单次不超过 ${MAX_ENGLISH_CHARS} 字符。` })
  if (chinese.length > MAX_CHINESE_CHARS) return sendJson(res, 400, { error: `中文说明太长了，请控制在 ${MAX_CHINESE_CHARS} 字符以内。` })
  if (!config.apiKey) return sendJson(res, 500, { error: '服务端没有找到 DEEPSEEK_API_KEY，请在项目根目录创建 .env 文件写入 DEEPSEEK_API_KEY=你的密钥。' })

  const model = pickModel(body.model)
  const options = sanitizeOptions(body.options)
  const messages = buildReviewMessages({ english, chinese, options }, { model })

  const write = startStream(res)
  const controller = new AbortController()
  // 浏览器中途关闭连接时才中断模型调用（响应正常结束时 writableEnded 为 true）
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const startedAt = Date.now()
  write({ kind: 'start', model, wordCount: countEnglishWords(english) })

  const collected = []
  const droppedLines = []
  let unparsed = 0
  let lastReasoningPing = 0

  const emitLine = line => {
    if (!line.trim()) return
    const card = extractCard(line)
    if (!card) {
      unparsed += 1
      if (droppedLines.length < 3) droppedLines.push(line.trim().slice(0, 200))
      return
    }
    collected.push(card)
    write({ kind: 'card', card })
  }

  /** 跑一轮模型请求，把完整行转成卡片下发。 */
  const consume = async request => {
    let buffer = ''
    for await (const part of streamChat({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      signal: controller.signal,
      ...request,
    })) {
      buffer += part
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        emitLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    }
    emitLine(buffer)
  }

  try {
    await consume({
      model,
      messages,
      temperature: 0.3,
      maxTokens: 8000,
      onReasoning: () => {
        const now = Date.now()
        if (now - lastReasoningPing > 500) {
          lastReasoningPing = now
          write({ kind: 'status', stage: 'thinking' })
        }
      },
    })

    if (collected.length === 0) {
      write({
        kind: 'error',
        message: '模型这次没有按格式返回批改内容，请重试一次；如果反复出现，换用另一个模型试试。',
      })
      return
    }

    // 关键卡片缺失时补一次（模型偶发漏行或写坏一行 JSON）
    const missing = REQUIRED_CARD_TYPES.filter(
      type => !collected.some(card => card.type === type),
    )
    if (missing.length > 0) {
      console.warn(`[review] 模型未返回 ${missing.join('、')}，发起一次补全请求`)
      write({ kind: 'status', stage: 'repair' })
      try {
        await consume({
          model,
          messages: buildRepairMessages({ english, chinese, cards: collected, missing }),
          temperature: 0.2,
          maxTokens: 2000,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn(`[review] 补全请求失败：${error?.message ?? error}`)
      }
    }

    if (droppedLines.length > 0) {
      console.warn(`[review] 丢弃 ${unparsed} 行无法解析的输出，例如：${droppedLines.join(' | ')}`)
    }
    console.log(
      `[review] model=${model} 卡片=${collected.length} 无法解析=${unparsed} 耗时=${Date.now() - startedAt}ms`,
    )

    write({
      kind: 'done',
      cards: collected.length,
      unparsed,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    if (controller.signal.aborted) return
    write({ kind: 'error', message: error?.message ?? String(error) })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

async function handleAsk(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }

  const english = String(body.english ?? '').trim()
  const chinese = String(body.chinese ?? '').trim()
  const question = String(body.question ?? '').trim()
  if (!question) return sendJson(res, 400, { error: '请先写下你的问题。' })
  if (!config.apiKey) return sendJson(res, 500, { error: '服务端没有找到 DEEPSEEK_API_KEY。' })

  const model = pickModel(body.model)
  const messages = buildFollowUpMessages({
    english,
    chinese,
    review: body.review && typeof body.review === 'object' ? body.review : {},
    question: question.slice(0, 4000),
    history: Array.isArray(body.history) ? body.history.slice(-6) : [],
  })

  const write = startStream(res)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    for await (const delta of streamChat({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model,
      messages,
      temperature: 0.4,
      maxTokens: 3000,
      signal: controller.signal,
    })) {
      write({ kind: 'text', text: delta })
    }
    write({ kind: 'done' })
  } catch (error) {
    if (controller.signal.aborted) return
    write({ kind: 'error', message: error?.message ?? String(error) })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const filePath = resolve(join(PUBLIC_DIR, relative))
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: '禁止访问。' })
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: '页面不存在。' })
  }
  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(filePath).pipe(res)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const { pathname } = url

  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        models: AVAILABLE_MODELS,
        defaultModel: config.defaultModel,
        hasApiKey: Boolean(config.apiKey),
        apiKeySource: config.apiKeySource,
      })
    }
    if (pathname === '/api/review') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '请用 POST 请求。' })
      return await handleReview(req, res)
    }
    if (pathname === '/api/ask') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '请用 POST 请求。' })
      return await handleAsk(req, res)
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname)
    return sendJson(res, 405, { error: '不支持的请求方法。' })
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error?.message ?? '服务器内部错误。' })
    else if (!res.writableEnded) res.end()
  }
})

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`
  console.log('英语写作批改老师已启动')
  console.log(`  地址：${url}`)
  console.log(`  默认模型：${config.defaultModel}`)
  console.log(`  API Key：${config.apiKey ? `已就绪（来源：${config.apiKeySource}）` : '✗ 未找到，请在 .env 里配置 DEEPSEEK_API_KEY'}`)
})
