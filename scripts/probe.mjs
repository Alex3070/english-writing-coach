/**
 * 探测脚本：验证模型是否严格按「一行一个 JSON」的协议输出。
 *
 * 用法：
 *   npm run probe                       # 用内置样例
 *   npm run probe -- --model deepseek-v4-pro
 *   node scripts/probe.mjs --english "I go to school yesterday." --chinese "我昨天去了学校。"
 *
 * 输出会打印每行的解析结果与耗时，并把原始流保存到 .probe-output.jsonl。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, PROJECT_ROOT } from '../src/config.mjs'
import { streamChat } from '../src/llm.mjs'
import { buildRepairMessages, buildReviewMessages } from '../src/prompts.mjs'

/** --repair：单独验证「补全缺失卡片」的提示词能否稳定产出合法 JSON 行。 */
if (process.argv.includes('--repair')) {
  const config = loadConfig()
  if (!config.apiKey) {
    console.error('✗ 没有找到 DEEPSEEK_API_KEY。')
    process.exit(1)
  }
  const model = process.argv.includes('--model')
    ? process.argv[process.argv.indexOf('--model') + 1]
    : config.defaultModel

  // 模拟一次「主批改只成功产出了 issue」的漏行场景
  const cards = [
    {
      type: 'issue',
      id: 1,
      category: '时态',
      severity: 'major',
      quote: 'Yesterday I go to a new cafe',
      fix: 'Yesterday I went to a new cafe',
      why: '有 yesterday 这类过去时间时，谓语要用一般过去时。',
      example: 'I went to the gym yesterday.',
    },
  ]
  const messages = buildRepairMessages({
    english: 'Yesterday I go to a new cafe with my friend. The coffee is very good.',
    chinese: '昨天我和朋友去了一家新开的咖啡馆，咖啡很好喝。',
    cards,
    missing: ['intent', 'corrected', 'score'],
  })

  console.log(`模型：${model}（补全流程检查）`)
  let raw = ''
  for await (const delta of streamChat({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model,
    messages,
    temperature: 0.2,
    maxTokens: 2000,
  })) {
    raw += delta
  }

  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  console.log(`收到 ${lines.length} 行：`)
  const types = []
  let parsedAll = true
  for (const line of lines) {
    const cleaned = line.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      types.push(parsed.type)
      console.log(`✓ ${parsed.type}`)
    } catch (error) {
      parsedAll = false
      console.log(`✗ 无法解析：${line.slice(0, 160)}`)
    }
  }
  const ok = parsedAll && ['intent', 'corrected', 'score'].every(type => types.includes(type))
  console.log(ok ? '补全流程检查通过 ✓' : '补全流程检查失败 ✗')
  process.exit(ok ? 0 : 1)
}

function parseArgs(argv) {
  const args = { english: '', chinese: '', model: '', effort: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--english') args.english = argv[++i] ?? ''
    else if (key === '--chinese') args.chinese = argv[++i] ?? ''
    else if (key === '--model') args.model = argv[++i] ?? ''
    else if (key === '--effort') args.effort = argv[++i] ?? ''
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const english =
  args.english ||
  `Yesterday I go to a new cafe with my friend. The coffee is very good, but the price is a little expensive. I think I will come back again next week, because I want to try their cake. I very like this place.`
const chinese =
  args.chinese ||
  `昨天我和朋友去了一家新开的咖啡馆。咖啡很好喝，但价格有点贵。我想下周再去一次，因为我想尝尝他们家的蛋糕。我很喜欢这个地方。`

const config = loadConfig()
const model = args.model || config.defaultModel

if (!config.apiKey) {
  console.error('✗ 没有找到 DEEPSEEK_API_KEY，请设置环境变量或在项目根目录创建 .env 文件。')
  process.exit(1)
}

console.log(`模型：${model}`)
console.log(`Base URL：${config.baseURL}`)
console.log(`Key 来源：${config.apiKeySource}`)
console.log(`推理档位：${args.effort || '接口默认'}`)
console.log(`原文：${english}`)
console.log('─'.repeat(72))

const messages = buildReviewMessages({
  english,
  chinese,
  options: { strictness: 'standard', register: 'daily', wantNative: true },
})

const started = Date.now()
let firstChunkAt = 0
let raw = ''
const lineTimes = []
const chunks = []

try {
  for await (const delta of streamChat({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model,
    messages,
    temperature: 0.3,
    maxTokens: 8000,
    reasoningEffort: args.effort || undefined,
  })) {
    if (!firstChunkAt) {
      firstChunkAt = Date.now()
      console.log(`⏱  首字延迟：${firstChunkAt - started} ms`)
    }
    raw += delta
    let index
    while ((index = raw.indexOf('\n')) >= 0) {
      const line = raw.slice(0, index).trim()
      raw = raw.slice(index + 1)
      if (line) lineTimes.push({ line, at: Date.now() - started })
    }
  }
} catch (error) {
  console.error(`✗ 调用失败：${error.message}`)
  process.exit(1)
}

if (raw.trim()) lineTimes.push({ line: raw.trim(), at: Date.now() - started })

const outFile = join(PROJECT_ROOT, '.probe-output.jsonl')
writeFileSync(outFile, lineTimes.map(entry => entry.line).join('\n'), 'utf8')

console.log(`⏱  总耗时：${Date.now() - started} ms，共 ${lineTimes.length} 行`)
console.log('─'.repeat(72))

let okCount = 0
const typeCounts = new Map()

for (const [index, entry] of lineTimes.entries()) {
  const cleaned = entry.line.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    okCount += 1
    const type = parsed.type ?? '(无 type)'
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    console.log(`✓ 第 ${index + 1} 行 @${entry.at}ms  type=${type}`)
    chunks.push(parsed)
  } catch (error) {
    console.log(`✗ 第 ${index + 1} 行 @${entry.at}ms  JSON 解析失败：${error.message}`)
    console.log(`  内容：${entry.line.slice(0, 200)}`)
  }
}

console.log('─'.repeat(72))
console.log(`解析成功 ${okCount}/${lineTimes.length} 行`)
console.log('类型统计：', [...typeCounts.entries()].map(([t, n]) => `${t}×${n}`).join(', '))
console.log(`原始输出已保存：${outFile}`)

const hasIntent = typeCounts.has('intent')
const hasScore = typeCounts.has('score')
const hasCorrected = typeCounts.has('corrected')
const hasDone = typeCounts.has('done')
const allParsed = okCount === lineTimes.length && lineTimes.length > 0

console.log(
  `关键卡片：intent=${hasIntent ? '✓' : '✗'} corrected=${hasCorrected ? '✓' : '✗'} score=${hasScore ? '✓' : '✗'} done=${hasDone ? '✓' : '✗'}`,
)
process.exit(allParsed && hasIntent && hasScore && hasCorrected && hasDone ? 0 : 1)
