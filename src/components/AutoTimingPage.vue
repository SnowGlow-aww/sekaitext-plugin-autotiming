<script setup lang="ts">
// 双列布局：左列=输入与运行控制（对照 Avalonia 独立版），右列=行列表与分句微调；
// 压制保持在下方整宽（下滑可见）。导出内建 tools.lua 清理 + Aegisub 双向同步。
import { ref, shallowRef, computed, nextTick, onMounted, onUnmounted, onActivated, onDeactivated, watch } from 'vue'
import { toast, pickFile, pickSave, goHome } from '../host'
import { FALLBACK_ENCODERS, FALLBACK_DEFAULT_ENCODER, encoderLabel } from '../constants'
import { api, post, type EngineLine, type LinesPayload } from '../engine'
import { createSingleFlightPoll } from '../polling'
import LineRow from './LineRow.vue'
// 内置团队样式模板：随插件分发，导出时整段直传后端 —— 开箱即用，无需人手一份文件。
import BUILTIN_STYLE_TEMPLATE from '../assets/team-style-template.ass?raw'
const BUILTIN_STYLE_TEMPLATE_NAME = 'pjs剧情轴样式 v3.1.3'

// --- engine status ---
const statusChecked = ref(false)
const engineAvailable = ref(false) // binary present on disk
const engineReady = ref(false)     // engine actually usable (gates 开始 buttons)
const engineError = ref('')        // backend-provided reason when not ready
const engineVersion = ref('')
const hostTooOld = ref(false)      // 行列表端点 404：宿主(app)还没升到带新后端的版本

// --- timing inputs / state ---
const videoPath = ref('')
const scriptPath = ref('')
const translatePath = ref('')

// Custom .ass output directory. Persisted in localStorage so it survives restarts;
// empty => backend writes to its default subtitles dir. The .ass is named after the
// scenario script (event_206_05.json -> event_206_05.ass).
const ASS_OUTDIR_KEY = 'autotiming:assOutputDir'
const assOutputDir = ref(localStorage.getItem(ASS_OUTDIR_KEY) || '')
watch(assOutputDir, (v) => {
  try { localStorage.setItem(ASS_OUTDIR_KEY, v) } catch { /* ignore */ }
})

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

// --- 并行任务模式（宿主 ≥5.5.0：每个任务独占一个引擎进程，可同时打轴/压制多个视频） ---
const PARALLEL_KEY = 'autotiming:parallel'
const parallelEnabled = ref(localStorage.getItem(PARALLEL_KEY) === '1')
watch(parallelEnabled, (v) => { try { localStorage.setItem(PARALLEL_KEY, v ? '1' : '0') } catch { /* ignore */ } })
const hostNoTasks = ref(false) // /engine/tasks 404：宿主还没升到 5.5.0，隐藏并行 UI

type TaskSnap = {
  taskId: string; status: string; percent: number; error?: string
  videoPath?: string; scriptPath?: string; exportAssPath?: string
  matchedDialog?: number; dialogTotal?: number
  sourceVideo?: string; outputPath?: string
}
const timingTasks = ref<TaskSnap[]>([])
const suppressTasks = ref<TaskSnap[]>([])
let tasksTimer: any = null
let tasksAdopted = false // 首次快照时把后端仍存活的任务找回（插件重载/页面重建后）
let pageActive = false
let lifecycleGeneration = 0
let engineStatusGeneration = 0
let encoderProbeGeneration = 0
let timingStartGeneration = 0
let suppressStartGeneration = 0
let timingActivationGeneration = 0
let suppressActivationGeneration = 0

function baseName(p?: string) {
  return (p || '').split(/[\\/]/).pop() || ''
}
function taskStatusLabel(t: TaskSnap) {
  if (t.status === 'running') return (t.percent || 0).toFixed(0) + '%'
  if (t.status === 'done') return '完成'
  if (t.status === 'error') return '失败'
  if (t.status === 'canceled') return '已取消'
  return t.status
}
// 后台任务终态 toast：并行模式下没被「当前查看」的任务完成/失败时也要有感知，
// 否则用户只能盯着列表里 2 秒才刷一次的百分比猜。首次快照只做基线（插件重挂载
// 时不为历史终态补弹）；当前查看的任务由 pollSuppress/pollTiming 的精确 toast 负责。
const lastTaskStatuses = new Map<string, string>()
let taskStatusesPrimed = false
function noteTaskTransitions(tasks: TaskSnap[], kind: 'timing' | 'suppress') {
  for (const t of tasks) {
    const key = kind + ':' + t.taskId
    const prev = lastTaskStatuses.get(key)
    lastTaskStatuses.set(key, t.status)
    if (!taskStatusesPrimed || prev === t.status || t.status === 'running') continue
    const viewedId = kind === 'suppress' ? suppressTaskId.value : timingTaskId.value
    if (t.taskId === viewedId) continue
    const name = baseName(kind === 'suppress' ? t.outputPath || t.sourceVideo : t.videoPath) || t.taskId
    const label = kind === 'suppress' ? '压制' : '打轴'
    if (t.status === 'done') toast(`「${name}」${label}完成`, 'success')
    else if (t.status === 'error') toast(`「${name}」${label}失败: ` + (t.error || ''), 'error', 8000)
  }
}
async function pollTasks() {
  const generation = lifecycleGeneration
  try {
    const r = await api('/engine/tasks')
    if (!pageActive || generation !== lifecycleGeneration) return
    timingTasks.value = r.timing || []
    suppressTasks.value = r.suppress || []
    noteTaskTransitions(timingTasks.value, 'timing')
    noteTaskTransitions(suppressTasks.value, 'suppress')
    taskStatusesPrimed = true
    hostNoTasks.value = false
    if (!tasksAdopted) {
      tasksAdopted = true
      // 找回后端仍存活的任务：打轴恢复最近一个；压制只恢复还在跑的
      if (!timingTaskId.value && timingTasks.value.length) {
        void activateTimingTask(timingTasks.value[timingTasks.value.length - 1].taskId)
      }
      if (!suppressTaskId.value) {
        const running = suppressTasks.value.filter((t) => t.status === 'running')
        if (running.length) void activateSuppressTask(running[running.length - 1].taskId)
      }
    }
  } catch (e: any) {
    if (!pageActive || generation !== lifecycleGeneration) return
    if (e && e.status === 404) {
      hostNoTasks.value = true
      if (tasksTimer) { clearInterval(tasksTimer); tasksTimer = null }
    }
  }
}
function startTasksPoll() {
  if (!pageActive || tasksTimer || hostNoTasks.value) return
  tasksTimer = setInterval(pollTasks, 2000)
  void pollTasks()
}
async function cancelTask(id: string) {
  try { await post('/engine/cancel?domain=timing&task=' + id) } catch { /* ignore */ }
  void pollTasks()
}
async function closeTask(id: string) {
  try { await post('/engine/timing/close?task=' + id) } catch { /* ignore */ }
  if (id === timingTaskId.value) {
    // 关闭的是当前查看的任务：清空右列详情
    timingActivationGeneration++
    stopTimingPolls()
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
    timingTaskId.value = ''
    timingStatus.value = ''
    lines.value = []; linesFps.value = 0; expandedKey.value = ''; showTooLongOnly.value = false; showSeparatorReviewOnly.value = false; previewB64.value = ''
    exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null; resetSyncPullGuard()
  }
  void pollTasks()
}
// 切换「当前查看」的打轴任务：右列行列表/导出/同步全部跟着走。
// 直接读 /progress 填充状态（不走 pollTiming，免得切到终态任务时误弹完成/失败 toast）。
async function activateTimingTask(id: string) {
  if (!id || timingTaskId.value === id) return
  const activation = ++timingActivationGeneration
  const lifecycle = lifecycleGeneration
  const isCurrentActivation = () => pageActive && lifecycle === lifecycleGeneration
    && activation === timingActivationGeneration && timingTaskId.value === id
  stopTimingPolls()
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  const snap = timingTasks.value.find((t) => t.taskId === id)
  timingDoneHandled = !!snap && snap.status !== 'running' // 终态任务不再补完成 toast
  timingTaskId.value = id
  timingPercent.value = 0; previewB64.value = ''
  lines.value = []; linesFps.value = 0; expandedKey.value = ''; showTooLongOnly.value = false; showSeparatorReviewOnly.value = false
  exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null; resetSyncPullGuard()
  const p = await api('/engine/timing/progress?task=' + id).catch(() => null)
  // 等待响应期间切换任务、离开页面或启动了新任务：旧响应不得重挂轮询。
  if (!isCurrentActivation()) return
  if (!p) { timingStatus.value = snap?.status || ''; return }
  timingStatus.value = p.status
  timingPercent.value = p.percent || 0
  timingFps.value = p.fps || 0; timingEta.value = p.eta || ''
  dialogTotal.value = p.dialogTotal || 0; bannerTotal.value = p.bannerTotal || 0; markerTotal.value = p.markerTotal || 0
  matchedDialog.value = p.matchedDialog || 0; matchedBanner.value = p.matchedBanner || 0; matchedMarker.value = p.matchedMarker || 0
  if (p.status === 'running') {
    timingDoneHandled = false
    stopTimingPolls()
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
    if (!hostTooOld.value) linesTimer = setInterval(loadLines, 2000)
  } else if (p.status === 'done') {
    await loadLines()
    if (!isCurrentActivation()) return
    // 恢复导出/同步状态（导出过的任务重新挂上自动回读）
    try {
      const s = await api('/engine/timing/sync/status?task=' + id)
      if (!isCurrentActivation()) return
      if (s.exported) {
        exportedAss.value = s.assPath
        syncStatus.value = s
        if (!sourceVideo.value) sourceVideo.value = snap?.videoPath || ''
        if (!sourceSubtitle.value) sourceSubtitle.value = s.assPath
        startSyncPoll()
      }
    } catch { /* 老宿主/暂态失败：忽略 */ }
  }
}
async function activateSuppressTask(id: string) {
  if (!id || suppressTaskId.value === id) return
  const activation = ++suppressActivationGeneration
  const lifecycle = lifecycleGeneration
  const isCurrentActivation = () => pageActive && lifecycle === lifecycleGeneration
    && activation === suppressActivationGeneration && suppressTaskId.value === id
  resetSuppress(false)
  suppressTaskId.value = id
  const snap = suppressTasks.value.find((t) => t.taskId === id)
  if (snap?.sourceVideo) sourceVideo.value = snap.sourceVideo
  if (snap?.outputPath) {
    outputPath.value = snap.outputPath
    outputPathManual.value = snap.outputPath !== defaultOutput()
    lastDerivedOutput = defaultOutput()
  }
  if (snap && snap.status !== 'running') {
    // 终态任务：直接用快照填充，不走 pollSuppress（免得误弹完成/失败 toast）
    suppressStatus.value = snap.status
    suppressPercent.value = snap.percent || 0
    suppressLog.value = snap.error || ''
    if (suppressLogOpen.value) void fetchSuppressLog()
    return
  }
  await pollSuppress()
  // 等待响应期间切换任务或离开页面：丢弃，别给旧任务重挂轮询/抓日志。
  if (!isCurrentActivation()) return
  if (suppressStatus.value === 'running') {
    stopSuppressPoll()
    suppressTimer = setInterval(pollSuppress, 500)
  }
  if (suppressLogOpen.value) void fetchSuppressLog()
  syncSuppressLogTimer()
}

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
let timingTimer: any = null
let previewTimer: any = null
let linesTimer: any = null
let timingDoneHandled = false

