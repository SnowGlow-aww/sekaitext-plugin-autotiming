<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { toast, pickFile, pickSave, goHome } from '../host'
import { API_BASE, ENCODERS } from '../constants'

// --- engine status ---
const statusChecked = ref(false)
const engineAvailable = ref(false) // binary present on disk
const engineReady = ref(false)     // engine actually usable (gates 开始 buttons)
const engineError = ref('')        // backend-provided reason when not ready
const engineVersion = ref('')

// --- timing inputs / state ---
const videoPath = ref('')
const scriptPath = ref('')
const translatePath = ref('')

// --- recognition thresholds (可调参数; sent as the engine's threshold object) ---
const THRESHOLD_DEFAULTS = {
  dialogNametagNormal: 0.8,
  dialogNametagSpecial: 0.6,
  dialogContentNormal: 0.8,
  dialogContentSpecial: 0.6,
  bannerNormal: 0.8,
  markerNormal: 0.8,
  dialogDropGraceSeconds: 0.3,
}
const showThreshold = ref(false)
const threshold = ref({ ...THRESHOLD_DEFAULTS })
function resetThreshold() {
  threshold.value = { ...THRESHOLD_DEFAULTS }
}
// Coerce every threshold to a finite number, falling back to its default when a
// field was cleared: v-model.number yields '' for an empty input, and the
// engine's GetDouble() rejects a non-number JSON value, hard-failing 打轴 start.
function thresholdPayload(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(THRESHOLD_DEFAULTS) as (keyof typeof THRESHOLD_DEFAULTS)[]) {
    const v = (threshold.value as any)[k]
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : THRESHOLD_DEFAULTS[k]
  }
  return out
}
const THRESHOLD_FIELDS: { key: keyof typeof THRESHOLD_DEFAULTS; label: string; max: number; step: number }[] = [
  { key: 'dialogNametagNormal', label: '对话名牌·普通', max: 1, step: 0.05 },
  { key: 'dialogNametagSpecial', label: '对话名牌·特殊', max: 1, step: 0.05 },
  { key: 'dialogContentNormal', label: '对话正文·普通', max: 1, step: 0.05 },
  { key: 'dialogContentSpecial', label: '对话正文·特殊', max: 1, step: 0.05 },
  { key: 'bannerNormal', label: '横幅 banner', max: 1, step: 0.05 },
  { key: 'markerNormal', label: '标记 marker', max: 1, step: 0.05 },
  { key: 'dialogDropGraceSeconds', label: '掉帧宽限(秒)', max: 3, step: 0.1 },
]

const timingTaskId = ref('')
const timingStatus = ref('') // '' | running | done | error | canceled
const timingPercent = ref(0)
const timingFps = ref(0)
const timingEta = ref('')
const dialogTotal = ref(0)
const bannerTotal = ref(0)
const markerTotal = ref(0)
const matchedDialog = ref(0)
const matchedBanner = ref(0)
const matchedMarker = ref(0)
const previewB64 = ref('')
const assPath = ref('')
let timingTimer: any = null
let previewTimer: any = null
let timingDoneHandled = false

// --- suppress inputs / state ---
const sourceVideo = ref('')
const sourceSubtitle = ref('')
const outputPath = ref('')
const encoder = ref('HevcVideoToolbox')
const crf = ref<number | string>(21) // input may yield '' when cleared; keep 0 distinct
const useHwAccelDecode = ref(true)

const suppressTaskId = ref('')
const suppressStatus = ref('')
const suppressPercent = ref(0)
const suppressFrame = ref(0)
const suppressTotal = ref(0)
const suppressFps = ref(0)
const suppressLog = ref('')
let suppressTimer: any = null

const previewSrc = computed(() => (previewB64.value ? 'data:image/jpeg;base64,' + previewB64.value : ''))
const timingRunning = computed(() => timingStatus.value === 'running')
const suppressRunning = computed(() => suppressStatus.value === 'running')

// --- backend helpers (absolute URLs; relative /api fails under tauri://localhost) ---
async function api(path: string, opts?: any) {
  const res = await fetch(API_BASE + path, opts)
  let data: any = null
  try { data = await res.json() } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
  return data || {}
}
function post(path: string, body?: any) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// --- file pickers (host Tauri dialog → absolute path) ---
async function browse(setter: (v: string) => void, filters: any[], opts?: { save?: boolean; def?: string }) {
  try {
    const p = opts?.save
      ? await pickSave({ defaultPath: opts?.def || undefined, filters })
      : await pickFile({ multiple: false, directory: false, filters })
    if (typeof p === 'string' && p) setter(p)
  } catch {
    toast('当前环境不支持文件选择，请手动填写路径', 'warn')
  }
}
const VIDEO_FILTER = [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'ts', 'm2ts', 'webm'] }]

