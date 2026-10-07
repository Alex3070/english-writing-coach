/**
 * 前端逻辑：调用 /api/review 读取 NDJSON 流，收到一张卡片就渲染一张。
 */
import { collectFixMatches, sentenceRanges } from './article-render.mjs'

const FOCUS_OPTIONS = ['时态', '冠词', '介词', '搭配', '中式英语', '拼写', '标点', '主谓一致']
const HISTORY_KEY = 'ewc.history.v1'
const HISTORY_LIMIT = 20

const SEVERITY_LABEL = { major: '严重', minor: '小错', style: '建议' }

const SAMPLE = {
  english: `Yesterday I go to a new cafe with my friend. The coffee is very good, but the price is a little expensive. I think I will come back again next week, because I want to try their cake. I very like this place.`,
  chinese: `昨天我和朋友去了一家新开的咖啡馆。咖啡很好喝，但价格有点贵。我想下周再去一次，因为我想尝尝他们家的蛋糕。我很喜欢这个地方。`,
}

const state = {
  english: '',
  chinese: '',
  options: { strictness: 'standard', register: 'daily', wantNative: true, focus: [] },
  model: '',
  cards: [],
  issues: [],
  upgrades: [],
  takeaways: [],
  intent: null,
  corrected: null,
  native: null,
  score: null,
  followUps: [],
  streaming: false,
  controller: null,
  timer: null,
  startedAt: 0,
  cardCount: 0,
}

/* ---------------- DOM 帮助函数 ---------------- */

const $ = selector => document.querySelector(selector)

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

function show(node) {
  node.classList.remove('hidden')
}

function hide(node) {
  node.classList.add('hidden')
}