// --- 行列表（右列） ---
const lines = ref<EngineLine[]>([])
const linesFps = ref(0)
const expandedKey = ref('')
const showTooLongOnly = ref(false)
const showSeparatorReviewOnly = ref(false)

const dialogLines = computed(() => lines.value.filter((l) => l.type === 'dialog'))
const tooLongCount = computed(() => dialogLines.value.filter((l) => l.needSetSeparator).length)
const separatorReviewLines = computed(() => dialogLines.value.filter(
  (l) => (l.body.match(/\n/g)?.length ?? 0) >= 2,
))
const visibleLines = computed(() => {
  if (showSeparatorReviewOnly.value) return separatorReviewLines.value
  if (showTooLongOnly.value) return dialogLines.value.filter((l) => l.needSetSeparator)
  return lines.value
})
watch(showTooLongOnly, (enabled) => {
  if (enabled) showSeparatorReviewOnly.value = false
})
watch(showSeparatorReviewOnly, (enabled) => {
  if (enabled) showTooLongOnly.value = false
})
function lineKey(l: EngineLine) {
  return l.type + ':' + l.index
}
function toggleExpand(l: EngineLine) {
  expandedKey.value = expandedKey.value === lineKey(l) ? '' : lineKey(l)
}
function openSeparatorReview() {
  const first = separatorReviewLines.value[0]
  if (!first) {
    toast('当前任务没有需要三行分句复查的对话', 'info')
    return
  }
  showSeparatorReviewOnly.value = true
  expandedKey.value = lineKey(first)
}

async function loadLines() {
  const id = timingTaskId.value
  if (!id) return
  try {
    const p: LinesPayload = await api('/engine/timing/lines?task=' + id)
    // 等待响应期间切换了查看的任务：丢弃，防止旧任务的行数据盖到新任务视图上
    if (timingTaskId.value !== id) return
    linesFps.value = p.fps || 0
    lines.value = (p.lines || []).slice().sort((a, b) => a.startIndex - b.startIndex)
    hostTooOld.value = false
  } catch (e: any) {
    if (timingTaskId.value !== id) return
    // 进度端点正常而行列表 404 = 后端没有该路由（app 版本太旧）
    if (e && e.status === 404 && (timingStatus.value === 'running' || timingStatus.value === 'done')) {
      hostTooOld.value = true
      if (linesTimer) { clearInterval(linesTimer); linesTimer = null }
    }
  }
}

function onLineUpdated(nl: EngineLine) {
  const i = lines.value.findIndex((l) => l.type === nl.type && l.index === nl.index)
  if (i >= 0) lines.value[i] = { ...lines.value[i], ...nl }
  // st:N 双向同步目前只覆盖 dialog；banner 保存后进入 autosave/重新导出，
  // 不可拿它的独立 index 去污染同编号 dialog 的待推送状态。
  if (nl.type === 'dialog' && exportedAss.value && syncStatus.value) {
    const d: number[] = syncStatus.value.dirtyLines || []
    if (!d.includes(nl.index)) syncStatus.value.dirtyLines = [...d, nl.index]
  }
  scheduleAutosave()
}

// --- 逐行微调即落盘（autosave.ass 保险文件）---
// 每次分句/译文改动落到引擎后，防抖把当前完整字幕（同导出口径后处理）写到输出
// 目录的 autosave.ass——后端专用端点，不碰正式导出与 Aegisub 同步基线；崩溃/
// 误退后打开 autosave.ass 即可拿回全部微调。
let autosaveTimer: any = null
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  const id = timingTaskId.value
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null
    // 防抖窗口内切了任务：这条微调属于旧任务，放弃，别落进新任务的恢复文件
    if (timingTaskId.value !== id || timingStatus.value !== 'done' || !id) return
    try {
      await post('/engine/timing/autosave?task=' + id, {
        outputDir: assOutputDir.value,
        clean: cleanExport.value,
        syncTags: exportSyncTags.value,
        speakerColor: speakerColorExport.value,
        styleTemplate: styleTemplate.value,
        styleTemplateContent: styleTemplate.value ? '' : BUILTIN_STYLE_TEMPLATE,
      })
    } catch { /* 保险动作静默失败；老版宿主没有该端点（404）也不打扰 */ }
  }, 1500)
}

// --- 导出与 Aegisub 同步 ---
const CLEAN_KEY = 'autotiming:cleanExport'
const SYNC_KEY = 'autotiming:syncTags'
const SPEAKER_COLOR_KEY = 'autotiming:speakerColor'
const TMPL_KEY = 'autotiming:styleTemplate'
const AEGISUB_DIR_KEY = 'autotiming:aegisubDir'
const cleanExport = ref(localStorage.getItem(CLEAN_KEY) !== '0')
const exportSyncTags = ref(localStorage.getItem(SYNC_KEY) !== '0')
const speakerColorExport = ref(localStorage.getItem(SPEAKER_COLOR_KEY) === '1')
const styleTemplate = ref(localStorage.getItem(TMPL_KEY) || '')
// Aegisub automation/autoload 目录：便携版/自定义安装位置自动探测不到，手动指一次
const aegisubDir = ref(localStorage.getItem(AEGISUB_DIR_KEY) || '')
watch(cleanExport, (v) => { try { localStorage.setItem(CLEAN_KEY, v ? '1' : '0') } catch { /* ignore */ } })
watch(exportSyncTags, (v) => { try { localStorage.setItem(SYNC_KEY, v ? '1' : '0') } catch { /* ignore */ } })
watch(speakerColorExport, (v) => { try { localStorage.setItem(SPEAKER_COLOR_KEY, v ? '1' : '0') } catch { /* ignore */ } })
watch(styleTemplate, (v) => { try { localStorage.setItem(TMPL_KEY, v) } catch { /* ignore */ } })
watch(aegisubDir, (v) => { try { localStorage.setItem(AEGISUB_DIR_KEY, v) } catch { /* ignore */ } })
const showExportOpts = ref(false)

