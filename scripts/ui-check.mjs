/**
 * 真实浏览器端到端检查：无头 Chrome/Edge 打开页面 → 填表 → 点「开始批改」→ 等结果 → 截图。
 * 用法：先 `npm start`，再 `node scripts/ui-check.mjs`
 * 产出：ui-check-*.png（截图）与退出码（0 = 通过）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/config.mjs'

const APP_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:6801'
const DEBUG_PORT = 9222
const PROFILE_DIR = resolve(PROJECT_ROOT, '.ui-check-profile')
const SHOT_DIR = resolve(PROJECT_ROOT, 'ui-shots')

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const SAMPLE_ENGLISH =
  'Yesterday I go to a new cafe with my friend. The coffee is very good, but the price is a little expensive. ' +
  'I think I will come back again next week, because I want to try their cake. I very like this place.'
const SAMPLE_CHINESE =
  '昨天我和朋友去了一家新开的咖啡馆。咖啡很好喝，但价格有点贵。我想下周再去一次，因为我想尝尝他们家的蛋糕。我很喜欢这个地方。'

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

const browserPath = CANDIDATES.find(candidate => existsSync(candidate))
if (!browserPath) {
  console.error('✗ 没有找到 Chrome 或 Edge，跳过浏览器检查。')
  process.exit(2)
}
console.log(`浏览器：${browserPath}`)
console.log(`页面：${APP_URL}`)

mkdirSync(PROFILE_DIR, { recursive: true })
mkdirSync(SHOT_DIR, { recursive: true })

const browser = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--window-size=1400,1000',
  APP_URL,
], { stdio: 'ignore', detached: false })

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('等待浏览器调试端口超时')
}

/** 极简 CDP 客户端。 */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const consoleErrors = []

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? 'unknown exception')
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '))
    }
  })

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
  })

  const send = (method, params = {}) => new Promise((resolve_, reject) => {
    const id = ++nextId
    pending.set(id, { resolve: resolve_, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

  return { socket, ready, send, consoleErrors }
}

const page = await waitForDevtools()
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

const evaluate = async (expression, awaitPromise = false) => {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本异常')
  return result.result.value
}

// 等页面加载完
for (let i = 0; i < 60; i += 1) {
  const ready = await evaluate('document.readyState === "complete" && Boolean(document.querySelector("#submit-btn"))')
  if (ready) break
  await new Promise(r => setTimeout(r, 250))
}

// app.js 里 /api/config 是异步的，等它落地再断言（否则是测试自身的时序竞争）
let configReady = false
for (let i = 0; i < 40; i += 1) {
  const pill = await evaluate('document.querySelector("#key-status").textContent')
  if (pill && pill !== '检查中…') { configReady = true; break }
  await new Promise(r => setTimeout(r, 250))
}

check('页面加载并渲染出界面', await evaluate('Boolean(document.querySelector("#submit-btn"))'))
check('服务配置已加载', configReady, await evaluate('document.querySelector("#key-status").textContent'))
check('模型下拉框已填充', await evaluate('document.querySelector("#model-select").options.length > 0'),
  await evaluate('document.querySelector("#model-select").value'))
check('API Key 状态正常', (await evaluate('document.querySelector("#key-status").textContent')) === '模型已就绪',
  await evaluate('document.querySelector("#key-status").textContent'))

// 填入内容并提交
await evaluate(`
  (() => {
    const set = (selector, value) => {
      const node = document.querySelector(selector)
      node.value = value
      node.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('#english-input', ${JSON.stringify(SAMPLE_ENGLISH)})
    set('#chinese-input', ${JSON.stringify(SAMPLE_CHINESE)})
    document.querySelector('#english-input').dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()
`)
check('字数统计已更新', /\d+ 词/.test(await evaluate('document.querySelector("#english-count").textContent')),
  await evaluate('document.querySelector("#english-count").textContent'))
check('模拟回车快捷键触发批改', await evaluate(`
  (() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    return document.querySelector('#submit-btn').disabled === true
  })()
`))

// 等待批改完成（进度条收起 + 评分出现）
console.log('等待批改结果…')
let done = false
const deadline = Date.now() + 110000
while (Date.now() < deadline) {
  const status = await evaluate(`(() => {
    const scoreVisible = !document.querySelector('#sec-score').classList.contains('hidden')
    const progressHidden = document.querySelector('#progress').classList.contains('hidden')
    return { scoreVisible, progressHidden, issues: document.querySelectorAll('#issues-list .issue').length }
  })()`)
  if (status.scoreVisible && status.progressHidden) { done = true; break }
  await new Promise(r => setTimeout(r, 600))
}

check('批改完成且进度条收起', done)

const summary = await evaluate(`(() => {
  const text = selector => (document.querySelector(selector)?.textContent ?? '').trim()
  return {
    intentMatched: Boolean(document.querySelector('.match-badge')),
    issues: document.querySelectorAll('#issues-list .issue').length,
    issueDiffLines: document.querySelectorAll('#issues-list .diff-line').length,
    correctedVisible: !document.querySelector('#sec-corrected').classList.contains('hidden'),
    correctedHighlights: document.querySelectorAll('#sec-corrected mark.ins-mark').length,
    nativeVisible: !document.querySelector('#sec-native').classList.contains('hidden'),
    upgrades: document.querySelectorAll('#upgrades-list .upgrade').length,
    score: text('.score-value'),
    cefr: text('.cefr-badge'),
    bars: document.querySelectorAll('.score-detail .bar-row').length,
    takeaways: document.querySelectorAll('#takeaways-list .takeaway').length,
    followupVisible: !document.querySelector('#sec-followup').classList.contains('hidden'),
    historyCount: text('#history-count'),
    noticeVisible: !document.querySelector('#notice-banner').classList.contains('hidden'),
    noticeText: text('#notice-banner'),
    errorBannerVisible: !document.querySelector('#error-banner').classList.contains('hidden'),
    errorText: text('#error-banner'),
  }
})()`)

console.log('页面渲染结果：', JSON.stringify(summary, null, 2))
check('意图校验卡已渲染', summary.intentMatched)
check('问题卡片已渲染', summary.issues > 0, `${summary.issues} 条`)
check('问题卡含原文/修改对照', summary.issueDiffLines >= summary.issues)
check('修改后全文已渲染', summary.correctedVisible)
check('母语者版本已渲染', summary.nativeVisible)
check('用词升级已渲染', summary.upgrades > 0, `${summary.upgrades} 条`)
check('评分卡已渲染', Number(summary.score) > 0, `${summary.score} 分 / ${summary.cefr}`)
check('评分分项已渲染', summary.bars >= 4)
check('学习要点已渲染', summary.takeaways >= 2, `${summary.takeaways} 条`)
check('追问区已出现', summary.followupVisible)
check('历史记录已写入', Number(summary.historyCount) >= 1, summary.historyCount)
check('没有错误提示', !summary.errorBannerVisible, summary.errorText)
check('浏览器控制台没有报错', cdp.consoleErrors.length === 0, cdp.consoleErrors.join(' | '))

// 关键回归断言：页面上渲染出来的英文必须和模型返回的文本逐字一致。
// （曾经用词级 diff 猜对齐，会把删掉的词混进改写后的句子，切出读不通的句子。）
const rendered = await evaluate(`(() => {
  const normalize = value => String(value ?? '').replace(/\\s+/g, '')
  const data = window.__ewcLastReview ? window.__ewcLastReview() : { cards: [], english: '' }
  const pick = type => data.cards.find(card => card.type === type) ?? {}
  return {
    correctedModel: normalize(pick('corrected').text),
    correctedDom: normalize(document.querySelector('#sec-corrected .article-text')?.textContent),
    nativeModel: normalize(pick('native').text),
    nativeDom: normalize(document.querySelector('#sec-native .article-text')?.textContent),
    originalModel: normalize(data.english),
    originalDom: normalize(document.querySelector('#sec-corrected .compare-toggle .article-text')?.textContent),
    correctedText: document.querySelector('#sec-corrected .article-text')?.textContent ?? '',
    nativeText: document.querySelector('#sec-native .article-text')?.textContent ?? '',
    highlights: document.querySelectorAll('#sec-corrected mark.ins-mark').length,
    highlightedText: [...document.querySelectorAll('#sec-corrected mark.ins-mark')].map(node => node.textContent),
  }
})()`)

console.log(`  修改后全文实际渲染为：${rendered.correctedText}`)
console.log(`  母语者版本实际渲染为：${rendered.nativeText}`)
console.log(`  高亮片段：${rendered.highlightedText.map(item => JSON.stringify(item)).join('、') || '（无）'}`)

check('修改后全文逐字等于模型返回的文本', rendered.correctedDom === rendered.correctedModel,
  rendered.correctedDom === rendered.correctedModel ? '' : `渲染=${rendered.correctedDom} 模型=${rendered.correctedModel}`)
check('母语者版本逐字等于模型返回的文本', rendered.nativeDom === rendered.nativeModel,
  rendered.nativeDom === rendered.nativeModel ? '' : `渲染=${rendered.nativeDom} 模型=${rendered.nativeModel}`)
check('对照原文逐字等于学生原文', rendered.originalDom === rendered.originalModel,
  rendered.originalDom === rendered.originalModel ? '' : `渲染=${rendered.originalDom} 原文=${rendered.originalModel}`)
check('改动处高亮数量在合理范围', rendered.highlights <= 24, `${rendered.highlights} 处`)
check('高亮片段确实是修改后的写法', rendered.highlightedText.every(
  fragment => rendered.correctedDom.includes(String(fragment).replace(/\s+/g, '')),
))

// 追问一次，确认流式回答能渲染成 markdown
await evaluate(`
  (() => {
    const input = document.querySelector('#followup-input')
    input.value = '为什么 the price is expensive 不对？'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#followup-btn').click()
    return true
  })()
`)
let askDone = false
const askDeadline = Date.now() + 120000
while (Date.now() < askDeadline) {
  const length = await evaluate('document.querySelector(".qa-a")?.textContent.length ?? 0')
  const idle = await evaluate('document.querySelector("#followup-btn").disabled === false && (document.querySelector(".qa-a")?.textContent.length ?? 0) > 40')
  if (idle) { askDone = true; break }
  await new Promise(r => setTimeout(r, 700))
}
const askHtml = await evaluate('document.querySelector(".qa-a")?.innerHTML ?? ""')
check('追问得到回答', askDone, `${askHtml.length} 字符 HTML`)
check('追问回答渲染出 markdown 结构', /<(p|ul|ol|h4|strong|code)/.test(askHtml))

// 布局几何检查：溢出、尺寸、高亮样式、环形图、响应式
const layout = await evaluate(`(() => {
  const problems = []
  const viewport = window.innerWidth
  if (document.documentElement.scrollWidth > viewport + 1) {
    problems.push('横向滚动 ' + document.documentElement.scrollWidth + ' > ' + viewport)
  }
  const sections = {}
  for (const id of ['#sec-intent', '#sec-issues', '#sec-corrected', '#sec-native', '#sec-upgrades', '#sec-score', '#sec-takeaways', '#sec-followup']) {
    const node = document.querySelector(id)
    const rect = node.getBoundingClientRect()
    const visible = !node.classList.contains('hidden')
    sections[id] = { w: Math.round(rect.width), h: Math.round(rect.height), visible }
    if (visible && (rect.width < 200 || rect.height < 18)) {
      problems.push(id + ' 尺寸异常 ' + Math.round(rect.width) + 'x' + Math.round(rect.height))
    }
    if (visible && rect.right > viewport + 1) problems.push(id + ' 超出右边界')
  }
  const overflowing = [...document.querySelectorAll('.card, .issue, .takeaway, .upgrade, .btn')]
    .filter(node => node.getBoundingClientRect().right > viewport + 1 || node.getBoundingClientRect().left < -1)
    .map(node => node.className || node.id)
  if (overflowing.length) problems.push('越界元素：' + overflowing.join(', '))

  const clipped = [...document.querySelectorAll('.bar-label, .section-title, .score-comment, .issue-why, .takeaway p')]
    .filter(node => node.scrollWidth > node.clientWidth + 2)
    .map(node => node.className)
  if (clipped.length) problems.push('文字溢出容器：' + clipped.join(', '))

  const mark = document.querySelector('#sec-corrected mark.ins-mark')
  const delMark = document.querySelector('#sec-corrected .del-mark')
  const ring = document.querySelector('.ring-fg')
  const ringDash = ring ? ring.getAttribute('stroke-dasharray') : ''
  const ringLength = ringDash ? Number(String(ringDash).split(' ')[0]) : 0

  return {
    problems,
    sections,
    insMarkBg: mark ? getComputedStyle(mark).backgroundColor : 'none',
    delMarkBg: delMark ? getComputedStyle(delMark).backgroundColor : 'none',
    diffDelBg: getComputedStyle(document.querySelector('.diff-line.del')).backgroundColor,
    diffInsBg: getComputedStyle(document.querySelector('.diff-line.ins')).backgroundColor,
    ringDash,
    ringLength,
    ringColor: ring ? getComputedStyle(ring).stroke : 'none',
    barFills: [...document.querySelectorAll('.bar-fill')].map(node => node.style.width),
    progressHidden: document.querySelector('#progress').classList.contains('hidden'),
    stickyTopbar: getComputedStyle(document.querySelector('.topbar')).position,
  }
})()`)

check('页面没有横向溢出', layout.problems.length === 0, layout.problems.join(' | '))
check('各结果区块尺寸正常', Object.values(layout.sections).every(item => item.visible && item.h > 18))
check('新增词高亮有背景色', layout.insMarkBg !== 'none' && layout.insMarkBg !== 'rgba(0, 0, 0, 0)',
  `ins=${layout.insMarkBg} / del=${layout.delMarkBg}`)
check('问题卡删改对照有配色', layout.diffDelBg !== 'rgba(0, 0, 0, 0)' && layout.diffInsBg !== 'rgba(0, 0, 0, 0)',
  `del=${layout.diffDelBg} ins=${layout.diffInsBg}`)
check('评分环形图按分数描边', layout.ringLength > 0 && layout.ringLength < 327,
  `dasharray=${layout.ringDash} stroke=${layout.ringColor}`)
check('评分分项进度条已展开', layout.barFills.length >= 4 && layout.barFills.every(width => parseFloat(width) > 0),
  layout.barFills.join(', '))
check('顶栏为吸顶', layout.stickyTopbar === 'sticky')

// 窄屏响应式
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await new Promise(r => setTimeout(r, 600))
const mobile = await evaluate(`(() => ({
  columns: getComputedStyle(document.querySelector('.compose-grid')).gridTemplateColumns.split(' ').length,
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  takeawayColumns: getComputedStyle(document.querySelector('#takeaways-list')).gridTemplateColumns.split(' ').length,
}))()`)
check('窄屏输入区变为单列', mobile.columns === 1, `列数=${mobile.columns}，横向溢出=${mobile.overflow}px`)
check('窄屏没有横向溢出', mobile.overflow <= 1, `${mobile.overflow}px`)

// 截图
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await new Promise(r => setTimeout(r, 400))
const shotHeight = Math.min(await evaluate('Math.ceil(document.body.scrollHeight)') + 40, 8000)
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: shotHeight, deviceScaleFactor: 1, mobile: false,
})
await new Promise(r => setTimeout(r, 700))
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
const shotPath = join(SHOT_DIR, `ui-check-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`)
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
console.log(`截图已保存：${shotPath}`)

// ---- 回归场景：短句改写（语序变化大，最容易被错误对齐切乱）----
console.log('─'.repeat(70))
console.log('回归场景：短句「我学习英文有一段时间了」')
await evaluate(`
  (() => {
    const set = (selector, value) => {
      const node = document.querySelector(selector)
      node.value = value
      node.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('#english-input', 'I have a far time to learn English')
    set('#chinese-input', '我学习英文有一段时间了')
    document.querySelector('#submit-btn').click()
    return true
  })()
`)

let regressionDone = false
const regressionDeadline = Date.now() + 110000
while (Date.now() < regressionDeadline) {
  const status = await evaluate(`(() => ({
    scoreVisible: !document.querySelector('#sec-score').classList.contains('hidden'),
    progressHidden: document.querySelector('#progress').classList.contains('hidden'),
    streaming: document.querySelector('#submit-btn').disabled,
  }))()`)
  if (status.scoreVisible && status.progressHidden && !status.streaming) { regressionDone = true; break }
  await new Promise(r => setTimeout(r, 600))
}
check('短句批改完成', regressionDone)

const short = await evaluate(`(() => {
  const normalize = value => String(value ?? '').replace(/\\s+/g, '')
  const data = window.__ewcLastReview()
  const pick = type => data.cards.find(card => card.type === type) ?? {}
  return {
    correctedModel: normalize(pick('corrected').text),
    correctedDom: normalize(document.querySelector('#sec-corrected .article-text')?.textContent),
    nativeModel: normalize(pick('native').text),
    nativeDom: normalize(document.querySelector('#sec-native .article-text')?.textContent),
    correctedText: document.querySelector('#sec-corrected .article-text')?.textContent ?? '',
    nativeText: document.querySelector('#sec-native .article-text')?.textContent ?? '',
    highlights: [...document.querySelectorAll('#sec-corrected mark.ins-mark')].map(node => node.textContent),
  }
})()`)

console.log(`  修改后全文：${short.correctedText}`)
console.log(`  母语者版本：${short.nativeText}`)
console.log(`  高亮片段：${short.highlights.map(item => JSON.stringify(item)).join('、') || '（无）'}`)
check('短句场景：修改后全文逐字等于模型文本', short.correctedDom === short.correctedModel,
  short.correctedDom === short.correctedModel ? '' : `渲染=${short.correctedDom} 模型=${short.correctedModel}`)
check('短句场景：母语者版本逐字等于模型文本', short.nativeDom === short.nativeModel,
  short.nativeDom === short.nativeModel ? '' : `渲染=${short.nativeDom} 模型=${short.nativeModel}`)
check('短句场景：高亮片段都来自改写后的句子', short.highlights.every(
  fragment => short.correctedDom.includes(String(fragment).replace(/\s+/g, '')),
), `${short.highlights.length} 处高亮`)

cdp.socket.close()
browser.kill()
await new Promise(r => setTimeout(r, 500))
try { rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('─'.repeat(70))
console.log(failures === 0 ? '浏览器端到端检查全部通过 ✓' : `${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