/* ---------------- 文本工具 ---------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

/** 轻量 markdown 渲染（先转义，再套用少量语法），用于追问回答。 */
function renderMarkdown(source) {
  const lines = escapeHtml(source ?? '').split('\n')
  const out = []
  let listType = null
  let inCode = false
  let codeBuffer = []

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }
  const inline = text => text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
        codeBuffer = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(raw)
      continue
    }
    const line = raw.trim()
    if (!line) {
      closeList()
      continue
    }
    let match
    if ((match = line.match(/^#{1,6}\s+(.*)$/))) {
      closeList()
      out.push(`<h4>${inline(match[1])}</h4>`)
      continue
    }
    if ((match = line.match(/^[-*+]\s+(.*)$/))) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inline(match[1])}</li>`)
      continue
    }
    if ((match = line.match(/^\d+[.)]\s+(.*)$/))) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(match[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode && codeBuffer.length) out.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
  closeList()
  return out.join('')
}

/**
 * 渲染英文全文：按句子分段排版，marks 里的片段加高亮。
 * 保证渲染出来的文字和原文逐字一致（只是多套了高亮标签）。
 */
function renderArticleText(source, marks = []) {
  const text = String(source ?? '')
  const container = el('div', 'article-text')
  let nodes = []
  let length = 0

  const flush = () => {
    if (!nodes.length) return
    const paragraph = el('p')
    for (const node of nodes) paragraph.appendChild(node)
    container.appendChild(paragraph)
    nodes = []
    length = 0
  }

  for (const [from, to] of sentenceRanges(text)) {
    let cursor = 0
    for (const span of marks.filter(item => item.start < to && item.end > from)) {
      const start = Math.max(span.start, from)
      const end = Math.min(span.end, to)
      if (start > from + cursor) nodes.push(document.createTextNode(text.slice(from + cursor, start)))
      nodes.push(el('mark', 'ins-mark', text.slice(start, end)))
      cursor = end - from
    }
    if (cursor < to - from) nodes.push(document.createTextNode(text.slice(from + cursor, to)))
    length += to - from
    if (length >= 140) flush()
  }
  flush()

  if (!container.childNodes.length) container.appendChild(el('p', null, text))
  return container
}

function copyButton(getText, label = '复制') {
  const button = el('button', 'btn btn-ghost', label)
  button.type = 'button'
  button.addEventListener('click', async () => {
    const text = getText()
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = '已复制 ✓'
      setTimeout(() => { button.textContent = label }, 1500)
    } catch {
      button.textContent = '复制失败'
      setTimeout(() => { button.textContent = label }, 1500)
    }
  })
  return button
}

/* ---------------- 进度 ---------------- */

const PROGRESS_TEXT = {
  start: '老师正在读你的作文…',
  thinking: '老师正在思考…',
  intent: '已经读懂你的意图，正在逐句检查…',
  issue: '正在记录问题…',
  corrected: '正在写出修改后的全文…',
  native: '正在写母语者版本…',
  upgrade: '正在挑选更地道的用词…',
  score: '正在打分…',
  takeaway: '正在总结学习要点…',
  repair: '正在补齐漏掉的内容…',
  done: '批改完成',
}

function setProgress(stage) {
  const text = PROGRESS_TEXT[stage]
  if (text) $('#progress-text').textContent = text
  if (stage === 'done') {
    $('#progress-fill').style.width = '100%'
    $('#progress-fill').classList.add('done')
  } else {
    const width = Math.min(4 + state.cardCount * 6, 90)
    $('#progress-fill').style.width = `${width}%`
  }
}

function startTimer() {
  state.startedAt = Date.now()
  const tick = () => {
    const seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1)
    $('#progress-time').textContent = `${seconds}s`
    $('#elapsed').textContent = state.streaming ? `已用时 ${seconds}s` : ''
  }
  tick()
  state.timer = setInterval(tick, 200)
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  $('#progress-time').textContent = ''
}

/* ---------------- 渲染各类卡片 ---------------- */

function renderIntentCard(card) {
  const box = clear($('#sec-intent'))
  const match = ['ok', 'partial', 'off'].includes(card.match) ? card.match : 'partial'
  const head = el('div', 'intent-head')
  const label = { ok: '✓ 意思传达准确', partial: '△ 意思大致到位，但有偏差', off: '✕ 意思和你想说的不一致' }[match]
  head.appendChild(el('span', `match-badge match-${match}`, label))
  head.appendChild(el('span', 'muted', '老师的理解检查'))
  box.appendChild(head)

  const body = el('div', 'intent-body')
  const understood = el('div', 'intent-block')
  understood.appendChild(el('span', 'intent-label', '老师判断你想表达的意思'))
  understood.appendChild(el('p', null, card.understood || '—'))
  body.appendChild(understood)

  const gapText = (card.gap ?? '').trim()
  if (match !== 'ok' || gapText) {
    const gap = el('div', 'intent-block gap')
    gap.appendChild(el('span', 'intent-label', match === 'ok' ? '补充说明' : '你的英文实际传达出的意思 / 差距'))
    gap.appendChild(el('p', null, gapText || '英文与你的中文意图基本一致。'))
    body.appendChild(gap)
  }
  box.appendChild(body)
  show($('#sec-intent'))
}

function renderIssueCard(card) {
  state.issues.push(card)
  const list = $('#issues-list')
  const severity = ['major', 'minor', 'style'].includes(card.severity) ? card.severity : 'minor'

  const article = el('article', `issue sev-${severity}`)
  const head = el('div', 'issue-head')
  head.appendChild(el('span', 'tag cat', card.category || '问题'))
  head.appendChild(el('span', `tag sev-${severity}`, SEVERITY_LABEL[severity]))
  head.appendChild(el('span', 'issue-id', `#${card.id ?? state.issues.length}`))
  article.appendChild(head)

  const diff = el('div', 'issue-diff')
  if (card.quote) {
    const line = el('div', 'diff-line del')
    line.appendChild(el('span', 'mark', '−'))
    line.appendChild(el('span', 'txt', card.quote))
    diff.appendChild(line)
  }
  if (card.fix) {
    const line = el('div', 'diff-line ins')
    line.appendChild(el('span', 'mark', '+'))
    line.appendChild(el('span', 'txt', card.fix))
    diff.appendChild(line)
  }
  article.appendChild(diff)

  if (card.why) {
    const why = el('p', 'issue-why')
    why.appendChild(el('strong', null, '为什么：'))
    why.appendChild(document.createTextNode(card.why))
    article.appendChild(why)
  }
  if (card.example) {
    const example = el('p', 'issue-example')
    example.appendChild(el('strong', null, '正确例句：'))
    example.appendChild(el('span', 'en', card.example))
    article.appendChild(example)
  }

  list.appendChild(article)
  $('#issues-count').textContent = String(state.issues.length)
  show($('#sec-issues'))
}