// --- staff 制作人员行（逐项启用；未勾选不输出，勾选空值输出职位默认项） ---
const STAFF_KEY = 'autotiming:staffInfo'
type StaffFieldKey = 'group' | 'episode' | 'title' | 'recorder' | 'translator' | 'proofread' | 'timer' | 'checker' | 'suppressor'
const STAFF_FIELDS: StaffFieldKey[] = ['group', 'episode', 'title', 'recorder', 'translator', 'proofread', 'timer', 'checker', 'suppressor']
const STAFF_UI_FIELDS: { key: StaffFieldKey; label: string; placeholder: string }[] = [
  { key: 'group', label: '制作组抬头', placeholder: '例如：PJS字幕组' },
  { key: 'episode', label: '话数', placeholder: '例如：第一话' },
  { key: 'title', label: '内容标题', placeholder: '例如：六周年' },
  { key: 'recorder', label: '录制', placeholder: '例如：八成是茶币币' },
  { key: 'translator', label: '翻译', placeholder: '例如：组员A' },
  { key: 'proofread', label: '校对', placeholder: '例如：组员B' },
  { key: 'timer', label: '时轴', placeholder: '例如：组员C' },
  { key: 'checker', label: '轴校', placeholder: '例如：组员D' },
  { key: 'suppressor', label: '压制', placeholder: '例如：组员E' },
]
interface StaffInfo {
  group: string; episode: string; title: string; recorder: string
  translator: string; proofread: string; timer: string; checker: string; suppressor: string
  enabled: Record<StaffFieldKey, boolean>
}
function emptyStaff(): StaffInfo {
  return {
    group: '', episode: '', title: '', recorder: '', translator: '', proofread: '', timer: '', checker: '', suppressor: '',
    enabled: Object.fromEntries(STAFF_FIELDS.map((key) => [key, false])) as Record<StaffFieldKey, boolean>,
  }
}
function normalizeStaff(raw: any): StaffInfo {
  const base = emptyStaff()
  const hasEnabledMap = !!raw?.enabled && typeof raw.enabled === 'object'
  for (const key of STAFF_FIELDS) {
    if (key === 'checker' && !hasEnabledMap && typeof raw?.suppressor === 'string') {
      base.checker = raw.suppressor
    } else if (typeof raw?.[key] === 'string') {
      base[key] = raw[key]
    }
    base.enabled[key] = hasEnabledMap
      ? raw.enabled[key] === true
      : base[key].trim() !== ''
  }
  // Legacy suppressor meant the combined “轴校&压制” role. Preserve its value
  // by enabling both new independent fields during one-time localStorage migration.
  if (!hasEnabledMap && typeof raw?.suppressor === 'string' && raw.suppressor.trim()) {
    base.checker = raw.suppressor
    base.enabled.checker = true
    base.enabled.suppressor = true
  }
  return base
}
function cloneStaff(value: StaffInfo): StaffInfo {
  return { ...value, enabled: { ...value.enabled } }
}
function loadStaff(): StaffInfo {
  try { return normalizeStaff(JSON.parse(localStorage.getItem(STAFF_KEY) || '{}')) } catch { return emptyStaff() }
}
const staff = ref<StaffInfo>(loadStaff())
watch(staff, (v) => { try { localStorage.setItem(STAFF_KEY, JSON.stringify(v)) } catch { /* ignore */ } }, { deep: true })
// Always send the explicit enabled map. The built-in team template contains an
// example staff Dialogue, so an all-unchecked payload must still tell the host
// to remove that template row and inject nothing.
const staffPayload = computed(() => cloneStaff(staff.value))

// --- 命名预设（识别阈值 / staff 各一组，本地持久化） ---
interface Preset<T> { name: string; data: T }
function loadPresetList<T>(key: string): Preset<T>[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string' && p.data) : []
  } catch { return [] }
}
function usePresets<T extends object>(key: string, snapshot: () => T, apply: (data: T) => void) {
  // shallowRef：泛型 T 会被 ref 的深层 UnwrapRef 搅乱类型，列表只做整体替换用浅响应即可
  const list = shallowRef<Preset<T>[]>(loadPresetList<T>(key))
  const sel = ref('')
  const nameInput = ref('')
  function persist() { try { localStorage.setItem(key, JSON.stringify(list.value)) } catch { /* ignore */ } }
  function save() {
    // 未填新名字时覆盖当前选中的预设
    const name = nameInput.value.trim() || sel.value
    if (!name) { toast('先给预设起个名字', 'warn'); return }
    list.value = [...list.value.filter((p) => p.name !== name), { name, data: snapshot() }]
    persist()
    sel.value = name
    nameInput.value = ''
    toast(`预设「${name}」已保存`, 'success')
  }
  function applySel() {
    const p = list.value.find((x) => x.name === sel.value)
    if (p) apply(p.data)
  }
  function remove() {
    if (!sel.value) return
    list.value = list.value.filter((p) => p.name !== sel.value)
    persist()
    sel.value = ''
  }
  return { list, sel, nameInput, save, applySel, remove }
}
const thPresets = usePresets<typeof THRESHOLD_DEFAULTS>(
  'autotiming:thresholdPresets',
  () => ({ ...thresholdPayload() }) as typeof THRESHOLD_DEFAULTS,
  (d) => { threshold.value = { ...THRESHOLD_DEFAULTS, ...d } },
)
const stPresets = usePresets<StaffInfo>(
  'autotiming:staffPresets',
  () => cloneStaff(staff.value),
  (d) => { staff.value = normalizeStaff(d) },
)

async function browseAegisubDir() {
  try {
    const p = await pickFile({ multiple: false, directory: true })
    if (typeof p === 'string' && p) aegisubDir.value = p
  } catch {
    toast('当前环境不支持目录选择，请手动填写路径', 'warn')
  }
}
const installingMacro = ref(false)
async function installAegisubMacro() {
  if (installingMacro.value) return
  installingMacro.value = true
  try {
    const r = await post('/engine/aegisub/install', { dir: aegisubDir.value })
    aegisubMacroPath.value = r.installed
    toast('同步宏已安装: ' + r.installed + '（重启 Aegisub 生效）', 'success', 7000)
  } catch (e: any) {
    if (e && e.status === 404 && !e.message?.includes('Aegisub')) {
      toast('手动安装同步宏需要 SekaiText ≥ 5.5.0，请先升级主程序', 'warn')
    } else {
      toast('安装同步宏失败: ' + e.message, 'error')
    }
  } finally {
    installingMacro.value = false
  }
}

const exporting = ref(false)
const exportedAss = ref('')
const syncScriptPath = ref('')
const aegisubMacroPath = ref('') // 宏被自动装进本机 Aegisub autoload 的路径（空=没装 Aegisub）
const syncStatus = ref<any>(null)
const pulling = ref(false)
const syncPullBlocked = ref(false)
const syncPullBlockedReason = ref('')
let syncTimer: any = null
let syncPullFailureHash = ''
let syncPullRetryAt = 0
let syncPullFailureCount = 0
let syncPullBlockedHash = ''
const dirtyCount = computed(() => (syncStatus.value?.dirtyLines?.length as number) || 0)

async function exportAss() {
  if (timingStatus.value !== 'done' || exporting.value) return
  exporting.value = true
  const id = timingTaskId.value
  try {
    // Aegisub 侧有未回读的保存时先拉取，导出才不会覆盖人家的精调。
    // 已确认缺少本任务同步身份的文件无法安全回读，只能由本次重新导出重建标识。
    if (syncStatus.value?.changedOnDisk && !syncPullBlocked.value) await pullFromAegisub(true)
    const r = await post('/engine/timing/export?task=' + id, {
      outputDir: assOutputDir.value,
      clean: cleanExport.value,
      syncTags: exportSyncTags.value,
      speakerColor: speakerColorExport.value,
      styleTemplate: styleTemplate.value,
      // 未指定自定义模板时用内置团队模板（路径优先于内容，后端同口径）
      styleTemplateContent: styleTemplate.value ? '' : BUILTIN_STYLE_TEMPLATE,
      aegisubDir: aegisubDir.value, // 用户指定的 autoload 目录（便携版探测不到时）
      staff: staffPayload.value, // 始终携带勾选映射；全未勾选时删除模板示例且不注入新行
    })
    // 等待导出响应期间切换了查看的任务：丢弃，别把本任务字幕写成新任务的压制输入
    if (timingTaskId.value !== id) return
    exportedAss.value = r.assPath
    syncScriptPath.value = r.syncScript || ''
    aegisubMacroPath.value = r.aegisubMacro || ''
    for (const wmsg of r.warnings || []) toast(wmsg, 'warn', 7000)
    // 一条龙：自动填充压制段
    if (!sourceVideo.value) sourceVideo.value = videoPath.value
    sourceSubtitle.value = r.assPath
    refreshDerivedOutput()
    toast('字幕已导出: ' + r.assPath, 'success')
    startSyncPoll()
  } catch (e: any) {
    toast('导出字幕失败: ' + e.message, 'error')
  } finally {
    exporting.value = false
  }
}

