<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { toast } from '../host'
import { API_BASE, ENCODERS } from '../constants'

// --- engine status ---
const statusChecked = ref(false)
const engineAvailable = ref(false)
const engineVersion = ref('')

// --- timing inputs / state ---
const videoPath = ref('')
const scriptPath = ref('')
const translatePath = ref('')

const timingTaskId = ref('')
const timingStatus = ref('') // '' | running | done | error | canceled
const timingPercent = ref(0)
const timingFps = ref(0)
const timingEta = ref('')
const dialogTotal = ref(0)
const matched = ref(0)
const previewB64 = ref('')
const assPath = ref('')
let timingTimer: any = null
let previewTimer: any = null

// --- suppress inputs / state ---
const sourceVideo = ref('')
const sourceSubtitle = ref('')
const outputPath = ref('')
const encoder = ref('HevcVideoToolbox')
const crf = ref(21)

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

onMounted(async () => {
  try {
    const s = await api('/engine/status')
    engineAvailable.value = !!s.available
    engineVersion.value = s.engine ? s.engine.name + ' v' + s.engine.version : ''
  } catch {
    engineAvailable.value = false
  } finally {
    statusChecked.value = true
  }
})

onUnmounted(() => clearAllTimers())
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
  resetTiming()
  try {
    const r = await post('/engine/timing/start', {
      videoPath: videoPath.value,
      scriptPath: scriptPath.value,
      translatePath: translatePath.value,
    })
    timingTaskId.value = r.taskId
    timingStatus.value = 'running'
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
  } catch (e: any) {
    toast('启动打轴失败: ' + e.message, 'error')
  }
}
function resetTiming() {
  timingPercent.value = 0; timingFps.value = 0; timingEta.value = ''
  dialogTotal.value = 0; matched.value = 0; previewB64.value = ''; assPath.value = ''
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
    matched.value = p.matched || 0
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
  stopTimingPolls()
  timingPercent.value = 100
  toast('打轴完成,正在导出字幕…', 'success')
  try {
    const r = await post('/engine/timing/export')
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
  resetSuppress()
  try {
    const r = await post('/engine/suppress/start', {
      sourceVideo: sourceVideo.value,
      outputPath: outputPath.value,
      sourceSubtitle: sourceSubtitle.value,
      crf: Number(crf.value) || 21,
      encoder: encoder.value,
      useHwAccelDecode: true,
    })
    suppressTaskId.value = r.taskId
    suppressStatus.value = 'running'
    suppressTimer = setInterval(pollSuppress, 500)
  } catch (e: any) {
    toast('启动压制失败: ' + e.message, 'error')
  }
}
function resetSuppress() {
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
  <div class="p-4 max-w-3xl mx-auto space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">自动打轴 + 压制</h1>
      <span v-if="statusChecked && engineAvailable" class="badge badge-success">引擎就绪 · {{ engineVersion }}</span>
      <span v-else-if="statusChecked" class="badge badge-error">引擎未安装</span>
    </div>

    <div v-if="statusChecked && !engineAvailable" class="alert alert-warning text-sm">
      <span>打轴引擎未安装。需把 SekaiToolsEngine 与 libass 版 ffmpeg 随版本打包到后端的 engine/ 目录(见设置页说明)。</span>
    </div>

    <!-- ① 打轴 -->
    <div class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <h2 class="card-title text-base">① 打轴(识别对话生成时间轴)</h2>

        <label class="form-control">
          <span class="label-text text-xs">视频文件</span>
          <input class="input input-bordered input-sm w-full" v-model="videoPath" placeholder="视频绝对路径 (mp4/mov/mkv...)" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">剧本 JSON(日文 scenario)</span>
          <input class="input input-bordered input-sm w-full" v-model="scriptPath" placeholder="scenario JSON 绝对路径" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">翻译 txt(可选)</span>
          <input class="input input-bordered input-sm w-full" v-model="translatePath" placeholder="可留空" />
        </label>

        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" :disabled="!engineAvailable || timingRunning" @click="startTiming">开始打轴</button>
          <button class="btn btn-ghost btn-sm" :disabled="!timingRunning" @click="cancelTiming">取消</button>
        </div>

        <div v-if="timingStatus">
          <progress class="progress progress-primary w-full" :value="timingPercent" max="100"></progress>
          <div class="text-xs opacity-70 mt-1">
            {{ timingStatus }} · {{ timingPercent.toFixed(1) }}% · fps {{ timingFps }} · 剩余 {{ timingEta }} · 已匹配 {{ matched }}/{{ dialogTotal }}
          </div>
        </div>
        <img v-if="previewSrc" :src="previewSrc" class="rounded border border-base-300 max-h-72 self-start" />
        <div v-if="assPath" class="alert alert-success py-2 text-xs"><span>✓ 字幕已导出: {{ assPath }}</span></div>
      </div>
    </div>

    <!-- ② 压制 -->
    <div class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <h2 class="card-title text-base">② 压制(烧录字幕导出成片)</h2>

        <label class="form-control">
          <span class="label-text text-xs">源视频</span>
          <input class="input input-bordered input-sm w-full" v-model="sourceVideo" placeholder="打轴完成后自动填充,也可手填" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">字幕 ass</span>
          <input class="input input-bordered input-sm w-full" v-model="sourceSubtitle" placeholder="打轴导出后自动填充" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">输出 mp4</span>
          <input class="input input-bordered input-sm w-full" v-model="outputPath" placeholder="输出文件绝对路径" />
        </label>

        <div class="flex gap-3 items-end flex-wrap">
          <label class="form-control">
            <span class="label-text text-xs">编码器</span>
            <select class="select select-bordered select-sm" v-model="encoder">
              <option v-for="e in ENCODERS" :key="e" :value="e">{{ e }}</option>
            </select>
          </label>
          <label class="form-control">
            <span class="label-text text-xs">CRF / 质量</span>
            <input type="number" class="input input-bordered input-sm w-24" v-model="crf" min="0" max="51" />
          </label>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" :disabled="!engineAvailable || suppressRunning" @click="startSuppress">开始压制</button>
          <button class="btn btn-ghost btn-sm" :disabled="!suppressRunning" @click="cancelSuppress">取消</button>
        </div>

        <div v-if="suppressStatus">
          <progress class="progress progress-secondary w-full" :value="suppressPercent" max="100"></progress>
          <div class="text-xs opacity-70 mt-1">
            {{ suppressStatus }} · {{ suppressPercent.toFixed(1) }}% · 帧 {{ suppressFrame }}/{{ suppressTotal }} · fps {{ suppressFps.toFixed(0) }}
          </div>
          <code v-if="suppressLog" class="block truncate opacity-60" style="font-size:10px">{{ suppressLog }}</code>
        </div>
      </div>
    </div>
  </div>
</template>