function renderCorrectedCard(card) {
  state.corrected = card
  const box = clear($('#sec-corrected'))

  const head = el('div', 'article-head')
  head.appendChild(el('h2', null, '修改后的英文'))
  head.appendChild(copyButton(() => state.corrected?.text ?? ''))
  box.appendChild(head)

  const marks = collectFixMatches(card.text ?? '', state.issues)
  box.appendChild(renderArticleText(card.text ?? '', marks))
  if (marks.length > 0) {
    box.appendChild(el('p', 'article-note muted', '绿色标记处是这次改动过的地方。'))
  }

  if (card.summary) {
    const note = el('p', 'article-note')
    note.appendChild(el('strong', null, '改动说明：'))
    note.appendChild(document.createTextNode(card.summary))
    box.appendChild(note)
  }

  if (state.english.trim()) {
    const details = el('details', 'compare-toggle')
    details.appendChild(el('summary', null, '对照原文'))
    details.appendChild(renderArticleText(state.english))
    box.appendChild(details)
  }

  show($('#sec-corrected'))
}

function renderNativeCard(card) {
  state.native = card
  const box = clear($('#sec-native'))
  const head = el('div', 'article-head')
  head.appendChild(el('h2', null, '母语者会这样写'))
  head.appendChild(copyButton(() => state.native?.text ?? ''))
  box.appendChild(head)
  box.appendChild(renderArticleText(card.text ?? ''))
  if (card.note) {
    const note = el('p', 'article-note')
    note.appendChild(el('strong', null, '差别在哪：'))
    note.appendChild(document.createTextNode(card.note))
    box.appendChild(note)
  }
  show($('#sec-native'))
}

function renderUpgradeCard(card) {
  state.upgrades.push(card)
  const row = el('div', 'upgrade')
  const top = el('div', 'upgrade-top')
  top.appendChild(el('span', 'upgrade-from', card.original || '—'))
  top.appendChild(el('span', 'arrow', '→'))
  for (const better of Array.isArray(card.better) ? card.better : []) {
    top.appendChild(el('span', 'better-chip', better))
  }
  row.appendChild(top)
  if (card.why) row.appendChild(el('p', 'upgrade-why', card.why))
  $('#upgrades-list').appendChild(row)
  show($('#sec-upgrades'))
}

function barClass(value) {
  if (value >= 80) return 'good'
  if (value >= 60) return 'mid'
  return 'low'
}