function observedSyncHash(status = syncStatus.value) {
  return status?.contentHash
    || status?.baselineHash
    || `${status?.assPath || exportedAss.value}:${status?.revision ?? ''}`
}
function resetSyncPullGuard() {
  syncPullFailureHash = ''
  syncPullRetryAt = 0
  syncPullFailureCount = 0
  syncPullBlocked.value = false
  syncPullBlockedReason.value = ''
  syncPullBlockedHash = ''
}
function startSyncPoll() {
  if (syncTimer) clearInterval(syncTimer)
  resetSyncPullGuard()
  syncTimer = setInterval(pollSync, 3000)
  pollSync()
}
function deferSyncPullRetry(contentHash = '') {
  syncPullFailureHash = contentHash
  syncPullFailureCount++
  syncPullRetryAt = Date.now() + Math.min(60_000, 3_000 * (2 ** Math.min(syncPullFailureCount, 4)))
}
function blockSyncPull(contentHash: string, reason: string) {
  syncPullBlocked.value = true
  syncPullBlockedReason.value = reason
  syncPullBlockedHash = contentHash
  syncPullFailureHash = contentHash
  syncPullRetryAt = Number.POSITIVE_INFINITY
}

async function pollSync() {
  const id = timingTaskId.value
  if (!exportedAss.value || !id) return
  try {
    const s = await api('/engine/timing/sync/status?task=' + id)
    // 等待响应期间切换了查看的任务：丢弃，防止旧任务 sync 状态盖到新任务、
    // 并对新任务多触发一次 pullFromAegisub
    if (timingTaskId.value !== id) return
    syncStatus.value = s
    const contentHash = observedSyncHash(s)
    if (syncPullBlocked.value) {
      // A 409 is bound to the exact bytes we inspected. Aegisub may have been in
      // the middle of saving, so a later hash change re-enables one safe attempt;
      // unchanged invalid bytes stay blocked until re-export or task switch.
      if (contentHash === syncPullBlockedHash) return
      resetSyncPullGuard()
    } else if (contentHash !== syncPullFailureHash) {
      syncPullFailureHash = ''
      syncPullRetryAt = 0
      syncPullFailureCount = 0
    }
    // 自动轮询必须静默且带退避。文件暂时被 Aegisub/压制流程占用或内容无法完整
    // 映射时，不再每三秒弹一条不影响功能的错误；手动按钮仍会显示具体原因。
    if (s.changedOnDisk && !pulling.value && Date.now() >= syncPullRetryAt) {
      await pullFromAegisub(true, contentHash)
    }
  } catch { /* transient */ }
}
async function pullFromAegisub(silent = false, observedHash = '') {
  if (pulling.value) return
  pulling.value = true
  try {
    const r = await post('/engine/timing/sync/pull?task=' + timingTaskId.value)
    const text = r.textApplied || 0
    if (r.applied > 0 || text > 0) {
      await loadLines()
      if (!silent) {
        const parts = []
        if (text > 0) parts.push(`${text} 处译文`)
        if (r.applied > 0) parts.push(`${r.applied} 处换行时间`)
        toast('已从 Aegisub 回读 ' + parts.join('、'), 'success')
      }
    } else if (!silent && r.complete !== false) {
      toast('已检查 Aegisub 文件，没有需要回读的改动', 'info')
    }
    if (r.complete === false) {
      deferSyncPullRetry(observedHash || syncStatus.value?.contentHash || '')
      if (!silent) {
        const count = (r.skipped?.length || 0) + (r.conflicts?.length || 0)
        toast(`Aegisub 改动仅部分可回读${count ? `（${count} 项待处理）` : ''}，已保留磁盘改动`, 'warn', 7000)
      }
      return
    }
    resetSyncPullGuard()
    if (syncStatus.value) syncStatus.value.changedOnDisk = false
  } catch (e: any) {
    const contentHash = observedHash || observedSyncHash()
    if (e?.status === 409) {
      const reason = '当前 ASS 缺少本任务的有效同步标识，请重新导出 ASS 后再回读'
      blockSyncPull(contentHash, reason)
      // Automatic polling is silent. A manual pull gets one actionable warning,
      // then the disabled button + inline reason prevent repeated popups.
      if (!silent) toast(reason, 'warn', 7000)
    } else {
      deferSyncPullRetry(contentHash)
      if (!silent) toast('回读 Aegisub 改动失败: ' + e.message, 'error')
    }
  } finally {
    pulling.value = false
  }
}
async function pushToAegisub() {
  try {
    const r = await post('/engine/timing/sync/push?task=' + timingTaskId.value)
    toast(`已写同步文件（${r.groups} 组）——在 Aegisub 运行「自动化 → SekaiText → 从轴机拉取」即可应用`, 'success', 8000)
    pollSync()
  } catch (e: any) {
    toast('推送失败: ' + e.message, 'error')
  }
}

// --- suppress inputs / state ---
const sourceVideo = ref('')
const sourceSubtitle = ref('')
const outputPath = ref('')
const outputPathManual = ref(false)
let lastDerivedOutput = ''
// 编码器：上次手选的优先，否则按平台给个必然能跑的默认（此前写死 HevcVideoToolbox，
// Windows 上 "Unknown encoder" 压制 100% 起不来）。宿主 ≥5.7.3 时 probeEncoders 会
// 拿到按显卡逐个试编码验证过的列表 + 推荐项，自动精确化。
const ENCODER_KEY = 'autotiming:encoder'
const encoder = ref(localStorage.getItem(ENCODER_KEY) || FALLBACK_DEFAULT_ENCODER)
watch(encoder, (v) => { try { localStorage.setItem(ENCODER_KEY, v) } catch { /* ignore */ } })
const encoderOptions = ref<string[]>([...FALLBACK_ENCODERS])
const recommendedEncoder = ref('')
// 内核 ≥2.3.6 附带：未通过试编码的硬件编码器 → 原因摘要（RTX 机器上 NVENC
// 消失这类"该在却不在"直接给病因），以及字体子系统体检结果（字体缓存损坏的
// 机器压制会无声挂起，提前在面板上亮警告）。老内核没这些字段 → 界面不变。
const encoderFailures = ref<Record<string, string>>({})
const fontCheckWarn = ref('')
const failedEncoderText = computed(() =>
  Object.entries(encoderFailures.value)
    .map(([name, reason]) => `${encoderLabel(name)}：${reason}`)
    .join('\n'),
)
let encodersProbed = false
async function probeEncoders() {
  if (encodersProbed) return
  const request = ++encoderProbeGeneration
  const lifecycle = lifecycleGeneration
  const isCurrentProbe = () => pageActive && lifecycle === lifecycleGeneration
    && request === encoderProbeGeneration
  try {
    const p = await api('/engine/suppress/probe')
    if (!isCurrentProbe()) return
    if (!Array.isArray(p.encoders) || !p.encoders.length) return // 老内核（<2.1.0）没这字段，维持兜底
    encodersProbed = true
    encoderOptions.value = p.encoders
    recommendedEncoder.value = p.recommended || ''
    encoderFailures.value = p.encoderFailures && typeof p.encoderFailures === 'object' ? p.encoderFailures : {}
    const fc = p.fontCheck
    fontCheckWarn.value = fc && (fc.status === 'slow' || fc.status === 'hung') ? String(fc.message || '') : ''
    // 当前选择（含历史持久化值，比如换过机器/显卡）不在本机可用列表 → 换成推荐项
    if (!p.encoders.includes(encoder.value)) {
      encoder.value = p.recommended && p.encoders.includes(p.recommended) ? p.recommended : p.encoders[0]
    }
  } catch { /* 老宿主 404 / 引擎忙：维持兜底列表，下次进入页面再试 */ }
}
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
// 主进度区显示的是哪个任务：并行模式下不标名字的话，切换/新建任务时进度条
// "凭空跳变"，正是「进度无法正确显示」观感的一大来源
const suppressViewedName = computed(() => {
  const t = suppressTasks.value.find((x) => x.taskId === suppressTaskId.value)
  return baseName(t?.outputPath || t?.sourceVideo || outputPath.value || sourceVideo.value)
})

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

// Directory picker for the custom .ass output dir (host Tauri dialog → absolute path).
async function browseAssDir() {
  try {
    const p = await pickFile({ multiple: false, directory: true })
    if (typeof p === 'string' && p) assOutputDir.value = p
  } catch {
    toast('当前环境不支持目录选择，请手动填写路径', 'warn')
  }
}

async function refreshEngineStatus() {
  const request = ++engineStatusGeneration
  const lifecycle = lifecycleGeneration
  const isCurrentStatus = () => pageActive && lifecycle === lifecycleGeneration
    && request === engineStatusGeneration
  try {
    const s = await api('/engine/status')
    if (!isCurrentStatus()) return
    engineAvailable.value = !!s.available
    engineReady.value = !!s.ready
    engineError.value = s.error || ''
    engineVersion.value = s.engine ? s.engine.name + ' v' + s.engine.version : ''
    // 内核在位就探测本机可用编码器（结果后端缓存，只有首次真的跑试编码）
    if (engineAvailable.value) void probeEncoders()
  } catch (e: any) {
    if (!isCurrentStatus()) return
    engineAvailable.value = false
    engineReady.value = false
    engineError.value = (e && e.message) || ''
  } finally {
    if (isCurrentStatus()) statusChecked.value = true
  }
}
onMounted(() => {
  pageActive = true
  refreshEngineStatus()
  startTasksPoll() // 任务快照：并行任务列表 + 页面重建后找回后端仍存活的任务
})

