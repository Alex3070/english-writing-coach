/**
 * 纯逻辑：在批改后的英文里定位「改动片段」。
 *
 * 这里刻意不做词级 diff 去猜对齐。原句和改写句语序差别大时，
 * 词级 diff 会把 a / time 之类的词配到错误位置，拼出读不通的句子
 * （例如把「I have a far time to learn English」和改写句强行交错）。
 *
 * 问题卡里的 quote → fix 是模型给出的准确对应关系，直接用它定位最可靠：
 * 渲染出来的文字永远和模型返回的文本逐字一致，只是给改动片段套一层高亮。
 */

/** 把 fix 片段整理成可以在英文里定位的纯英文片段。 */
export function normalizeFixFragment(fix) {
  let value = String(fix ?? '')
  value = value.replace(/（[^）]*）|\([^)]*\)/g, ' ')                        // 去掉括号里的中文说明
  value = value.replace(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g, ' ')  // 去掉中文与中文标点
  value = value.replace(/\s+/g, ' ').trim()
  if (value.length < 2 || !/[A-Za-z]/.test(value)) return ''
  return value
}

/** 高亮片段的长度上限（单词数）：太长就变成整段涂色，反而看不清。 */
const MAX_HIGHLIGHT_WORDS = 8
/** 片段超过全文这个比例时跳过（整句替换的情况）。 */
const MAX_HIGHLIGHT_TEXT_RATIO = 0.6
const MAX_HIGHLIGHTS = 24

function countWords(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length
}

function wordsOnly(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).join(' ').toLowerCase()
}

/**
 * 在改写后的全文里找出所有值得高亮的改动片段。
 * @param {string} text 改写后的英文
 * @param {Array<{quote?: string, fix?: string}>} issues 问题卡片
 * @returns {Array<{start: number, end: number, length: number}>} 互不重叠、按位置排序的区间
 */
export function collectFixMatches(text, issues) {
  const source = String(text ?? '')
  const lower = source.toLowerCase()
  const found = []
  const seen = new Set()

  for (const issue of issues ?? []) {
    const fragment = normalizeFixFragment(issue?.fix)
    if (!fragment) continue

    // 模型有时把整句改写填进 fix，此时它和 quote 往往只差几个词；
    // 整句高亮等于把一整句涂绿，没有提示价值，跳过。
    if (countWords(fragment) > MAX_HIGHLIGHT_WORDS) continue
    if (fragment.length > source.length * MAX_HIGHLIGHT_TEXT_RATIO) continue

    // fix 和 quote 完全一样，说明这里其实没改，不用标
    const quote = normalizeFixFragment(issue?.quote)
    if (quote && wordsOnly(quote) === wordsOnly(fragment)) continue

    const needle = fragment.toLowerCase()
    if (seen.has(needle)) continue
    seen.add(needle)

    let from = 0
    while (from <= lower.length - needle.length) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : source[at - 1]
      const after = source[at + needle.length] ?? ''
      // 只认完整单词边界，避免标进单词中间
      if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
        found.push({ start: at, end: at + needle.length, length: needle.length })
      }
      from = at + 1
    }
  }

  // 长片段优先，互相重叠的只留一个
  found.sort((a, b) => b.length - a.length || a.start - b.start)
  const accepted = []
  for (const span of found) {
    if (accepted.some(other => span.start < other.end && other.start < span.end)) continue
    accepted.push(span)
    if (accepted.length >= MAX_HIGHLIGHTS) break
  }
  return accepted.sort((a, b) => a.start - b.start)
}

/** 按句子边界切分，得到首尾相接、覆盖全文的区间。 */
export function sentenceRanges(text) {
  const source = String(text ?? '')
  const ranges = []
  const pattern = /[.!?]+["')\]]*\s+/g
  let last = 0
  let match
  while ((match = pattern.exec(source))) {
    ranges.push([last, match.index + match[0].length])
    last = match.index + match[0].length
  }
  if (last < source.length) ranges.push([last, source.length])
  return ranges.length ? ranges : [[0, source.length]]
}