function renderScoreCard(card) {
  state.score = card
  const box = clear($('#sec-score'))
  const overall = Math.max(0, Math.min(100, Number(card.overall) || 0))
  const circumference = 2 * Math.PI * 52

  const wrap = el('div', 'score-wrap')

  const ring = el('div', 'score-ring')
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 120 120')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  const bg = document.createElementNS(ns, 'circle')
  bg.setAttribute('cx', '60'); bg.setAttribute('cy', '60'); bg.setAttribute('r', '52')
  bg.setAttribute('class', 'ring-bg')
  const fg = document.createElementNS(ns, 'circle')
  fg.setAttribute('cx', '60'); fg.setAttribute('cy', '60'); fg.setAttribute('r', '52')
  fg.setAttribute('class', 'ring-fg')
  const color = overall >= 85 ? '#059669' : overall >= 70 ? '#4f46e5' : overall >= 55 ? '#f59e0b' : '#dc2626'
  fg.setAttribute('stroke', color)
  fg.setAttribute('stroke-dasharray', `0 ${circumference}`)
  svg.appendChild(bg)
  svg.appendChild(fg)
  ring.appendChild(svg)
  const center = el('div', 'score-center')
  center.appendChild(el('span', 'score-value', overall))
  center.appendChild(el('span', 'score-unit', '综合评分'))
  ring.appendChild(center)
  wrap.appendChild(ring)
  setTimeout(() => {
    fg.setAttribute('stroke-dasharray', `${(circumference * overall) / 100} ${circumference}`)
  }, 60)

  const detail = el('div', 'score-detail')

  if (card.cefr) {
    const cefrRow = el('div', 'bar-row')
    cefrRow.appendChild(el('span', 'bar-label', '水平估计'))
    cefrRow.appendChild(el('span', 'cefr-badge', card.cefr))
    detail.appendChild(cefrRow)
  }

  const dimensions = [
    ['语法', card.grammar],
    ['用词', card.vocabulary],
    ['地道度', card.naturalness],
    ['意思传达', card.intent],
  ]
  for (const [label, rawValue] of dimensions) {
    const value = Math.max(0, Math.min(100, Number(rawValue) || 0))
    const row = el('div', 'bar-row')
    row.appendChild(el('span', 'bar-label', label))
    const track = el('div', 'bar-track')
    const fill = el('div', `bar-fill ${barClass(value)}`)
    fill.style.width = '0%'
    track.appendChild(fill)
    row.appendChild(track)
    row.appendChild(el('span', 'bar-value', value))
    detail.appendChild(row)
    setTimeout(() => { fill.style.width = `${value}%` }, 80)
  }

  wrap.appendChild(detail)
  box.appendChild(wrap)

  if (card.comment) box.appendChild(el('p', 'score-comment', card.comment))
  show($('#sec-score'))
}

function renderTakeawayCard(card) {
  state.takeaways.push(card)
  const item = el('div', 'takeaway')
  const title = el('h3')
  title.appendChild(el('span', 'num', state.takeaways.length))
  title.appendChild(document.createTextNode(card.title || '学习要点'))
  item.appendChild(title)
  if (card.detail) item.appendChild(el('p', null, card.detail))
  if (card.example) item.appendChild(el('span', 'en-ex', card.example))
  $('#takeaways-list').appendChild(item)
  show($('#sec-takeaways'))
}

/* ---------------- 流式批改 ---------------- */

