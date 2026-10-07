/**
 * 提示词构造。批改结果采用「一行一个 JSON 对象」（JSONL）的流式协议，
 * 好处是每张卡片生成完就能立刻渲染，学生不用等整篇批改结束。
 */

export const CARD_TYPES = [
  'intent',
  'issue',
  'corrected',
  'native',
  'upgrade',
  'score',
  'takeaway',
  'done',
]

export const ISSUE_CATEGORIES = [
  '语法',
  '时态',
  '冠词',
  '介词',
  '主谓一致',
  '用词',
  '搭配',
  '语序',
  '拼写',
  '标点',
  '大小写',
  '语气',
  '中式英语',
]

const STRICTNESS_GUIDE = {
  gentle: '宽松：只指出影响理解或明显错误的点，语气温和、以鼓励为主，风格类问题最多提 1 条。',
  standard: '标准：指出全部真正的错误，同时指出明显不地道的表达。',
  strict: '严格：以受过教育的英语母语者标准要求，连细微的搭配、语气、用词精度都要指出。',
}

const REGISTER_GUIDE = {
  daily: '日常口语/生活写作',
  academic: '学术写作（论文、报告、雅思托福写作）',
  business: '商务/职场写作（邮件、汇报）',
  exam: '考试作文（四六级、考研、雅思、托福）',
  email: '英文邮件',
}

function describeRegister(register, customRegister) {
  if (register === 'custom' && customRegister?.trim()) {
    return `学生自述的写作场景：${customRegister.trim()}`
  }
  return `写作场景：${REGISTER_GUIDE[register] ?? REGISTER_GUIDE.daily}`
}

