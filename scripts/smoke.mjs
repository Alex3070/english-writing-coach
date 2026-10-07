/**
 * 冒烟测试：模拟浏览器调用全部接口，检查流式协议与服务端行为。
 * 用法：先 `npm start`，再 `node scripts/smoke.mjs`（可用 --url 指定地址）
 */
const baseUrl = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:6801'

const SAMPLE = {
  english:
    `Yesterday I go to a new cafe with my friend. The coffee is very good, but the price is a little expensive. ` +
    `I think I will come back again next week, because I want to try their cake. I very like this place.`,
  chinese:
    `昨天我和朋友去了一家新开的咖啡馆。咖啡很好喝，但价格有点贵。我想下周再去一次，因为我想尝尝他们家的蛋糕。我很喜欢这个地方。`,
}

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

/** 读取 NDJSON 流，逐行回调事件。 */
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const event = JSON.parse(line)
      events.push(event)
      onEvent?.(event, events.length)
    }
  }
  return events
}

console.log(`测试目标：${baseUrl}`)
console.log('─'.repeat(70))

// 1. 静态页面
const pageResponse = await fetch(`${baseUrl}/`)
const pageHtml = await pageResponse.text()
check('GET / 返回页面', pageResponse.ok && pageHtml.includes('英语写作批改老师'))

const cssResponse = await fetch(`${baseUrl}/styles.css`)
check('GET /styles.css 返回样式', cssResponse.ok)
const jsResponse = await fetch(`${baseUrl}/app.js`)
check('GET /app.js 返回脚本', jsResponse.ok)

// 2. 配置接口
const configResponse = await fetch(`${baseUrl}/api/config`)
const config = await configResponse.json()
check('GET /api/config 有 API Key', config.hasApiKey === true, config.apiKeySource)
check('GET /api/config 返回模型清单', Array.isArray(config.models) && config.models.length > 0,
  (config.models ?? []).map(model => model.id).join(', '))

// 3. 参数校验
const badResponse = await fetch(`${baseUrl}/api/review`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ english: 'Hello.', chinese: '' }),
})
const badBody = await badResponse.json()
check('缺少中文意图时返回 400', badResponse.status === 400 && Boolean(badBody.error), badBody.error)

// 4. 真实批改
console.log('─'.repeat(70))
console.log('开始批改（真实调用模型）…')
const startedAt = Date.now()
const firstCardAt = { value: 0 }

const reviewResponse = await fetch(`${baseUrl}/api/review`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    english: SAMPLE.english,
    chinese: SAMPLE.chinese,
    model: config.defaultModel,
    options: { strictness: 'standard', register: 'daily', wantNative: true, focus: ['时态'] },
  }),
})
check('POST /api/review 返回 200', reviewResponse.ok)
check('响应类型是 ndjson', (reviewResponse.headers.get('content-type') ?? '').includes('ndjson'))

const events = await readNdjson(reviewResponse, (event, count) => {
  if (event.kind === 'card') {
    if (!firstCardAt.value) firstCardAt.value = Date.now() - startedAt
    const card = event.card
    const label = card.type === 'issue' ? `issue #${card.id} [${card.category}]` : card.type
    console.log(`  ▸ ${String(Date.now() - startedAt).padStart(6)}ms  第 ${count} 个事件  ${label}`)
  }
})

const totalMs = Date.now() - startedAt
const cards = events.filter(event => event.kind === 'card').map(event => event.card)
const doneEvent = events.find(event => event.kind === 'done')
const errorEvent = events.find(event => event.kind === 'error')

console.log('─'.repeat(70))
check('没有 error 事件', !errorEvent, errorEvent?.message ?? '')
check('收到 done 事件', Boolean(doneEvent), doneEvent ? `共 ${doneEvent.cards} 张卡片，耗时 ${totalMs}ms` : '')
check('首张卡片延迟 < 30s', firstCardAt.value > 0 && firstCardAt.value < 30000, `${firstCardAt.value}ms`)
check('收到 intent 卡片', cards.some(card => card.type === 'intent'))
check('收到 issue 卡片', cards.some(card => card.type === 'issue'),
  `${cards.filter(card => card.type === 'issue').length} 条`)
check('收到 corrected 卡片且含全文', cards.some(card => card.type === 'corrected' && (card.text ?? '').length > 10))
check('收到 score 卡片且分数合理', cards.some(card => card.type === 'score' && Number(card.overall) >= 0 && Number(card.overall) <= 100))
check('收到 takeaway 卡片', cards.filter(card => card.type === 'takeaway').length >= 2)
check('最后一张卡片是 done 类型', cards[cards.length - 1]?.type === 'done', cards[cards.length - 1]?.type)

const intent = cards.find(card => card.type === 'intent')
check('intent 含中文理解与匹配度', Boolean(intent?.understood) && ['ok', 'partial', 'off'].includes(intent?.match))
const issues = cards.filter(card => card.type === 'issue')
check('issue 字段完整', issues.every(issue => issue.quote && issue.fix && issue.why && issue.category))
const issuesCited = issues.every(issue => SAMPLE.english.toLowerCase().includes(String(issue.quote).toLowerCase().slice(0, 25)))
check('issue 引用的原文能在学生原文中定位', issuesCited)

// 5. 追问
console.log('─'.repeat(70))
console.log('测试追问接口…')
const review = {
  issues,
  corrected: cards.find(card => card.type === 'corrected'),
  native: cards.find(card => card.type === 'native'),
}
const askResponse = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    english: SAMPLE.english,
    chinese: SAMPLE.chinese,
    review,
    question: '为什么这里要用过去时？请再给我两个例句。',
    model: config.defaultModel,
  }),
})
check('POST /api/ask 返回 200', askResponse.ok)
let answer = ''
await readNdjson(askResponse, event => {
  if (event.kind === 'text') answer += event.text
})
check('追问返回了文本', answer.length > 30, `${answer.length} 字符`)
console.log('  回答节选：' + answer.replace(/\s+/g, ' ').slice(0, 160) + '…')

console.log('─'.repeat(70))
console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