function resetResults() {
  state.cards = []
  state.issues = []
  state.upgrades = []
  state.takeaways = []
  state.intent = null
  state.corrected = null
  state.native = null
  state.score = null
  state.followUps = []
  state.cardCount = 0

  clear($('#sec-intent'))
  clear($('#issues-list'))
  clear($('#sec-corrected'))
  clear($('#sec-native'))
  clear($('#upgrades-list'))
  clear($('#sec-score'))
  clear($('#takeaways-list'))
  clear($('#followup-thread'))
  $('#issues-count').textContent = '0'

  for (const id of ['#sec-intent', '#sec-issues', '#sec-corrected', '#sec-native', '#sec-upgrades', '#sec-score', '#sec-takeaways', '#sec-followup']) {
    hide($(id))
  }
  hide($('#error-banner'))
  hide($('#notice-banner'))
  show($('#results'))
  show($('#progress'))
  $('#progress-fill').style.width = '4%'
  $('#progress-fill').classList.remove('done')
  setProgress('start')
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return
  switch (event.kind) {
    case 'start':
      state.cardCount = 0
      setProgress('start')
      break
    case 'status':
      setProgress(event.stage)
      break
    case 'card': {
      const card = event.card
      if (!card || typeof card !== 'object') return
      state.cardCount += 1
      state.cards.push(card)
      switch (card.type) {
        case 'intent':
          state.intent = card
          renderIntentCard(card)
          break
        case 'issue':
          renderIssueCard(card)
          break
        case 'corrected':
          renderCorrectedCard(card)
          break
        case 'native':
          renderNativeCard(card)
          break
        case 'upgrade':
          renderUpgradeCard(card)
          break
        case 'score':
          renderScoreCard(card)
          break
        case 'takeaway':
          renderTakeawayCard(card)
          break
        default:
          break
      }
      setProgress(card.type)
      break
    }
    case 'error': {
      const banner = $('#error-banner')
      banner.textContent = event.message || '批改失败，请重试。'
      show(banner)
      break
    }
    case 'done': {
      setProgress('done')
      if (state.issues.length === 0) {
        const list = clear($('#issues-list'))
        list.appendChild(el('p', 'history-empty', '这次没有发现明显的语法或用词错误，写得不错。可以试着把句子写得更长一些，或者换个话题再练一段。'))
        show($('#sec-issues'))
      }
      show($('#sec-followup'))
      if (event.unparsed > 0) {
        const notice = $('#notice-banner')
        notice.textContent = `有 ${event.unparsed} 行模型输出没能解析，已自动跳过；不影响其他批改内容。`
        show(notice)
      }
      break
    }
    default:
      break
  }
}

async function submit() {
  if (state.streaming) return
  const english = $('#english-input').value.trim()
  const chinese = $('#chinese-input').value.trim()

  if (!english) return flashError('请先把你写的英文填进左边输入框。')
  if (!chinese) return flashError('请用中文写下你本来想表达的意思，老师才能判断你的英文有没有说到位。')

  state.english = english
  state.chinese = chinese
  resetResults()

  state.streaming = true
  $('#submit-btn').disabled = true
  show($('#stop-btn'))
  startTimer()

  const controller = new AbortController()
  state.controller = controller

  try {
    const response = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        english,
        chinese,
        options: state.options,
        model: state.model,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail.error || `请求失败（HTTP ${response.status}）`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          handleEvent(JSON.parse(line))
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
    if (buffer.trim()) {
      try {
        handleEvent(JSON.parse(buffer))
      } catch { /* 忽略 */ }
    }

    if (state.cardCount > 0) saveHistory()
  } catch (error) {
    if (error?.name === 'AbortError') {
      $('#error-banner').textContent = '已停止本次批改。'
      show($('#error-banner'))
    } else {
      const banner = $('#error-banner')
      banner.textContent = error?.message || '批改失败，请重试。'
      show(banner)
    }
  } finally {
    state.streaming = false
    state.controller = null
    $('#submit-btn').disabled = false
    hide($('#stop-btn'))
    stopTimer()
    hide($('#progress'))
  }
}

function flashError(message) {
  const banner = $('#error-banner')
  banner.textContent = message
  show(banner)
  banner.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/* ---------------- 追问 ---------------- */

async function askFollowUp() {
  const input = $('#followup-input')
  const question = input.value.trim()
  if (!question) return
  input.value = ''

  const thread = $('#followup-thread')
  const qa = el('div', 'qa')
  const q = el('div', 'qa-q')
  q.appendChild(el('span', 'who', '我：'))
  q.appendChild(document.createTextNode(question))
  qa.appendChild(q)
  const answer = el('div', 'qa-a md', '')
  qa.appendChild(answer)
  thread.appendChild(qa)
  qa.scrollIntoView({ behavior: 'smooth', block: 'center' })

  const button = $('#followup-btn')
  button.disabled = true
  button.textContent = '老师思考中…'

  let answerText = ''
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        english: state.english,
        chinese: state.chinese,
        review: { issues: state.issues, corrected: state.corrected, native: state.native },
        question,
        history: state.followUps,
        model: state.model,
      }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new Error(detail.error || `请求失败（HTTP ${response.status}）`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.kind === 'text') {
          answerText += event.text
          answer.innerHTML = renderMarkdown(answerText)
        } else if (event.kind === 'error') {
          answer.appendChild(el('p', 'muted', event.message))
        }
      }
    }
    if (answerText) {
      state.followUps.push({ question, answer: answerText })
      saveHistory()
    }
  } catch (error) {
    answer.appendChild(el('p', 'muted', `提问失败：${error?.message ?? error}`))
  } finally {
    button.disabled = false
    button.textContent = '提问'
  }
}