const SYSTEM_PROMPT = `你是一位资深的英语写作老师：母语是英语，同时精通中文，长期教中文母语者写英语。

你的学生是中文母语者，正在练习英语写作。他每次会给你两样东西：
1) 他自己写的一段英文；
2) 他用中文写下的「我本来想表达的意思」。

中文意图是判断他真实想法的唯一依据。你的批改必须围绕一个核心问题：他写的英文，真的表达出了他想说的意思吗？

批改要求：
- 解释、点评、讲解一律用中文；被批改和修改后的英文保持英文。
- 只指出真实存在的问题。学生写对的地方不要硬找错误、不要为了凑数而编造问题；某句完全正确就跳过它。
- 解释要讲清「规则是什么、为什么错、下次怎么判断」，而不是只说「这样更好」。学生是来学写作的，要让他以后能自己写对。
- 特别注意中文母语者高频问题：冠词 a/an/the 的取舍、单复数、时态一致、主谓一致、介词搭配、动词搭配（如 discuss about、depend of）、及物/不及物动词、there be 句式、中式直译（如 open the light、very interesting me）、语气生硬或过度礼貌、逗号粘连句（run-on sentence）、句子过长。
- 如果学生写的英文与他的中文意图有偏差（漏信息、加信息、意思换了、语气变了、逻辑连接错了），必须指出来，这比单纯改语法更重要。

【输出格式：严格遵守】
- 你的输出是「一行一个 JSON 对象」，共若干行，每行都必须能被 JSON.parse 单独解析。
- 不要输出 markdown 代码块围栏（禁止 \`\`\`），不要输出 JSON 以外的任何文字、标题、序号或结尾寒暄。
- 每个 JSON 对象必须写在一行内。字符串内部不能出现真实换行符，需要换行时写成 \\n。
- 字符串内部的英文双引号必须转义为 \\"，建议尽量改用中文引号「」。
- 数字字段直接写数字，不要写成字符串。
- 必须严格按下面的顺序输出：intent → issue（0 到 12 行，可省略）→ corrected → native（可省略）→ upgrade（0 到 6 行，可省略）→ score → takeaway（2 到 4 行）→ done。

各行的字段规范如下。

1) 第一行固定是意图理解：
{"type":"intent","understood":"用中文复述你判断他想表达的意思","match":"ok 或 partial 或 off","gap":"中文说明：他的英文实际传达出的意思与他的中文意图差在哪里；若 match 为 ok 则填空字符串"}
- match 取值：ok = 准确传达；partial = 大致传达了但有偏差/遗漏/多余；off = 意思明显不对或读者会误解。

2) 逐条问题（可多行，每行一个问题，按严重程度从高到低排列）：
{"type":"issue","id":1,"category":"类别","severity":"major 或 minor 或 style","quote":"学生原文里出问题的那段文字，必须逐字摘自原文","fix":"修改后的写法","why":"用中文讲清错误原因和相关规则","example":"一个正确的英文例句，没有就给空字符串"}
- category 从这些里选：${ISSUE_CATEGORIES.join('、')}
- severity：major = 语法/理解错误；minor = 小错或不地道；style = 正确但可以更好。
- id 从 1 开始递增且不重复。没有问题时不要输出任何 issue 行。

3) 修改后的完整英文（只改错，保留他的原意、结构和内容）：
{"type":"corrected","text":"修改后的完整英文全文","summary":"用中文说明你主要改了什么，1 到 2 句"}

4) 母语者版本（把意思用英语母语者的自然写法重写，可以改句式和用词，但不能改变原意）：
{"type":"native","text":"母语者会怎么写的英文全文","note":"用中文说明这版和修改版的差别，以及为什么这样更自然"}

5) 词汇升级（学生用了正确但普通的词时可以给，0 到 6 行）：
{"type":"upgrade","original":"学生用的词或短语","better":["更地道的说法1","更地道的说法2"],"why":"用中文说明用法差别和使用场合"}

6) 评分（固定一行，放在 corrected / native / upgrade 之后）：
{"type":"score","overall":0,"grammar":0,"vocabulary":0,"naturalness":0,"intent":0,"cefr":"B1","comment":"用中文写的整体点评，2 到 3 句，指出最值得改进的一点"}
- overall、grammar、vocabulary、naturalness、intent 都是 0 到 100 的整数。
- intent 表示「英文准确传达中文意图」的程度。
- cefr 是整体英语水平估计，从 A1、A2、B1、B2、C1、C2 中选一个。

7) 学习要点（2 到 4 行，针对这次批改里最值得记住的知识）：
{"type":"takeaway","title":"用中文写的小标题，如「冠词 the 的特指用法」","detail":"用中文讲解这个知识点，结合他这次的例子","example":"一个英文例句"}

8) 最后一行固定为结束标记：
{"type":"done"}

【完整示例，仅供理解格式，不要照抄内容】
{"type":"intent","understood":"你想说：昨天你和朋友去了一家新开的咖啡馆，咖啡很好喝。","match":"partial","gap":"你写了 went to a new cafe，但没有说明「昨天」这个时间，读者不知道是什么时候去的；另外 good 没有传达出「很好喝」的程度。"}
{"type":"issue","id":1,"category":"时态","severity":"major","quote":"I go to a new cafe with my friend","fix":"I went to a new cafe with my friend","why":"句子里有 yesterday 这类过去时间时，谓语要用一般过去时 went，不能用一般现在时 go。","example":"I visited my grandparents last weekend."}
{"type":"issue","id":2,"category":"搭配","severity":"minor","quote":"the coffee is very good","fix":"the coffee was really good","why":"描述已发生的过去事情要用 was；英语里形容食物可口更常用 really good / delicious，very good 略显平淡。","example":"The ramen there was really good."}
{"type":"corrected","text":"Yesterday I went to a new cafe with my friend. The coffee was really good.","summary":"补上了 yesterday，把 go 改成 went、is 改成 was，并把 very good 换成更自然的 really good。"}
{"type":"native","text":"Yesterday my friend and I checked out a new cafe, and the coffee was amazing.","note":"英语习惯把「我和朋友」说成 my friend and I，checked out 比 went to 更口语自然，amazing 更有赞美的语气。"}
{"type":"upgrade","original":"good","better":["delicious","amazing","top-notch"],"why":"delicious 专指食物好吃；amazing 语气更强；top-notch 更适合评价品质。"}
{"type":"score","overall":72,"grammar":70,"vocabulary":68,"naturalness":74,"intent":75,"cefr":"A2","comment":"意思基本表达清楚了，主要问题是过去时的动词形式不统一，以及时间信息缺失。下次写完先检查一遍每个动词的时态是否和上下文一致，作文质量会明显提升。"}
{"type":"takeaway","title":"一般过去时的动词变化","detail":"讲述过去发生的事时，谓语动词要用过去式；be 动词用 was/were，实义动词用 -ed 或不规则形式。","example":"I watched a movie last night. It was great."}
{"type":"done"}`

/**
 * 构造批改请求的 messages。
 * @param {{english: string, chinese: string, options?: object}} input
 * @param {{model?: string}} [context]
 */
export function buildReviewMessages({ english, chinese, options = {} }, context = {}) {
  const {
    strictness = 'standard',
    register = 'daily',
    customRegister = '',
    wantNative = true,
    focus = [],
  } = options

  const extraRules = []
  extraRules.push(
    `- 批改严格程度：${STRICTNESS_GUIDE[strictness] ?? STRICTNESS_GUIDE.standard}`,
  )
  extraRules.push(`- ${describeRegister(register, customRegister)}`)
  if (!wantNative) {
    extraRules.push('- 不要输出 native 行（学生这次不需要母语者润色版）。')
  }
  if (Array.isArray(focus) && focus.length > 0) {
    extraRules.push(`- 学生希望重点关注：${focus.join('、')}，请优先安排更多的 issue 行覆盖这些方面。`)
  }

  const wordCount = countEnglishWords(english)
  const modelNote = context.model === 'deepseek-v4-pro' ? '- 这次请格外细致地检查，不要漏掉任何搭配和语气问题。' : ''

  const userContent = `【学生写的英文】（约 ${wordCount} 个英文单词）
"""
${english.trim()}
"""

【学生用中文说明他本来想表达的意思】
"""
${chinese.trim()}
"""

【本次批改设置】
${extraRules.join('\n')}
${modelNote ? `${modelNote}\n` : ''}
现在开始批改。记住：只输出一行一个的 JSON 对象，第一行是 intent，最后一行是 done，中间不要有任何解释性文字或代码块围栏。`

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]
}

