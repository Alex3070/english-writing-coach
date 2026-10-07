/**
 * 运行时配置：端口、模型、API Key 来源解析。
 *
 * API Key 按以下顺序查找，第一个命中的生效：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 项目根目录的 .env 文件（DEEPSEEK_API_KEY=sk-xxx）
 *   3. DSH 已有的凭证文件 ~/.dsh/.credentials.yaml
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PROJECT_ROOT = resolve(import.meta.dirname, '..')
export const PUBLIC_DIR = join(PROJECT_ROOT, 'public')

export const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
export const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
// 注意：Windows 会保留一些动态端口段（可用 `netsh interface ipv4 show excludedportrange protocol=tcp` 查看），
// 默认端口特意避开这些区段；如被占用可用 PORT 环境变量改端口。
export const DEFAULT_PORT = Number(process.env.PORT || 6801)

/** 界面上可供选择的模型（以账号实际可用清单为准）。 */
export const AVAILABLE_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek-Flash（快，适合日常练习）' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro（慢，批改更细致）' },
]

const DSH_CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml')

function parseDotEnv(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** 从形如 `KEY: value` 的简单 YAML 中读取一个键。 */
function readYamlScalar(file, key) {
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    const match = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '') : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析可用的 API Key。
 * @returns {{ apiKey: string | null, source: string }}
 */
export function resolveApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv) return { apiKey: fromEnv.trim(), source: '环境变量 DEEPSEEK_API_KEY' }

  const envFile = join(PROJECT_ROOT, '.env')
  if (existsSync(envFile)) {
    const fromFile = parseDotEnv(readFileSync(envFile, 'utf8')).DEEPSEEK_API_KEY
    if (fromFile) return { apiKey: fromFile, source: '.env 文件' }
  }

  const fromDsh = readYamlScalar(DSH_CREDENTIALS_FILE, 'DEEPSEEK_API_KEY')
  if (fromDsh) return { apiKey: fromDsh, source: 'DSH 凭证文件 ~/.dsh/.credentials.yaml' }

  return { apiKey: null, source: '未找到' }
}

export function loadConfig() {
  const { apiKey, source } = resolveApiKey()
  return {
    apiKey,
    apiKeySource: source,
    baseURL: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    port: DEFAULT_PORT,
  }
}