/* ---------------- 历史记录 ---------------- */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)))
  } catch {
    /* 存储不可用时静默忽略 */
  }
}

function saveHistory() {
  if (!state.cards.length) return
  const list = loadHistory()
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    english: state.english,
    chinese: state.chinese,
    options: { ...state.options },
    model: state.model,
    cards: state.cards,
    followUps: state.followUps,
  }
  const filtered = list.filter(item => item.english !== entry.english || item.chinese !== entry.chinese)
  filtered.unshift(entry)
  writeHistory(filtered)
  renderHistory()
}

function renderHistory() {
  const list = loadHistory()
  const box = clear($('#history-list'))
  $('#history-count').textContent = String(list.length)

  if (!list.length) {
    box.appendChild(el('p', 'history-empty', '还没有记录。完成一次批改后会自动保存在这里。'))
    return
  }

  for (const entry of list) {
    const item = el('div', 'history-item')
    item.appendChild(el('span', 'hi-text', entry.english.replace(/\s+/g, ' ').slice(0, 90) || '（无内容）'))
    const score = entry.cards?.find(card => card.type === 'score')
    if (score) item.appendChild(el('span', 'hi-score', score.overall))
    const date = new Date(entry.ts)
    item.appendChild(el('span', 'hi-meta', `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`))

    const remove = el('button', 'btn btn-ghost hi-remove', '删除')
    remove.type = 'button'
    remove.addEventListener('click', event => {
      event.stopPropagation()
      writeHistory(loadHistory().filter(candidate => candidate.id !== entry.id))
      renderHistory()
    })
    item.appendChild(remove)

    item.addEventListener('click', () => restoreEntry(entry))
    box.appendChild(item)
  }
}

