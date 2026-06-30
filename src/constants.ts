// The backend lives on the Go sidecar. In the packaged app location.origin is
// the custom scheme (e.g. `sekai://localhost`), so a relative `/api/...` URL
// would resolve against it and fail — engine calls MUST be absolute. Read the
// origin Rust injects as `window.__SEKAI_ORIGIN__` (release = `sekai://localhost`;
// dev = `http://localhost:9800`), falling back to the dev TCP address if unset.
export const BACKEND_ORIGIN = (window as any).__SEKAI_ORIGIN__ || 'http://localhost:9800'
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