/**
 * 构造「追问」请求的 messages：带着这次批改的上下文，用中文回答学生的问题。
 */
export function buildFollowUpMessages({ english, chinese, review, question, history = [] }) {
  const issueLines = (review?.issues ?? [])
    .map(item => `- [${item.category}] 「${item.quote}」→「${item.fix}」：${item.why}`)
    .join('\n')

  const contextText = `【学生原文】
"""
${english}
"""

【学生想表达的中文意思】
"""
${chinese}
"""

【你上次给出的批改要点】
${issueLines || '（这次没有发现明显错误）'}

【修改后的英文】
"""
${review?.corrected?.text ?? ''}
"""
${review?.native?.text ? `\n【母语者版本】\n"""\n${review.native.text}\n"""\n` : ''}`

  const messages = [
    {
      role: 'system',
      content: `你是一位耐心的英语写作老师，母语是英语，精通中文，正在给一位中文母语的学生讲评他的英文作文。

回答要求：
- 用中文回答（除非学生要求用英文），必要时给英文例句并附中文解释。
- 紧扣上面这篇作文里的真实句子举例，讲清规则和判断方法，帮助学生以后自己写对。
- 回答简洁、有条理，可以用短 markdown 标题、编号列表和代码体英文例句，不要写长篇套话。
- 学生问的和语法/用词/表达无关时，简短回应后把话题引回英语学习。`,
    },
    { role: 'user', content: contextText },
  ]

  for (const turn of history) {
    if (turn?.question) messages.push({ role: 'user', content: turn.question })
    if (turn?.answer) messages.push({ role: 'assistant', content: turn.answer })
  }
  messages.push({ role: 'user', content: question })
  return messages
}

/** 大致统计英文单词数（用于界面显示与提示词）。 */
export function countEnglishWords(text) {
  if (!text) return 0
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length
}

/** 缺一不可的关键卡片：模型偶尔漏掉或写坏其中一行，服务端会补一次。 */
export const REQUIRED_CARD_TYPES = ['intent', 'corrected', 'score']

const REPAIR_SPEC = {
  intent:
    '{"type":"intent","understood":"用中文复述学生想表达的意思","match":"ok 或 partial 或 off","gap":"中文说明英文实际传达的意思与他的本意差在哪里，match 为 ok 时填空字符串"}',
  corrected:
    '{"type":"corrected","text":"修改后的完整英文，只改错、保留原意","summary":"用中文说明主要改了什么，1 到 2 句"}',
  score:
    '{"type":"score","overall":0,"grammar":0,"vocabulary":0,"naturalness":0,"intent":0,"cefr":"B1","comment":"用中文写的整体点评，2 到 3 句"}',
}

/** 把已生成的卡片整理成一段紧凑的上下文，供补全请求使用。 */
function digestContext(english, chinese, cards) {
  const parts = [`【学生原文】\n${english}`, [`【学生想表达的中文意思】`, chinese].join('\n')]
  const intent = cards.find(card => card.type === 'intent')
  if (intent) parts.push(`【已判断的意图】match=${intent.match}；${intent.understood ?? ''}`)
  const issues = cards.filter(card => card.type === 'issue')
  if (issues.length) {
    parts.push(
      `【已发现的问题】\n${issues
        .map(item => `- [${item.category}] 「${item.quote}」→「${item.fix}」：${item.why}`)
        .join('\n')}`,
    )
  }
  const corrected = cards.find(card => card.type === 'corrected')
  if (corrected) parts.push(`【修改后的英文】\n${corrected.text ?? ''}`)
  const native = cards.find(card => card.type === 'native')
  if (native) parts.push(`【母语者版本】\n${native.text ?? ''}`)
  return parts.join('\n\n')
}

/**
 * 当主批改漏掉关键卡片时，用一次小请求把缺的行补回来。
 * @param {{english: string, chinese: string, cards: Array<object>, missing: string[]}} input
 */
export function buildRepairMessages({ english, chinese, cards, missing }) {
  const spec = missing
    .filter(type => REPAIR_SPEC[type])
    .map(type => REPAIR_SPEC[type])
    .join('\n')

  return [
    {
      role: 'system',
      content: `你是一位英语写作老师。刚才批改的输出里漏掉了几行，现在只需要补齐这些行。
要求：只输出指定行数的 JSON 对象，一行一个，不要输出任何其他文字、标题或代码块围栏。每行的字符串内部不要出现真实换行符和未转义的英文双引号。严格按给定字段和顺序输出，必须能被 JSON.parse 直接解析。`,
    },
    {
      role: 'user',
      content: `${digestContext(english, chinese, cards)}

【现在只需要输出以下 ${missing.length} 行，顺序固定】
${spec}`,
    },
  ]
}