function restoreEntry(entry) {
  $('#english-input').value = entry.english
  $('#chinese-input').value = entry.chinese
  state.english = entry.english
  state.chinese = entry.chinese
  state.options = { ...state.options, ...(entry.options ?? {}) }
  state.model = entry.model || state.model
  $('#model-select').value = state.model
  syncOptionControls()
  updateWordCount()

  resetResults()
  hide($('#progress'))
  state.cards = []
  state.cardCount = 0
  state.followUps = entry.followUps ?? []
  for (const card of entry.cards ?? []) handleEvent({ kind: 'card', card })
  setProgress('done')
  show($('#sec-followup'))
  for (const turn of state.followUps) {
    const thread = $('#followup-thread')
    const qa = el('div', 'qa')
    const q = el('div', 'qa-q')
    q.appendChild(el('span', 'who', '我：'))
    q.appendChild(document.createTextNode(turn.question))
    qa.appendChild(q)
    const answer = el('div', 'qa-a md')
    answer.innerHTML = renderMarkdown(turn.answer)
    qa.appendChild(answer)
    thread.appendChild(qa)
  }
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* ---------------- 导出 ---------------- */

function buildReport() {
  const lines = []
  const date = new Date().toLocaleString('zh-CN')
  lines.push('# 英语写作批改报告')
  lines.push('')
  lines.push(`- 批改时间：${date}`)
  lines.push(`- 使用模型：${state.model}`)
  lines.push('')
  lines.push('## 我写的英文')
  lines.push('')
  lines.push('> ' + state.english.replace(/\n/g, '\n> '))
  lines.push('')
  lines.push('## 我想表达的意思')
  lines.push('')
  lines.push('> ' + state.chinese.replace(/\n/g, '\n> '))
  lines.push('')

  if (state.score) {
    lines.push('## 评分')
    lines.push('')
    lines.push(`- 综合：**${state.score.overall}**　水平估计：**${state.score.cefr ?? '—'}**`)
    lines.push(`- 语法 ${state.score.grammar}　用词 ${state.score.vocabulary}　地道度 ${state.score.naturalness}　意思传达 ${state.score.intent}`)
    if (state.score.comment) {
      lines.push('')
      lines.push(state.score.comment)
    }
    lines.push('')
  }

  if (state.intent) {
    lines.push('## 意思有没有说到位')
    lines.push('')
    lines.push(`- 老师理解你想说：${state.intent.understood ?? ''}`)
    lines.push(`- 判断：${state.intent.match === 'ok' ? '准确' : state.intent.match === 'off' ? '不一致' : '有偏差'}`)
    if (state.intent.gap) lines.push(`- 差距：${state.intent.gap}`)
    lines.push('')
  }

  if (state.issues.length) {
    lines.push('## 问题清单')
    lines.push('')
    state.issues.forEach((issue, index) => {
      lines.push(`### ${index + 1}. [${issue.category}] ${SEVERITY_LABEL[issue.severity] ?? ''}`)
      lines.push('')
      lines.push(`- 原文：\`${issue.quote ?? ''}\``)
      lines.push(`- 改为：\`${issue.fix ?? ''}\``)
      if (issue.why) lines.push(`- 为什么：${issue.why}`)
      if (issue.example) lines.push(`- 例句：\`${issue.example}\``)
      lines.push('')
    })
  }

  if (state.corrected) {
    lines.push('## 修改后的英文')
    lines.push('')
    lines.push(state.corrected.text ?? '')
    lines.push('')
    if (state.corrected.summary) {
      lines.push(`改动说明：${state.corrected.summary}`)
      lines.push('')
    }
  }

  if (state.native) {
    lines.push('## 母语者版本')
    lines.push('')
    lines.push(state.native.text ?? '')
    lines.push('')
    if (state.native.note) {
      lines.push(`差别：${state.native.note}`)
      lines.push('')
    }
  }

  if (state.upgrades.length) {
    lines.push('## 用词升级')
    lines.push('')
    for (const upgrade of state.upgrades) {
      lines.push(`- \`${upgrade.original}\` → ${(upgrade.better ?? []).map(word => `\`${word}\``).join(' / ')}　${upgrade.why ?? ''}`)
    }
    lines.push('')
  }

  if (state.takeaways.length) {
    lines.push('## 今天记住这几点')
    lines.push('')
    state.takeaways.forEach((item, index) => {
      lines.push(`${index + 1}. **${item.title}**：${item.detail ?? ''}`)
      if (item.example) lines.push(`   - 例句：\`${item.example}\``)
    })
    lines.push('')
  }

  if (state.followUps.length) {
    lines.push('## 追问记录')
    lines.push('')
    for (const turn of state.followUps) {
      lines.push(`**问：** ${turn.question}`)
      lines.push('')
      lines.push(turn.answer)
      lines.push('')
    }
  }

  return lines.join('\n')
}