onMounted(async () => {
  try {
    const s = await api('/engine/status')
    engineAvailable.value = !!s.available
    engineReady.value = !!s.ready
    engineError.value = s.error || ''
    engineVersion.value = s.engine ? s.engine.name + ' v' + s.engine.version : ''
  } catch (e: any) {
    engineAvailable.value = false
    engineReady.value = false
    engineError.value = (e && e.message) || ''
  } finally {
    statusChecked.value = true
  }
})

onUnmounted(() => clearAllTimers())
// The host wraps plugin routes in <keep-alive>, so navigating back to the editor
// DEACTIVATES (does not unmount) this page — stop polling while hidden, and
// resume if a run is still in flight when we return.
onDeactivated(() => clearAllTimers())
onActivated(() => {
  if (timingTaskId.value && timingStatus.value === 'running' && !timingTimer) {
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
  }
  if (suppressTaskId.value && suppressStatus.value === 'running' && !suppressTimer) {
    suppressTimer = setInterval(pollSuppress, 500)
  }
})
function clearAllTimers() {
  for (const t of [timingTimer, previewTimer, suppressTimer]) if (t) clearInterval(t)
  timingTimer = previewTimer = suppressTimer = null
}

function defaultOutput() {
  const v = sourceVideo.value || videoPath.value
  if (!v) return ''
  const dot = v.lastIndexOf('.')
  return (dot > 0 ? v.slice(0, dot) : v) + '_subbed.mp4'
}

// --- 打轴 ---
async function startTiming() {
  if (!videoPath.value || !scriptPath.value) { toast('请先填写视频和剧本 JSON 路径', 'warn'); return }
  if (timingRunning.value) return
  resetTiming()            // also clears any leftover poll timers (see resetTiming)
  timingStatus.value = 'running' // disable button synchronously before awaiting
  try {
    const r = await post('/engine/timing/start', {
      videoPath: videoPath.value,
      scriptPath: scriptPath.value,
      translatePath: translatePath.value,
      // Always a full object of finite numbers so the engine's threshold parser
      // never sees a scalar or an empty-string (cleared field) value.
      threshold: thresholdPayload(),
    })
    timingTaskId.value = r.taskId
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
  } catch (e: any) {
    timingStatus.value = '' // re-enable button so the user can retry
    toast('启动打轴失败: ' + e.message, 'error')
  }
}
function resetTiming() {
  stopTimingPolls()
  timingDoneHandled = false
  timingPercent.value = 0; timingFps.value = 0; timingEta.value = ''
  dialogTotal.value = 0; bannerTotal.value = 0; markerTotal.value = 0
  matchedDialog.value = 0; matchedBanner.value = 0; matchedMarker.value = 0
  previewB64.value = ''; assPath.value = ''
}
function stopTimingPolls() {
  if (timingTimer) clearInterval(timingTimer)
  if (previewTimer) clearInterval(previewTimer)
  timingTimer = previewTimer = null
}
async function pollTiming() {
  if (!timingTaskId.value) return
  try {
    const p = await api('/engine/timing/progress?task=' + timingTaskId.value)
    timingStatus.value = p.status
    timingPercent.value = p.percent || 0
    timingFps.value = p.fps || 0
    timingEta.value = p.eta || ''
    dialogTotal.value = p.dialogTotal || 0
    bannerTotal.value = p.bannerTotal || 0
    markerTotal.value = p.markerTotal || 0
    matchedDialog.value = p.matchedDialog || 0
    matchedBanner.value = p.matchedBanner || 0
    matchedMarker.value = p.matchedMarker || 0
    if (p.status === 'done') onTimingDone()
    else if (p.status === 'error') { stopTimingPolls(); toast('打轴失败: ' + (p.error || ''), 'error') }
    else if (p.status === 'canceled') { stopTimingPolls() }
  } catch { /* transient; keep polling */ }
}
async function pollPreview() {
  if (!timingTaskId.value) return
  try {
    const p = await api('/engine/timing/preview?task=' + timingTaskId.value)
    if (p.base64) previewB64.value = p.base64
  } catch { /* ignore */ }
}
async function onTimingDone() {
  if (timingDoneHandled) return // guard against overlapping polls firing this twice
  timingDoneHandled = true
  stopTimingPolls()
  timingPercent.value = 100
  toast('打轴完成,正在导出字幕…', 'success')
  try {
    // Bind export to this finished task so a re-run can't make the backend hand
    // back the wrong/half-built subtitle.
    const r = await post('/engine/timing/export?task=' + timingTaskId.value)
    assPath.value = r.assPath
    // auto-fill the suppress section for the one-shot flow
    sourceVideo.value = videoPath.value
    sourceSubtitle.value = r.assPath
    if (!outputPath.value) outputPath.value = defaultOutput()
    toast('字幕已导出', 'success')
  } catch (e: any) {
    toast('导出字幕失败: ' + e.message, 'error')
  }
}
async function cancelTiming() {
  try { await post('/engine/cancel?domain=timing') } catch { /* ignore */ }
}

