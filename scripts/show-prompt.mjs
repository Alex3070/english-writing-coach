/**
 * 打印实际发送给模型的提示词，方便检查和调优。
 *
 * 用法：
 *   node scripts/show-prompt.mjs                     # 批改提示词（默认示例）
 *   node scripts/show-prompt.mjs --mode all          # 批改 + 补全 + 追问 三种都看
 *   node scripts/show-prompt.mjs --mode followup
 *   node scripts/show-prompt.mjs --english "..." --chinese "..." --register academic --strictness strict
 *   node scripts/show-prompt.mjs --out prompt-preview  # 同时写文件
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/config.mjs'
import { buildFollowUpMessages, buildRepairMessages, buildReviewMessages } from '../src/prompts.mjs'

function parseArgs(argv) {
  const args = { english: '', chinese: '', mode: 'review', strictness: 'standard', register: 'daily', out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1] ?? ''
    if (key === '--english') args.english = value
    else if (key === '--chinese') args.chinese = value
    else if (key === '--mode') args.mode = value
    else if (key === '--strictness') args.strictness = value
    else if (key === '--register') args.register = value
    else if (key === '--out') args.out = value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const english =
  args.english ||
  'Yesterday I go to a new cafe with my friend. The coffee is very good, but the price is a little expensive. I very like this place.'
const chinese = args.chinese || '昨天我和朋友去了一家新开的咖啡馆。咖啡很好喝，但价格有点贵。我很喜欢这个地方。'

const options = { strictness: args.strictness, register: args.register, wantNative: true, focus: ['时态'] }
const label = { system: 'system', user: 'user', assistant: 'assistant' }

function render(title, messages) {
  const lines = [`\n${'█'.repeat(78)}`, `█ ${title}`, '█'.repeat(78)]
  for (const message of messages) {
    const content = String(message.content ?? '')
    lines.push(`\n┌─ [${label[message.role] ?? message.role}] ${content.length} 字符 ─────────`)
    lines.push(content)
    lines.push('└' + '─'.repeat(60))
  }
  return lines.join('\n')
}

const blocks = []
if (args.mode === 'review' || args.mode === 'all') {
  blocks.push(render('① 批改请求（POST /api/review → /chat/completions）', buildReviewMessages(
    { english, chinese, options },
    { model: 'deepseek-flash' },
  )))
}
if (args.mode === 'repair' || args.mode === 'all') {
  // 模拟一次「主批改漏掉了 score 和 corrected」的补全请求
  blocks.push(render('② 补全请求（关键卡片缺失时才发）', buildRepairMessages({
    english,
    chinese,
    cards: [{
      type: 'issue',
      id: 1,
      category: '时态',
      severity: 'major',
      quote: 'Yesterday I go to a new cafe',
      fix: 'Yesterday I went to a new cafe',
      why: '有 yesterday 这类过去时间时，谓语要用一般过去时。',
      example: 'I went to the gym yesterday.',
    }],
    missing: ['corrected', 'score'],
  })))
}
if (args.mode === 'followup' || args.mode === 'all') {
  blocks.push(render('③ 追问请求（POST /api/ask）', buildFollowUpMessages({
    english,
    chinese,
    review: {
      issues: [{
        category: '时态',
        quote: 'Yesterday I go to a new cafe',
        fix: 'Yesterday I went to a new cafe',
        why: '有 yesterday 这类过去时间时，谓语要用一般过去时。',
      }],
      corrected: { text: 'Yesterday I went to a new cafe with my friend. The coffee was very good, but the price was a little high. I really like this place.' },
      native: { text: "Yesterday my friend and I went to a new cafe. The coffee was great, though it was a bit pricey. I really like that place." },
    },
    question: '为什么这里要用过去时？请再给我两个例句。',
    history: [],
  })))
}

const output = blocks.join('\n')
console.log(output)
console.log(`\n合计 ${output.length} 字符（约 ${Math.round(output.length / 1.6)} tokens 量级）`)

if (args.out) {
  const dir = resolve(join(PROJECT_ROOT, args.out))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${args.mode}.txt`)
  writeFileSync(file, output, 'utf8')
  console.log(`已写入：${file}`)
}