function exportReport() {
  const blob = new Blob([buildReport()], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  anchor.href = url
  anchor.download = `英语批改-${stamp}.md`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/* ---------------- 表单与选项 ---------------- */

function updateWordCount() {
  const text = $('#english-input').value
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g)?.length ?? 0
  $('#english-count').textContent = `${words} 词 / ${text.length} 字符`
}

function syncOptionControls() {
  document.querySelectorAll('#strictness-group button').forEach(button => {
    button.classList.toggle('active', button.dataset.value === state.options.strictness)
  })
  $('#register-select').value = state.options.register
  $('#want-native').checked = state.options.wantNative
  document.querySelectorAll('#focus-chips .chip').forEach(chip => {
    chip.classList.toggle('active', state.options.focus.includes(chip.dataset.value))
  })
}

function buildFocusChips() {
  const box = clear($('#focus-chips'))
  for (const value of FOCUS_OPTIONS) {
    const chip = el('button', 'chip', value)
    chip.type = 'button'
    chip.dataset.value = value
    chip.addEventListener('click', () => {
      const index = state.options.focus.indexOf(value)
      if (index >= 0) state.options.focus.splice(index, 1)
      else state.options.focus.push(value)
      chip.classList.toggle('active', state.options.focus.includes(value))
    })
    box.appendChild(chip)
  }
}

async function loadServerConfig() {
  const pill = $('#key-status')
  try {
    const response = await fetch('/api/config')
    const info = await response.json()
    const select = clear($('#model-select'))
    for (const model of info.models ?? []) {
      const option = el('option', null, model.label ?? model.id)
      option.value = model.id
      select.appendChild(option)
    }
    if (info.defaultModel) {
      select.value = info.defaultModel
      state.model = info.defaultModel
    }
    if (!info.models?.some(model => model.id === select.value)) {
      state.model = select.value
    }
    if (info.hasApiKey) {
      pill.className = 'pill pill-ok'
      pill.textContent = '模型已就绪'
      pill.title = `API Key 来源：${info.apiKeySource}`
    } else {
      pill.className = 'pill pill-bad'
      pill.textContent = '缺少 API Key'
      pill.title = '请在项目根目录创建 .env，写入 DEEPSEEK_API_KEY=你的密钥'
      flashError('服务端没有找到 DEEPSEEK_API_KEY，请在项目根目录的 .env 文件里写入：DEEPSEEK_API_KEY=你的密钥，然后重启服务。')
    }
  } catch {
    pill.className = 'pill pill-bad'
    pill.textContent = '服务未连接'
  }
}

function wireEvents() {
  $('#submit-btn').addEventListener('click', submit)
  $('#rerun-btn').addEventListener('click', submit)

  $('#stop-btn').addEventListener('click', () => {
    state.controller?.abort()
  })

  $('#example-btn').addEventListener('click', () => {
    $('#english-input').value = SAMPLE.english
    $('#chinese-input').value = SAMPLE.chinese
    updateWordCount()
  })

  $('#clear-btn').addEventListener('click', () => {
    $('#english-input').value = ''
    $('#chinese-input').value = ''
    updateWordCount()
    hide($('#results'))
    hide($('#error-banner'))
    hide($('#notice-banner'))
  })

  $('#english-input').addEventListener('input', updateWordCount)

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })

  document.querySelectorAll('#strictness-group button').forEach(button => {
    button.addEventListener('click', () => {
      state.options.strictness = button.dataset.value
      syncOptionControls()
    })
  })

  $('#register-select').addEventListener('change', event => {
    state.options.register = event.target.value
  })

  $('#want-native').addEventListener('change', event => {
    state.options.wantNative = event.target.checked
  })

  $('#model-select').addEventListener('change', event => {
    state.model = event.target.value
  })

  $('#export-btn').addEventListener('click', exportReport)

  $('#followup-btn').addEventListener('click', askFollowUp)
  $('#followup-input').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      askFollowUp()
    }
  })
}

function init() {
  buildFocusChips()
  wireEvents()
  updateWordCount()
  renderHistory()
  loadServerConfig()

  // 供自动化检查读取最近一次批改的原始数据（scripts/ui-check.mjs 用）
  window.__ewcLastReview = () => ({
    english: state.english,
    chinese: state.chinese,
    cards: state.cards,
  })
}

init()
