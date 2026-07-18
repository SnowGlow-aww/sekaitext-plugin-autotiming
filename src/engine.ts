// 引擎 HTTP 层：绝对 URL（打包态 origin 是 sekai://localhost，相对 /api 会失效），
// 以及行列表/分句编辑的类型与共享工具函数。
import { API_BASE } from './constants'

export async function api(path: string, opts?: any) {
  const res = await fetch(API_BASE + path, opts)
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err: any = new Error((data && data.error) || 'HTTP ' + res.status)
    err.status = res.status
    throw err
  }
  return data || {}
}

export function post(path: string, body?: any) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// 引擎 subtitle.lines / subtitle.setSeparator 返回的行对象。
export interface EngineLine {
  type: 'dialog' | 'banner' | 'marker'
  index: number
  character?: string
  body: string
  bodyTranslated: string
  startIndex: number
  endIndex: number
  shake?: boolean
  needSetSeparator?: boolean
  useSeparator?: boolean
  separateFrame?: number
  separatorContentIndex?: number
  contentLength?: number
}

export interface LinesPayload {
  fps: number
  width: number
  height: number
  frameCount: number
  finished: boolean
  lines: EngineLine[]
}

// 与引擎 C# TrimAll 同口径：去掉 \R、\N 字面量与真实换行，再修剪首尾空白。
export function trimAll(s: string): string {
  return (s || '')
    .split('\\N').join('')
    .split('\\R').join('')
    .split('\\n').join('')
    .replace(/[\r\n]/g, '')
    .trim()
}

// 帧 → ASS 风格时间显示 "0:00:11.86"
export function frameToTime(frame: number, fps: number): string {
  if (!fps || fps <= 0) return '-'
  const totalSec = Math.max(0, frame / fps)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const cs = Math.floor((totalSec - Math.floor(totalSec)) * 100)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

// 与 Avalonia 卡片一致的溢出预警口径：游戏打字机 80ms/字。
export const CHAR_TIME_MS = 80
