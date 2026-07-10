// The backend lives on the Go sidecar. In the packaged app location.origin is
// the custom scheme (e.g. `sekai://localhost`), so a relative `/api/...` URL
// would resolve against it and fail — engine calls MUST be absolute. Read the
// origin Rust injects as `window.__SEKAI_ORIGIN__` (release = `sekai://localhost`;
// dev = `http://localhost:9800`), falling back to the dev TCP address if unset.
export const BACKEND_ORIGIN = (window as any).__SEKAI_ORIGIN__ || 'http://localhost:9800'
export const API_BASE = BACKEND_ORIGIN + '/api/v1'

// Tauri webview 的 UA 反映宿主系统——Windows 上 WebView2 带 "Windows NT"。
export const IS_MAC = /Mac/i.test(navigator.userAgent)

// VideoEncoder 枚举名 → 展示名（引擎 suppress.start 接受的就是枚举名）。
export const ENCODER_LABELS: Record<string, string> = {
  HevcVideoToolbox: 'HEVC · VideoToolbox（Mac 硬编）',
  H264VideoToolbox: 'H264 · VideoToolbox（Mac 硬编）',
  HevcNvenc: 'HEVC · NVENC（NVIDIA 硬编）',
  H264Nvenc: 'H264 · NVENC（NVIDIA 硬编）',
  Av1Nvenc: 'AV1 · NVENC（NVIDIA 硬编）',
  HevcQsv: 'HEVC · QSV（Intel 硬编）',
  H264Qsv: 'H264 · QSV（Intel 硬编）',
  Av1Qsv: 'AV1 · QSV（Intel 硬编）',
  HevcAmf: 'HEVC · AMF（AMD 硬编）',
  H264Amf: 'H264 · AMF（AMD 硬编）',
  Av1Amf: 'AV1 · AMF（AMD 硬编）',
  Libx264: 'H264 · x264（软编 · 全平台可用）',
  Libx265: 'HEVC · x265（软编）',
  LibSvtAv1: 'AV1 · SVT-AV1（软编）',
}

export function encoderLabel(name: string): string {
  return ENCODER_LABELS[name] || name
}

// 宿主还不支持 /engine/suppress/probe（app <5.7.3 / 内核 <2.1.0）时的兜底列表：
// 只列本平台可能可用的项，默认软编保证能跑。此前默认 HevcVideoToolbox 在
// Windows 上是 "Unknown encoder"，压制 100% 起不来。AMF 项老内核不认识，不进兜底。
export const FALLBACK_ENCODERS = IS_MAC
  ? ['HevcVideoToolbox', 'H264VideoToolbox', 'Libx264', 'Libx265', 'LibSvtAv1']
  : ['Libx264', 'Libx265', 'LibSvtAv1', 'HevcNvenc', 'H264Nvenc', 'Av1Nvenc', 'HevcQsv', 'H264Qsv', 'Av1Qsv']

export const FALLBACK_DEFAULT_ENCODER = IS_MAC ? 'HevcVideoToolbox' : 'Libx264'