onUnmounted(() => clearAllTimers())
// The host wraps plugin routes in <keep-alive>, so navigating back to the editor
// DEACTIVATES (does not unmount) this page — stop polling while hidden, and
// resume if a run is still in flight when we return.
onDeactivated(() => clearAllTimers())
onActivated(() => {
  pageActive = true
  // Re-probe engine readiness on return: this page is kept-alive so onMounted won't
  // re-run; without this a transient first-probe failure left the buttons stuck disabled.
  refreshEngineStatus()
  startTasksPoll()
  if (timingTaskId.value && timingStatus.value === 'running' && !timingTimer) {
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
    if (!hostTooOld.value) linesTimer = setInterval(loadLines, 2000)
  }
  if (exportedAss.value && !syncTimer) startSyncPoll()
  if (suppressTaskId.value && suppressStatus.value === 'running' && !suppressTimer) {
    suppressTimer = setInterval(pollSuppress, 500)
  }
  syncSuppressLogTimer()
})
function clearAllTimers() {
  pageActive = false
  lifecycleGeneration++
  engineStatusGeneration++
  encoderProbeGeneration++
  timingStartGeneration++
  suppressStartGeneration++
  timingActivationGeneration++
  suppressActivationGeneration++
  timingPoll.invalidate()
  suppressPoll.invalidate()
  for (const t of [timingTimer, previewTimer, linesTimer, suppressTimer, syncTimer, tasksTimer, suppressLogTimer]) if (t) clearInterval(t)
  timingTimer = previewTimer = linesTimer = suppressTimer = syncTimer = tasksTimer = suppressLogTimer = null
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
}

function defaultOutput() {
  const v = sourceVideo.value || videoPath.value
  if (!v) return ''
  const slash = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'))
  const dot = v.lastIndexOf('.')
  const stemEnd = dot > slash + 1 ? dot : v.length
  return v.slice(0, stemEnd) + '_subbed.mp4'
}

function refreshDerivedOutput() {
  const derived = defaultOutput()
  if (!outputPathManual.value || !outputPath.value || outputPath.value === lastDerivedOutput) {
    outputPath.value = derived
    outputPathManual.value = false
  }
  lastDerivedOutput = derived
}

const outputPathModel = computed({
  get: () => outputPath.value,
  set: (value: string) => {
    outputPath.value = value
    outputPathManual.value = value.trim() !== '' && value !== defaultOutput()
  },
})

watch([sourceVideo, videoPath], refreshDerivedOutput, { immediate: true })

// --- 打轴 ---
async function startTiming() {
  if (!videoPath.value || !scriptPath.value) { toast('请先填写视频和剧本 JSON 路径', 'warn'); return }
  const parallel = parallelEnabled.value && !hostNoTasks.value
  if (timingRunning.value && !parallel) return
  const startGeneration = ++timingStartGeneration
  const lifecycle = lifecycleGeneration
  resetTiming(parallel)    // also clears any leftover poll timers (see resetTiming)
  timingStatus.value = 'running' // disable button synchronously before awaiting
  try {
    const r = await post('/engine/timing/start', {
      videoPath: videoPath.value,
      scriptPath: scriptPath.value,
      translatePath: translatePath.value,
      // Always a full object of finite numbers so the engine's threshold parser
      // never sees a scalar or an empty-string (cleared field) value.
      threshold: thresholdPayload(),
      parallel,
    })
    if (!pageActive || lifecycle !== lifecycleGeneration
        || startGeneration !== timingStartGeneration) return
    ++timingActivationGeneration
    stopTimingPolls()
    timingTaskId.value = r.taskId
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
    linesTimer = setInterval(loadLines, 2000)
    void pollTasks()
  } catch (e: any) {
    if (!pageActive || lifecycle !== lifecycleGeneration
        || startGeneration !== timingStartGeneration) return
    timingStatus.value = '' // re-enable button so the user can retry
    toast('启动打轴失败: ' + e.message, 'error')
  }
}
function resetTiming(keepSuppressInputs = false) {
  timingActivationGeneration++
  stopTimingPolls()
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  timingDoneHandled = false
  timingPercent.value = 0; timingFps.value = 0; timingEta.value = ''
  dialogTotal.value = 0; bannerTotal.value = 0; markerTotal.value = 0
  matchedDialog.value = 0; matchedBanner.value = 0; matchedMarker.value = 0
  previewB64.value = ''
  lines.value = []; linesFps.value = 0; expandedKey.value = ''; showTooLongOnly.value = false; showSeparatorReviewOnly.value = false
  exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null; resetSyncPullGuard()
  // Clear suppress carry-over inputs so a new timing run never leaves the 压制 section
  // pointing at the PREVIOUS video's source/subtitle/output (export repopulates them;
  // on failure they stay empty instead of stale). 并行模式不清：老任务导出的字幕
  // 正在/等着压制是常态，不能被新打轴顺手抹掉。
  if (!keepSuppressInputs) {
    outputPathManual.value = false
    lastDerivedOutput = ''
    sourceVideo.value = ''; sourceSubtitle.value = ''; outputPath.value = ''
  }
}
function stopTimingPolls() {
  timingPoll.invalidate()
  if (timingTimer) clearInterval(timingTimer)
  if (previewTimer) clearInterval(previewTimer)
  if (linesTimer) clearInterval(linesTimer)
  timingTimer = previewTimer = linesTimer = null
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
}
const timingPoll = createSingleFlightPoll(async ({ isCurrent }) => {
  const id = timingTaskId.value
  if (!id) return
  try {
    const p = await api('/engine/timing/progress?task=' + id)
    // 同一任务每次只允许一个进度请求在途；切换/停止会失效旧代次，防止较早的
    // running 响应在较新的 done/error 之后回写，把终态覆盖回运行中。
    if (!isCurrent() || timingTaskId.value !== id) return
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
    if (p.status === 'done') void onTimingDone()
    else if (p.status === 'error') { stopTimingPolls(); toast('打轴失败: ' + (p.error || ''), 'error') }
    else if (p.status === 'canceled') { stopTimingPolls() }
  } catch { /* transient; keep polling */ }
})
function pollTiming() {
  return timingPoll.run()
}
async function pollPreview() {
  const id = timingTaskId.value
  if (!id) return
  try {
    const p = await api('/engine/timing/preview?task=' + id)
    if (timingTaskId.value !== id) return
    if (p.base64) previewB64.value = p.base64
  } catch { /* ignore */ }
}
async function onTimingDone() {
  if (timingDoneHandled) return // guard against overlapping polls firing this twice
  const id = timingTaskId.value
  if (!id) return
  const activation = timingActivationGeneration
  const lifecycle = lifecycleGeneration
  const isCurrentCompletion = () => pageActive && lifecycle === lifecycleGeneration
    && activation === timingActivationGeneration && timingTaskId.value === id
  timingDoneHandled = true
  stopTimingPolls()
  timingPercent.value = 100
  await loadLines() // 完成后引擎会补好每行的默认分隔帧（与导出同源的估算）
  // Loading the final line list can outlive this page activation or the viewed
  // task. Never let that stale continuation filter/expand a newer task or toast
  // completion after the user has already left this page.
  if (!isCurrentCompletion()) return
  // 首次完成时把「过长行」直接推到眼前：新人常不知道过长行可逐句调分句——分句编辑器默认折叠、
  // 过长行又混在几十句里不显眼（用户反馈：第一次用不知道能在哪调，直接导出了）。有过长行就自动
  // 打开「仅显示过长行」筛选 + 展开第一条的分句编辑器，并给一条说明性提示。此逻辑只在**新完成**时
  // 走一次（切换查看已完成的旧任务走 activateTimingTask，不经这里），不会反复打扰。
  const firstTooLong = dialogLines.value.find((l) => l.needSetSeparator)
  if (firstTooLong) {
    showSeparatorReviewOnly.value = true
    expandedKey.value = lineKey(firstTooLong)
    toast(
      `打轴完成——有 ${tooLongCount.value} 句过长(译文需分两行显示)已进入三行分句复查，逐句拖动分句点调整；`
      + '关闭后可随时点「复查三行分句」重新打开，确认后点「导出 ass」',
      'info',
      9000,
    )
  } else {
    toast('打轴完成——右侧可逐行微调分句，确认后点「导出 ass」', 'success', 6000)
  }
}
async function cancelTiming() {
  // 带 task 精确取消当前查看的任务（并行模式必需；老宿主忽略该参数，行为不变）
  const q = timingTaskId.value ? '&task=' + timingTaskId.value : ''
  try { await post('/engine/cancel?domain=timing' + q) } catch { /* ignore */ }
}

