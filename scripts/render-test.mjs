/**
 * 渲染逻辑单元测试（纯逻辑，不需要浏览器和网络）。
 * 用法：npm test  或  node scripts/render-test.mjs
 *
 * 覆盖的是那个真实 bug：曾经用词级 diff 猜对齐，把删掉的词混进改写后的句子，
 * 渲染出「I have abeen farlearning timeEnglish tofor learna Englishlong time.」这种读不通的文本。
 */
import { collectFixMatches, normalizeFixFragment, sentenceRanges } from '../public/article-render.mjs'

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

const slice = (text, spans) => spans.map(span => text.slice(span.start, span.end))

// ---- normalizeFixFragment ----
check('去掉中文括号说明', normalizeFixFragment('for a long time（配合 have been learning）') === 'for a long time')
check('去掉整段中文', normalizeFixFragment('改成 was really good 更好') === 'was really good')
check('纯中文返回空', normalizeFixFragment('这里要改成过去时') === '')
check('太短的片段返回空', normalizeFixFragment('a') === '')
check('保留英文原样', normalizeFixFragment('I have been learning') === 'I have been learning')

// ---- collectFixMatches ----
const corrected =
  'Yesterday I went to a new cafe with my friend. The coffee was really good, but the price was a bit high.'
const issues = [
  { quote: 'The coffee is very good', fix: 'was really good' },
  { quote: 'the price is a little expensive', fix: 'a bit high' },
]
const matched = collectFixMatches(corrected, issues)
check('定位到两处改动', matched.length === 2, JSON.stringify(slice(corrected, matched)))
check('高亮文本正是改动后的写法',
  JSON.stringify(slice(corrected, matched)) === JSON.stringify(['was really good', 'a bit high']))

check('改写后的文本里没有该片段时不误标',
  slice(corrected, collectFixMatches(corrected, [{ fix: 'for a long time' }])).length === 0)

const withTime = 'I have been learning English for a long time.'
check('中文注释被剥离后仍能定位',
  JSON.stringify(slice(withTime, collectFixMatches(withTime, [{ fix: 'for a long time（配合 have been learning）' }])))
  === JSON.stringify(['for a long time']))

check('整句 fix 不整段涂色',
  collectFixMatches(corrected, [{ quote: 'The coffee is very good, but the price is a little expensive', fix: 'The coffee was really good, but the price was a bit high' }]).length === 0)

check('fix 与 quote 相同则不标',
  collectFixMatches(corrected, [{ quote: 'with my friend', fix: 'with my friend' }]).length === 0)

check('不匹配单词中间',
  collectFixMatches('the cat sat', [{ quote: 'x', fix: 'he' }]).length === 0)

check('大小写不敏感',
  JSON.stringify(slice(corrected, collectFixMatches(corrected, [{ fix: 'Really Good' }]))) === JSON.stringify(['really good']))

const overlapping = collectFixMatches(corrected, [{ fix: 'a bit high' }, { fix: 'bit' }])
check('重叠片段只保留一个', overlapping.length === 1, JSON.stringify(slice(corrected, overlapping)))

check('没有 fix 字段时不崩', collectFixMatches(corrected, [{}, { fix: null }, { fix: '' }]).length === 0)
check('空文本不崩', collectFixMatches('', [{ fix: 'good' }]).length === 0)
check('issues 为空时返回空数组', collectFixMatches(corrected, []).length === 0)

const many = collectFixMatches('good good good good good good good good good good good good good good good good good good good good good good good good good good good good',
  Array.from({ length: 30 }, () => ({ fix: 'good' })))
check('高亮数量有上限', many.length <= 24, `${many.length} 处`)

const ranges = collectFixMatches(corrected, issues).sort((a, b) => a.start - b.start)
check('区间互不重叠且顺序正确', ranges.every((span, index) => index === 0 || span.start >= ranges[index - 1].end))
check('区间不越界', ranges.every(span => span.start >= 0 && span.end <= corrected.length))

// ---- sentenceRanges ----
const sentences = sentenceRanges(corrected)
check('句子区间首尾相接且覆盖全文',
  sentences[0][0] === 0 &&
  sentences[sentences.length - 1][1] === corrected.length &&
  sentences.every((range, index) => index === 0 || range[0] === sentences[index - 1][1]),
  JSON.stringify(sentences))
check('句子拼接后与原文逐字相同',
  sentences.map(([from, to]) => corrected.slice(from, to)).join('') === corrected)
check('无标点时返回整段', JSON.stringify(sentenceRanges('hello world')) === JSON.stringify([[0, 11]]))
check('空字符串不崩', sentenceRanges('').length === 1)

console.log('─'.repeat(70))
console.log(failures === 0 ? '渲染逻辑单元测试全部通过 ✓' : `${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