// --- 压制 ---
async function startSuppress() {
  if (!sourceVideo.value || !outputPath.value) { toast('请填写源视频和输出路径', 'warn'); return }
  if (suppressRunning.value) return
  resetSuppress()              // also clears any leftover poll timer (see resetSuppress)
  suppressStatus.value = 'running' // disable button synchronously before awaiting
  // keep CRF 0 (lossless) intact; only fall back to 21 on empty/invalid input
  const crfVal = crf.value === '' ? 21 : Number(crf.value)
  try {
    const r = await post('/engine/suppress/start', {
      sourceVideo: sourceVideo.value,
      outputPath: outputPath.value,
      sourceSubtitle: sourceSubtitle.value,
      crf: Number.isNaN(crfVal) ? 21 : crfVal,
      encoder: encoder.value,
      useHwAccelDecode: useHwAccelDecode.value,
    })
    suppressTaskId.value = r.taskId
    suppressTimer = setInterval(pollSuppress, 500)
  } catch (e: any) {
    suppressStatus.value = '' // re-enable button so the user can retry
    toast('启动压制失败: ' + e.message, 'error')
  }
}
function resetSuppress() {
  stopSuppressPoll()
  suppressPercent.value = 0; suppressFrame.value = 0; suppressTotal.value = 0
  suppressFps.value = 0; suppressLog.value = ''
}
async function pollSuppress() {
  if (!suppressTaskId.value) return
  try {
    const p = await api('/engine/suppress/progress?task=' + suppressTaskId.value)
    suppressStatus.value = p.status
    suppressPercent.value = p.percent || 0
    suppressFrame.value = p.frame || 0
    suppressTotal.value = p.total || 0
    suppressFps.value = p.fps || 0
    suppressLog.value = p.lastLog || ''
    if (p.status === 'done') { stopSuppressPoll(); toast('压制完成: ' + (p.outputPath || outputPath.value), 'success') }
    else if (p.status === 'error') { stopSuppressPoll(); toast('压制失败: ' + (p.error || ''), 'error') }
    else if (p.status === 'canceled') { stopSuppressPoll() }
  } catch { /* ignore */ }
}
function stopSuppressPoll() {
  if (suppressTimer) clearInterval(suppressTimer)
  suppressTimer = null
}
async function cancelSuppress() {
  try { await post('/engine/cancel?domain=suppress') } catch { /* ignore */ }
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
    <!-- Header: back to editor + title + engine status -->
    <header class="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-surface)_90%,transparent)] backdrop-blur-md">
      <div class="flex items-center gap-2 px-4 h-12 max-w-3xl mx-auto">
        <button
          class="grid place-items-center w-8 h-8 -ml-1 rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          title="返回编辑器"
          @click="goHome"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        </button>
        <span class="font-bold tracking-tight">自动打轴 + 压制</span>
        <span v-if="statusChecked && engineReady" class="app-chip bg-success/15 text-success ml-auto">引擎就绪 · {{ engineVersion }}</span>
        <span v-else-if="statusChecked" class="app-chip bg-error/15 text-error ml-auto">{{ engineError || '引擎未安装' }}</span>
      </div>
    </header>

    <div class="p-4 max-w-3xl mx-auto space-y-4">
      <div
        v-if="statusChecked && !engineReady"
        class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-warning/10 text-warning p-3 text-sm"
      >
        <span v-if="engineError">{{ engineError }}</span>
        <span v-else>打轴引擎未安装。需把 SekaiToolsEngine 与 libass 版 ffmpeg 随版本打包到后端的 engine/ 目录(见设置页说明)。</span>
      </div>

      <!-- ① 打轴 -->
      <div class="app-card p-5 space-y-3">
        <div class="section-title">① 打轴(识别对话生成时间轴)</div>

        <label class="block">
          <span class="app-label">视频文件</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="videoPath" placeholder="视频绝对路径 (mp4/mov/mkv...)" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (videoPath = v), VIDEO_FILTER)">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">剧本 JSON(日文 scenario)</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="scriptPath" placeholder="scenario JSON 绝对路径" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (scriptPath = v), [{ name: '剧本 JSON', extensions: ['json'] }])">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">翻译 txt(可选)</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="translatePath" placeholder="可留空" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (translatePath = v), [{ name: '文本', extensions: ['txt'] }])">选择…</button>
          </div>
        </label>

        <!-- 可调参数：识别阈值 -->
        <div>
          <button class="btn btn-sm btn-ghost border border-[var(--color-border)]" @click="showThreshold = !showThreshold">
            识别阈值（高级） {{ showThreshold ? '▴' : '▾' }}
          </button>
          <div v-if="showThreshold" class="mt-2 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3 space-y-2">
            <div class="grid grid-cols-2 gap-x-3 gap-y-2">
              <label v-for="f in THRESHOLD_FIELDS" :key="f.key" class="block">
                <span class="app-label">{{ f.label }}</span>
                <input type="number" class="app-input mt-1" v-model.number="threshold[f.key]" min="0" :max="f.max" :step="f.step" />
              </label>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="app-help">数值越高越严格(更少误匹配、更易漏轴);掉帧宽限单位为秒。</span>
              <button class="btn btn-xs btn-ghost border border-[var(--color-border)] shrink-0" @click="resetThreshold">恢复默认</button>
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-sm btn-brand" :disabled="!engineReady || timingRunning" @click="startTiming">开始打轴</button>
          <button class="btn btn-sm btn-ghost border border-[var(--color-border)]" :disabled="!timingRunning" @click="cancelTiming">取消</button>
        </div>

        <div v-if="timingStatus">
          <progress class="progress progress-primary w-full" :value="timingPercent" max="100"></progress>
          <div class="app-help mt-1">
            {{ timingStatus }} · {{ timingPercent.toFixed(1) }}% · fps {{ timingFps }} · 剩余 {{ timingEta }} · 对话 {{ matchedDialog }}/{{ dialogTotal }}<template v-if="bannerTotal"> · banner {{ matchedBanner }}/{{ bannerTotal }}</template><template v-if="markerTotal"> · marker {{ matchedMarker }}/{{ markerTotal }}</template>
          </div>
        </div>
        <img v-if="previewSrc" :src="previewSrc" class="rounded-[var(--radius-control)] border border-[var(--color-border)] max-h-72 self-start" />
        <div v-if="assPath" class="app-help text-success">✓ 字幕已导出: {{ assPath }}</div>
      </div>

      <!-- ② 压制 -->
      <div class="app-card p-5 space-y-3">
        <div class="section-title">② 压制(烧录字幕导出成片)</div>

        <label class="block">
          <span class="app-label">源视频</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="sourceVideo" placeholder="打轴完成后自动填充,也可手填" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (sourceVideo = v), VIDEO_FILTER)">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">字幕 ass</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="sourceSubtitle" placeholder="打轴导出后自动填充" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (sourceSubtitle = v), [{ name: '字幕', extensions: ['ass', 'ssa', 'srt'] }])">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">输出 mp4</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="outputPath" placeholder="输出文件绝对路径" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (outputPath = v), [{ name: 'MP4', extensions: ['mp4'] }], { save: true, def: defaultOutput() })">另存为…</button>
          </div>
        </label>

        <!-- 编码器占满剩余宽、CRF 固定列宽，两者等高成列 -->
        <div class="grid grid-cols-[1fr_7rem] gap-3">
          <label class="block">
            <span class="app-label">编码器</span>
            <select class="app-input mt-1" v-model="encoder">
              <option v-for="e in ENCODERS" :key="e" :value="e">{{ e }}</option>
            </select>
          </label>
          <label class="block">
            <span class="app-label">CRF / 质量</span>
            <input type="number" class="app-input mt-1" v-model="crf" min="0" max="51" />
          </label>
        </div>

        <label class="flex items-center gap-2 cursor-pointer w-fit">
          <input type="checkbox" class="checkbox checkbox-sm" v-model="useHwAccelDecode" />
          <span class="app-label">硬件解码加速</span>
        </label>

        <div class="flex gap-2">
          <button class="btn btn-sm btn-brand" :disabled="!engineReady || suppressRunning" @click="startSuppress">开始压制</button>
          <button class="btn btn-sm btn-ghost border border-[var(--color-border)]" :disabled="!suppressRunning" @click="cancelSuppress">取消</button>
        </div>

        <div v-if="suppressStatus">
          <progress class="progress progress-primary w-full" :value="suppressPercent" max="100"></progress>
          <div class="app-help mt-1">
            {{ suppressStatus }} · {{ suppressPercent.toFixed(1) }}% · 帧 {{ suppressFrame }}/{{ suppressTotal }} · fps {{ suppressFps.toFixed(0) }}
          </div>
          <code v-if="suppressLog" class="block truncate app-help" style="font-size:10px">{{ suppressLog }}</code>
        </div>
      </div>
    </div>
  </div>
</template>