// --- 压制 ---
async function startSuppress() {
  if (!sourceVideo.value || !outputPath.value) { toast('请填写源视频和输出路径', 'warn'); return }
  const parallel = parallelEnabled.value && !hostNoTasks.value
  if (suppressRunning.value && !parallel) return
  const startGeneration = ++suppressStartGeneration
  const lifecycle = lifecycleGeneration
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
      parallel,
    })
    if (!pageActive || lifecycle !== lifecycleGeneration
        || startGeneration !== suppressStartGeneration) return
    ++suppressActivationGeneration
    stopSuppressPoll()
    suppressTaskId.value = r.taskId
    suppressTimer = setInterval(pollSuppress, 500)
    void pollTasks()
  } catch (e: any) {
    if (!pageActive || lifecycle !== lifecycleGeneration
        || startGeneration !== suppressStartGeneration) return
    suppressStatus.value = '' // re-enable button so the user can retry
    toast('启动压制失败: ' + e.message, 'error')
  }
}
function resetSuppress(invalidateActivation = true) {
  if (invalidateActivation) suppressActivationGeneration++
  stopSuppressPoll()
  suppressPercent.value = 0; suppressFrame.value = 0; suppressTotal.value = 0
  suppressFps.value = 0; suppressLog.value = ''
  suppressLogLines.value = []; suppressLogPath.value = ''
}

// --- 压制日志（宿主 ≥5.7.4：滚动日志端点 + 报错自动导出文件） ---
const suppressLogOpen = ref(false)
const suppressLogLines = ref<string[]>([])
const suppressLogPath = ref('')
const hostNoSuppressLog = ref(false) // 老宿主没有 /engine/suppress/log 路由
let suppressLogTimer: any = null
const suppressLogPre = ref<HTMLElement | null>(null)

async function fetchSuppressLog() {
  const id = suppressTaskId.value
  if (!id || hostNoSuppressLog.value) return
  try {
    const l = await api('/engine/suppress/log?task=' + id)
    if (suppressTaskId.value !== id) return
    suppressLogLines.value = l.lines || []
    if (l.path) suppressLogPath.value = l.path
    void nextTick(() => {
      const el = suppressLogPre.value
      if (el) el.scrollTop = el.scrollHeight
    })
  } catch (e: any) {
    // 路由不存在（老宿主，报文是裸 404）→ 隐藏日志面板；任务被修剪掉的 404 带
    // "task not found" 报文，不能据此判定宿主太旧
    if (e && e.status === 404 && /^HTTP /.test(String(e.message || ''))) hostNoSuppressLog.value = true
  }
}
async function exportSuppressLog() {
  const id = suppressTaskId.value
  if (!id) return
  try {
    const r = await post('/engine/suppress/log/export?task=' + id)
    suppressLogPath.value = r.path || ''
    toast('日志已导出: ' + r.path, 'success', 6000)
  } catch (e: any) {
    toast('导出日志失败: ' + e.message, 'error')
  }
}
// 面板开着且任务在跑时才轮询日志（1.5s 一次，纯内存快照，够轻）
function syncSuppressLogTimer() {
  const want = suppressLogOpen.value && !!suppressTaskId.value && suppressRunning.value && !hostNoSuppressLog.value
  if (want && !suppressLogTimer) suppressLogTimer = setInterval(fetchSuppressLog, 1500)
  if (!want && suppressLogTimer) { clearInterval(suppressLogTimer); suppressLogTimer = null }
}
watch([suppressLogOpen, suppressRunning], () => {
  if (suppressLogOpen.value) void fetchSuppressLog()
  syncSuppressLogTimer()
})
const suppressPoll = createSingleFlightPoll(async ({ isCurrent }) => {
  const id = suppressTaskId.value
  if (!id) return
  try {
    const p = await api('/engine/suppress/progress?task=' + id)
    // 同一任务每次只允许一个进度请求在途；切换/停止会失效旧代次，防止较早的
    // running 响应在较新的 done/error 之后回写进度并重复终态提示。
    if (!isCurrent() || suppressTaskId.value !== id) return
    suppressStatus.value = p.status
    suppressPercent.value = p.percent || 0
    suppressFrame.value = p.frame || 0
    suppressTotal.value = p.total || 0
    suppressFps.value = p.fps || 0
    suppressLog.value = p.lastLog || ''
    if (p.logPath) suppressLogPath.value = p.logPath
    if (p.status === 'done') { stopSuppressPoll(); toast('压制完成: ' + (p.outputPath || outputPath.value), 'success') }
    else if (p.status === 'error') {
      stopSuppressPoll()
      void fetchSuppressLog() // 抓终态日志尾巴 + 自动导出的文件路径
      toast('压制失败: ' + (p.error || '') + (p.logPath ? '（日志已自动导出，见压制日志面板）' : ''), 'error', 8000)
    }
    else if (p.status === 'canceled') { stopSuppressPoll() }
  } catch { /* ignore */ }
})
function pollSuppress() {
  return suppressPoll.run()
}
function stopSuppressPoll() {
  suppressPoll.invalidate()
  if (suppressTimer) clearInterval(suppressTimer)
  suppressTimer = null
}
async function cancelSuppress() {
  const q = suppressTaskId.value ? '&task=' + suppressTaskId.value : ''
  try { await post('/engine/cancel?domain=suppress' + q) } catch { /* ignore */ }
}
async function cancelSuppressTask(id: string) {
  try { await post('/engine/cancel?domain=suppress&task=' + id) } catch { /* ignore */ }
  void pollTasks()
}
// 关闭并从列表移除一个压制任务（含已取消/完成/失败的终态卡片——此前只有「取消」没有「移除」，
// 终态卡片只能堆着）。镜像打轴侧 closeTask：后端释放其内核进程，前端若关的是当前查看的任务就清空显示。
async function closeSuppressTask(id: string) {
  try { await post('/engine/suppress/close?task=' + id) } catch { /* ignore */ }
  if (id === suppressTaskId.value) {
    if (suppressLogTimer) { clearInterval(suppressLogTimer); suppressLogTimer = null }
    suppressTaskId.value = ''
    suppressStatus.value = ''
    resetSuppress()
  }
  void pollTasks()
}
</script>

