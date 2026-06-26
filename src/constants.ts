// The backend lives on the Go sidecar at a fixed port. In the packaged app
// location.origin is `tauri://localhost`, so a relative `/api/...` URL would
// resolve to tauri://localhost/api and fail — engine calls MUST be absolute.
export const BACKEND_ORIGIN = 'http://localhost:9800'
export const API_BASE = BACKEND_ORIGIN + '/api/v1'

// VideoEncoder enum names accepted by the engine's suppress.start.
// HevcVideoToolbox = macOS hardware HEVC (default). Software x264/x265 are portable.
export const ENCODERS = [
  'HevcVideoToolbox',
  'H264VideoToolbox',
  'Libx264',
  'Libx265',
  'LibSvtAv1',
  'HevcNvenc',
  'H264Nvenc',
  'Av1Nvenc',
  'HevcQsv',
  'H264Qsv',
  'Av1Qsv',
]