<template>
  <div class="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
    <!-- Header: back to editor + title + engine status -->
    <header class="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-surface)_90%,transparent)] backdrop-blur-md">
      <div class="flex items-center gap-2 px-4 h-12 max-w-[1500px] mx-auto">
        <button
          class="grid place-items-center w-8 h-8 -ml-1 rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          title="返回编辑器"
          @click="goHome"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        </button>
        <span class="font-bold tracking-tight">自动打轴 + 压制</span>
        <span v-if="statusChecked && engineReady" class="app-chip bg-success/15 text-success ml-auto">内核就绪 · {{ engineVersion }}</span>
        <span v-else-if="statusChecked" class="app-chip bg-error/15 text-error ml-auto">{{ engineError || '内核未安装' }}</span>
      </div>
    </header>

    <div class="p-4 max-w-[1500px] mx-auto space-y-4">
      <div
        v-if="statusChecked && !engineReady"
        class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-warning/10 text-warning p-3 text-sm"
      >
        <span v-if="engineError">{{ engineError }}</span>
        <span v-else>打轴内核未安装。需把 SekaiCoreEngine 与 libass 版 ffmpeg 随版本打包到后端的 engine/ 目录(见设置页说明)。</span>
      </div>
      <div
        v-if="hostTooOld"
        class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-warning/10 text-warning p-3 text-sm"
      >
        行列表/分句功能需要更新版本的 SekaiText 主程序（≥ 5.2.0）。请先在「设置 → 检查更新」升级应用，再使用本插件。
      </div>

      <!-- 双列：左=输入与运行，右=行列表与分句微调 -->
      <div class="grid gap-4 min-[900px]:grid-cols-[380px_minmax(0,1fr)] lg:grid-cols-[380px_minmax(0,1fr)] items-start">
        <!-- ① 打轴（左列） -->
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
          <label class="block">
            <span class="app-label">字幕输出目录(可选)</span>
            <div class="flex gap-2 mt-1">
              <input class="app-input flex-1" v-model="assOutputDir" placeholder="留空 = 应用数据目录" />
              <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browseAssDir">选择…</button>
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
              <div class="flex items-center gap-2 flex-wrap pt-1 border-t border-[var(--color-border)]">
                <span class="app-help shrink-0">预设</span>
                <select class="app-input w-36" v-model="thPresets.sel.value" @change="thPresets.applySel()">
                  <option value="">— 选择预设 —</option>
                  <option v-for="p in thPresets.list.value" :key="p.name" :value="p.name">{{ p.name }}</option>
                </select>
                <input class="app-input w-36" v-model="thPresets.nameInput.value" placeholder="新预设名" />
                <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="thPresets.save()">保存预设</button>
                <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" :disabled="!thPresets.sel.value" @click="thPresets.remove()">删除</button>
              </div>
            </div>
          </div>

          <!-- 并行任务模式：可同时打轴/压制多个视频（宿主 ≥5.5.0） -->
          <div v-if="!hostNoTasks">
            <label class="flex items-center gap-2 cursor-pointer w-fit">
              <input type="checkbox" class="toggle toggle-sm" v-model="parallelEnabled" />
              <span class="app-label">并行任务模式（同时打轴/压制多个视频）</span>
            </label>
            <p v-if="parallelEnabled" class="app-help text-warning mt-1">
              ⚠ 每个并行任务独占一个识别/编码内核进程，CPU 与内存开销成倍增长——性能不高的电脑慎用；完成的任务请及时点 ✕ 关闭以释放内存（同类任务最多并行 4 个）。
            </p>
          </div>

          <div class="flex gap-2">
            <button class="btn btn-sm btn-brand" :disabled="!engineReady || (timingRunning && !(parallelEnabled && !hostNoTasks))" @click="startTiming">开始打轴</button>
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)]" :disabled="!timingRunning" @click="cancelTiming">取消</button>
          </div>

          <!-- 任务列表：并行模式或后端还挂着多个任务时显示，点击切换右列查看的任务 -->
          <div v-if="timingTasks.length && (parallelEnabled || timingTasks.length > 1)" class="space-y-1">
            <div
              v-for="t in timingTasks"
              :key="t.taskId"
              class="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] p-2 text-xs cursor-pointer hover:bg-[var(--color-surface)]"
              :style="t.taskId === timingTaskId ? { borderColor: 'var(--color-primary)', background: 'color-mix(in oklch, var(--color-primary) 8%, transparent)' } : {}"
              :title="t.videoPath"
              @click="activateTimingTask(t.taskId)"
            >
              <span class="truncate flex-1">{{ baseName(t.videoPath) || t.taskId }}</span>
              <span class="app-help shrink-0">{{ taskStatusLabel(t) }}<template v-if="t.dialogTotal"> · {{ t.matchedDialog }}/{{ t.dialogTotal }}</template></span>
              <button v-if="t.status === 'running'" class="btn btn-xs btn-ghost border border-[var(--color-border)] shrink-0" @click.stop="cancelTask(t.taskId)">取消</button>
              <button class="btn btn-xs btn-ghost shrink-0" title="关闭任务并释放其内核进程" @click.stop="closeTask(t.taskId)">✕</button>
            </div>
          </div>

          <div v-if="timingStatus">
            <progress class="progress progress-primary w-full" :value="timingPercent" max="100"></progress>
            <div class="app-help mt-1">
              {{ timingStatus }} · {{ timingPercent.toFixed(1) }}% · fps {{ timingFps }} · 剩余 {{ timingEta }} · 对话 {{ matchedDialog }}/{{ dialogTotal }}<template v-if="bannerTotal"> · banner {{ matchedBanner }}/{{ bannerTotal }}</template><template v-if="markerTotal"> · marker {{ matchedMarker }}/{{ markerTotal }}</template>
            </div>
          </div>
          <img v-if="previewSrc" :src="previewSrc" class="rounded-[var(--radius-control)] border border-[var(--color-border)] w-full" />
        </div>

        <!-- ② 行列表 · 分句微调（右列） -->
        <div class="app-card p-5 space-y-3">
          <div class="flex flex-wrap items-center gap-3">
            <div class="section-title">② 行列表 · 分句微调</div>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" class="toggle toggle-sm" v-model="showTooLongOnly" />
              <span class="app-label">仅显示过长行</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" class="toggle toggle-sm" v-model="showSeparatorReviewOnly" />
              <span class="app-label">仅显示三行分句</span>
            </label>
            <button
              v-if="separatorReviewLines.length"
              class="btn btn-xs btn-ghost border border-[var(--color-border)]"
              title="重新筛出全部三行原文并展开第一条，可反复复查和调整"
              @click="openSeparatorReview"
            >复查三行分句</button>
            <span v-if="lines.length" class="app-help">共 {{ dialogLines.length }} 句 · 三行 {{ separatorReviewLines.length }} 句 · 过长 {{ tooLongCount }} 句</span>
            <span class="ml-auto"></span>
            <span v-if="syncPullBlocked" class="app-help text-warning" :title="syncPullBlockedReason">
              ASS 同步标识无效，请重新导出
            </span>
            <button
              v-if="exportedAss"
              class="btn btn-sm btn-ghost border border-[var(--color-border)]"
              :disabled="pulling || syncPullBlocked"
              :title="syncPullBlocked ? syncPullBlockedReason : '立即回读 Aegisub 里保存的译文与换行时间（保存后也会自动回读）'"
              @click="pullFromAegisub(false)"
            >
              {{ pulling ? '拉取中…' : '从 Aegisub 拉取' }}
            </button>
            <button
              v-if="exportedAss"
              class="btn btn-sm btn-ghost border border-[var(--color-border)]"
              :disabled="dirtyCount === 0"
              :title="dirtyCount > 0 ? '把轴机侧的改动写成同步文件，在 Aegisub 里热键拉取' : '轴机侧暂无未推送的改动'"
              @click="pushToAegisub"
            >
              推送到 Aegisub{{ dirtyCount > 0 ? ` (${dirtyCount})` : '' }}
            </button>
            <button
              class="btn btn-sm btn-brand"
              :disabled="timingStatus !== 'done' || exporting || hostTooOld"
              @click="exportAss"
            >
              {{ exporting ? '导出中…' : exportedAss ? '重新导出 ass' : '导出 ass' }}
            </button>
          </div>

          <!-- 导出与同步选项 -->
          <div>
            <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="showExportOpts = !showExportOpts">
              导出与同步选项 {{ showExportOpts ? '▴' : '▾' }}
            </button>
            <div v-if="showExportOpts" class="mt-2 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3 space-y-2">
              <label class="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" class="option-check-input" v-model="cleanExport" />
                <span class="option-check-box" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="m3.75 8.25 2.65 2.6 5.85-6" />
                  </svg>
                </span>
                <span class="app-label">成品清理（样式按原文行数改 1行/2行/3行、删角色名与调试行；\N 保留）</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" class="option-check-input" v-model="exportSyncTags" />
                <span class="option-check-box" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="m3.75 8.25 2.65 2.6 5.85-6" />
                  </svg>
                </span>
                <span class="app-label">写入 Aegisub 同步标识（在每行 Effect 字段埋 st:行号 作为对应标记，双向同步必需）</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" class="option-check-input" v-model="speakerColorExport" />
                <span class="option-check-box" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path d="m3.75 8.25 2.65 2.6 5.85-6" />
                  </svg>
                </span>
                <span class="app-label">角色代表色描边（26 位主要角色按官方代表色写入 \3c 描边，其他角色/NPC 保持默认样式）</span>
              </label>
              <label class="block">
                <span class="app-label">团队样式模板（默认用内置 {{ BUILTIN_STYLE_TEMPLATE_NAME }}，选文件可覆盖）</span>
                <div class="flex gap-2 mt-1">
                  <input class="app-input flex-1" v-model="styleTemplate" :placeholder="'留空 = 内置模板 ' + BUILTIN_STYLE_TEMPLATE_NAME" />
                  <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (styleTemplate = v), [{ name: '字幕/样式', extensions: ['ass', 'txt'] }])">选择…</button>
                </div>
              </label>
              <label class="block">
                <span class="app-label">Aegisub 自动化目录（automation/autoload；便携版探测不到时手动指定）</span>
                <div class="flex gap-2 mt-1">
                  <input class="app-input flex-1" v-model="aegisubDir" placeholder="留空 = 自动探测本机 Aegisub" />
                  <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browseAegisubDir">选择…</button>
                  <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" :disabled="installingMacro" title="立即把同步宏装进上面的目录（留空则自动探测）" @click="installAegisubMacro">{{ installingMacro ? '安装中…' : '安装宏' }}</button>
                </div>
              </label>
              <div class="pt-2 border-t border-[var(--color-border)] space-y-2">
                <span class="app-label">staff 制作人员行（随导出写入 ass 顶部 0:00~0:05；未勾选不输出，勾选但留空输出默认职位项，填写后输出自定义内容）</span>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label v-for="field in STAFF_UI_FIELDS" :key="field.key" class="flex items-center gap-2">
                    <input v-model="staff.enabled[field.key]" type="checkbox" class="checkbox checkbox-sm shrink-0" />
                    <span class="app-help w-16 shrink-0">{{ field.label }}</span>
                    <input
                      v-model="staff[field.key]"
                      class="app-input min-w-0 flex-1"
                      :disabled="!staff.enabled[field.key]"
                      :placeholder="field.placeholder"
                    />
                  </label>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="app-help shrink-0">预设</span>
                  <select class="app-input w-36" v-model="stPresets.sel.value" @change="stPresets.applySel()">
                    <option value="">— 选择预设 —</option>
                    <option v-for="p in stPresets.list.value" :key="p.name" :value="p.name">{{ p.name }}</option>
                  </select>
                  <input class="app-input w-36" v-model="stPresets.nameInput.value" placeholder="新预设名" />
                  <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="stPresets.save()">保存预设</button>
                  <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" :disabled="!stPresets.sel.value" @click="stPresets.remove()">删除</button>
                </div>
              </div>
              <p class="app-help">
                导出后在 Aegisub 里精调直接 Ctrl+S 保存即可，轴机会自动回读译文与换行时间（也可点「从 Aegisub 拉取」手动回读）；轴机侧再改动后点「推送到 Aegisub」，在 Aegisub 里运行「自动化 → SekaiText → 从轴机拉取」应用（同步宏随导出自动安装，装不上就在上面指定目录后点「安装宏」，首次需重启 Aegisub）。
              </p>
            </div>
          </div>

          <!-- 导出状态条 -->
          <div v-if="exportedAss" class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-success/10 p-2 text-xs space-y-1">
            <div class="text-success">✓ 已导出: {{ exportedAss }}</div>
            <div v-if="aegisubMacroPath" class="app-help">✓ 同步宏已自动装入 Aegisub（{{ aegisubMacroPath }}，首次使用重启 Aegisub 生效）</div>
            <div v-else-if="syncScriptPath" class="app-help">未检测到本机 Aegisub。同步宏已生成: {{ syncScriptPath }}（复制进 Aegisub 的 automation/autoload 目录，一次即可）</div>
            <div v-if="pulling" class="app-help">正在回读 Aegisub 改动…</div>
          </div>

          <!-- 行列表 -->
          <div class="space-y-2 overflow-y-auto pr-1 max-h-[calc(100vh-16rem)]">
            <LineRow
              v-for="l in visibleLines"
              :key="lineKey(l)"
              :line="l"
              :fps="linesFps"
              :task-id="timingTaskId"
              :expanded="expandedKey === lineKey(l)"
              @toggle="toggleExpand(l)"
              @updated="onLineUpdated"
              @error="(m: string) => toast(m, 'error')"
            />
            <div v-if="!visibleLines.length" class="app-help py-10 text-center">
              {{ lines.length ? '没有符合筛选的行' : timingRunning ? '识别中，已定稿的行会陆续出现在这里…' : '开始打轴后，这里显示识别行；完成后可逐行微调分句并导出。' }}
            </div>
          </div>
        </div>
      </div>

      <!-- ③ 压制（下滑可见，整宽） -->
      <div class="app-card p-5 space-y-3">
        <div class="section-title">③ 压制(烧录字幕导出成片)</div>

        <label class="block">
          <span class="app-label">源视频</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="sourceVideo" placeholder="导出 ass 后自动填充,也可手填" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (sourceVideo = v), VIDEO_FILTER)">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">字幕 ass</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="sourceSubtitle" placeholder="导出 ass 后自动填充" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (sourceSubtitle = v), [{ name: '字幕', extensions: ['ass', 'ssa', 'srt'] }])">选择…</button>
          </div>
        </label>
        <label class="block">
          <span class="app-label">输出 mp4</span>
          <div class="flex gap-2 mt-1">
            <input class="app-input flex-1" v-model="outputPathModel" placeholder="选择源视频后自动按视频名生成" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (outputPathModel = v), [{ name: 'MP4', extensions: ['mp4'] }], { save: true, def: defaultOutput() })">另存为…</button>
          </div>
        </label>

        <!-- 字体子系统体检警告（内核 ≥2.3.6）：字体缓存损坏的机器压制会无声挂起，开压前就亮牌 -->
        <div
          v-if="fontCheckWarn"
          class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-warning/10 text-warning p-3 text-sm"
        >
          ⚠️ 字体子系统检测：{{ fontCheckWarn }}
        </div>

        <!-- 编码器占满剩余宽、CRF 固定列宽，两者等高成列 -->
        <div class="grid grid-cols-[1fr_7rem] gap-3">
          <label class="block">
            <span class="app-label">编码器</span>
            <select class="app-input mt-1" v-model="encoder">
              <option v-for="e in encoderOptions" :key="e" :value="e">{{ encoderLabel(e) }}</option>
            </select>
            <span v-if="recommendedEncoder" class="app-help mt-1 block">
              已按本机显卡检测可用编码器{{ encoder === recommendedEncoder ? '，当前为推荐项' : '，推荐：' + encoderLabel(recommendedEncoder) }}
            </span>
            <details v-if="failedEncoderText" class="mt-1">
              <summary class="app-help cursor-pointer select-none">部分硬件编码器未通过检测（点开看原因）</summary>
              <div class="app-help whitespace-pre-wrap mt-1">{{ failedEncoderText }}</div>
            </details>
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
          <button class="btn btn-sm btn-brand" :disabled="!engineReady || (suppressRunning && !(parallelEnabled && !hostNoTasks))" @click="startSuppress">开始压制</button>
          <button class="btn btn-sm btn-ghost border border-[var(--color-border)]" :disabled="!suppressRunning" @click="cancelSuppress">取消</button>
        </div>

        <!-- 压制任务列表（并行模式）：点击切换查看的任务 -->
        <div v-if="suppressTasks.length && (parallelEnabled || suppressTasks.length > 1)" class="space-y-1">
          <div
            v-for="t in suppressTasks"
            :key="t.taskId"
            class="rounded-[var(--radius-control)] border border-[var(--color-border)] p-2 text-xs cursor-pointer hover:bg-[var(--color-surface)]"
            :style="t.taskId === suppressTaskId ? { borderColor: 'var(--color-primary)', background: 'color-mix(in oklch, var(--color-primary) 8%, transparent)' } : {}"
            :title="t.outputPath"
            @click="activateSuppressTask(t.taskId)"
          >
            <div class="flex items-center gap-2">
              <span class="truncate flex-1">{{ baseName(t.outputPath) || baseName(t.sourceVideo) || t.taskId }}</span>
              <span class="app-help shrink-0">{{ taskStatusLabel(t) }}</span>
              <button v-if="t.status === 'running'" class="btn btn-xs btn-ghost border border-[var(--color-border)] shrink-0" @click.stop="cancelSuppressTask(t.taskId)">取消</button>
              <!-- ✕ 只给终态卡片：运行中的压制必须走「取消」（suppress.stop 才会杀 ffmpeg
                   进程树），硬移除会留下孤儿 ffmpeg 继续编码，后端对 running 也拒绝(409)。 -->
              <button v-if="t.status !== 'running'" class="btn btn-xs btn-ghost shrink-0" title="移除任务" @click.stop="closeSuppressTask(t.taskId)">✕</button>
            </div>
            <!-- 每个并行任务自己的进度条：主进度区只跟当前查看的任务，其余任务
                 的进度在这里各自独立显示，互不串线 -->
            <progress v-if="t.status === 'running'" class="progress progress-primary w-full h-1 mt-1" :value="t.percent || 0" max="100"></progress>
          </div>
        </div>

        <div v-if="suppressStatus">
          <progress class="progress progress-primary w-full" :value="suppressPercent" max="100"></progress>
          <div class="app-help mt-1">
            <span v-if="suppressViewedName" class="font-medium">{{ suppressViewedName }} · </span>{{ suppressStatus }} · {{ suppressPercent.toFixed(1) }}% · 帧 {{ suppressFrame }}/{{ suppressTotal }} · fps {{ suppressFps.toFixed(0) }}
          </div>
          <code v-if="suppressLog" class="block truncate app-help" style="font-size:10px">{{ suppressLog }}</code>
        </div>

        <!-- 压制日志（宿主 ≥5.7.4）：滚动日志 + 报错自动导出；手动导出留档 -->
        <details v-if="suppressTaskId && !hostNoSuppressLog" class="rounded-[var(--radius-control)] border border-[var(--color-border)]" @toggle="(e: any) => { suppressLogOpen = e.target.open }">
          <summary class="cursor-pointer select-none px-2 py-1 text-xs app-help">压制日志{{ suppressLogPath ? '（已导出文件）' : '' }}</summary>
          <div class="p-2 pt-0 space-y-1">
            <div class="flex items-center gap-2">
              <button class="btn btn-xs btn-ghost border border-[var(--color-border)] shrink-0" @click="exportSuppressLog">导出日志文件</button>
              <code v-if="suppressLogPath" class="app-help truncate flex-1 select-all" style="font-size:10px" :title="suppressLogPath">{{ suppressLogPath }}</code>
            </div>
            <pre ref="suppressLogPre" class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-surface)] p-2 text-[10px] leading-4">{{ suppressLogLines.length ? suppressLogLines.join('\n') : '（暂无日志）' }}</pre>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.option-check-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.option-check-box {
  display: grid;
  place-items: center;
  width: 1.125rem;
  height: 1.125rem;
  flex: 0 0 1.125rem;
  border: 1px solid var(--color-border-strong, var(--color-border));
  border-radius: 0.35rem;
  color: var(--accent, var(--color-primary));
  background: color-mix(in oklch, var(--color-surface) 88%, transparent);
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
.option-check-box svg {
  width: 0.75rem;
  height: 0.75rem;
  overflow: visible;
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 100ms ease, transform 120ms ease;
}
.option-check-box path {
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.option-check-input:checked + .option-check-box {
  border-color: color-mix(in oklch, var(--accent, var(--color-primary)) 55%, var(--color-border));
  background: color-mix(in oklch, var(--accent, var(--color-primary)) 12%, transparent);
}
.option-check-input:checked + .option-check-box svg {
  opacity: 1;
  transform: scale(1);
}
.option-check-input:focus-visible + .option-check-box {
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent, var(--color-primary)) 18%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .option-check-box,
  .option-check-box svg { transition: none; }
}
</style>
