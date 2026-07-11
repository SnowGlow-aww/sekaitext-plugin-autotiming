<script setup lang="ts">
// 双列布局：左列=输入与运行控制（对照 Avalonia 独立版），右列=行列表与分句微调；
// 压制保持在下方整宽（下滑可见）。导出内建 tools.lua 清理 + Aegisub 双向同步。
import { ref, shallowRef, computed, nextTick, onMounted, onUnmounted, onActivated, onDeactivated, watch } from 'vue'
import { toast, pickFile, pickSave, goHome } from '../host'
import { FALLBACK_ENCODERS, FALLBACK_DEFAULT_ENCODER, encoderLabel } from '../constants'
import { api, post, type EngineLine, type LinesPayload } from '../engine'
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
  try {
    const r = await api('/engine/tasks')
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
    if (e && e.status === 404) {
      hostNoTasks.value = true
      if (tasksTimer) { clearInterval(tasksTimer); tasksTimer = null }
    }
  }
}
function startTasksPoll() {
  if (tasksTimer || hostNoTasks.value) return
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
    stopTimingPolls()
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
    timingTaskId.value = ''
    timingStatus.value = ''
    lines.value = []; linesFps.value = 0; expandedKey.value = ''; previewB64.value = ''
    exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null
  }
  void pollTasks()
}
// 切换「当前查看」的打轴任务：右列行列表/导出/同步全部跟着走。
// 直接读 /progress 填充状态（不走 pollTiming，免得切到终态任务时误弹完成/失败 toast）。
async function activateTimingTask(id: string) {
  if (!id || timingTaskId.value === id) return
  stopTimingPolls()
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  const snap = timingTasks.value.find((t) => t.taskId === id)
  timingDoneHandled = !!snap && snap.status !== 'running' // 终态任务不再补完成 toast
  timingTaskId.value = id
  timingPercent.value = 0; previewB64.value = ''
  lines.value = []; linesFps.value = 0; expandedKey.value = ''
  exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null
  const p = await api('/engine/timing/progress?task=' + id).catch(() => null)
  if (!p) { timingStatus.value = snap?.status || ''; return }
  timingStatus.value = p.status
  timingPercent.value = p.percent || 0
  timingFps.value = p.fps || 0; timingEta.value = p.eta || ''
  dialogTotal.value = p.dialogTotal || 0; bannerTotal.value = p.bannerTotal || 0; markerTotal.value = p.markerTotal || 0
  matchedDialog.value = p.matchedDialog || 0; matchedBanner.value = p.matchedBanner || 0; matchedMarker.value = p.matchedMarker || 0
  if (p.status === 'running') {
    timingDoneHandled = false
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
    if (!hostTooOld.value) linesTimer = setInterval(loadLines, 2000)
  } else if (p.status === 'done') {
    await loadLines()
    // 恢复导出/同步状态（导出过的任务重新挂上自动回读）
    try {
      const s = await api('/engine/timing/sync/status?task=' + id)
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
  resetSuppress()
  suppressTaskId.value = id
  const snap = suppressTasks.value.find((t) => t.taskId === id)
  if (snap && snap.status !== 'running') {
    // 终态任务：直接用快照填充，不走 pollSuppress（免得误弹完成/失败 toast）
    suppressStatus.value = snap.status
    suppressPercent.value = snap.percent || 0
    suppressLog.value = snap.error || ''
    if (suppressLogOpen.value) void fetchSuppressLog()
    return
  }
  await pollSuppress()
  if (suppressStatus.value === 'running' && !suppressTimer) suppressTimer = setInterval(pollSuppress, 500)
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

const dialogLines = computed(() => lines.value.filter((l) => l.type === 'dialog'))
const tooLongCount = computed(() => dialogLines.value.filter((l) => l.needSetSeparator).length)
const visibleLines = computed(() => {
  if (!showTooLongOnly.value) return lines.value
  return lines.value.filter((l) => l.type === 'dialog' && l.needSetSeparator)
})
function lineKey(l: EngineLine) {
  return l.type + ':' + l.index
}
function toggleExpand(l: EngineLine) {
  expandedKey.value = expandedKey.value === lineKey(l) ? '' : lineKey(l)
}

async function loadLines() {
  if (!timingTaskId.value) return
  try {
    const p: LinesPayload = await api('/engine/timing/lines?task=' + timingTaskId.value)
    linesFps.value = p.fps || 0
    lines.value = (p.lines || []).slice().sort((a, b) => a.startIndex - b.startIndex)
    hostTooOld.value = false
  } catch (e: any) {
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
  // 本地乐观标脏，让「推送到 Aegisub」计数即时反馈（真值下轮 sync 轮询会覆盖）
  if (exportedAss.value && syncStatus.value) {
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
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null
    if (timingStatus.value !== 'done' || !timingTaskId.value) return
    try {
      await post('/engine/timing/autosave?task=' + timingTaskId.value, {
        outputDir: assOutputDir.value,
        clean: cleanExport.value,
        syncTags: exportSyncTags.value,
        styleTemplate: styleTemplate.value,
        styleTemplateContent: styleTemplate.value ? '' : BUILTIN_STYLE_TEMPLATE,
      })
    } catch { /* 保险动作静默失败；老版宿主没有该端点（404）也不打扰 */ }
  }, 1500)
}

// --- 导出与 Aegisub 同步 ---
const CLEAN_KEY = 'autotiming:cleanExport'
const SYNC_KEY = 'autotiming:syncTags'
const TMPL_KEY = 'autotiming:styleTemplate'
const AEGISUB_DIR_KEY = 'autotiming:aegisubDir'
const cleanExport = ref(localStorage.getItem(CLEAN_KEY) !== '0')
const exportSyncTags = ref(localStorage.getItem(SYNC_KEY) !== '0')
const styleTemplate = ref(localStorage.getItem(TMPL_KEY) || '')
// Aegisub automation/autoload 目录：便携版/自定义安装位置自动探测不到，手动指一次
const aegisubDir = ref(localStorage.getItem(AEGISUB_DIR_KEY) || '')
watch(cleanExport, (v) => { try { localStorage.setItem(CLEAN_KEY, v ? '1' : '0') } catch { /* ignore */ } })
watch(exportSyncTags, (v) => { try { localStorage.setItem(SYNC_KEY, v ? '1' : '0') } catch { /* ignore */ } })
watch(styleTemplate, (v) => { try { localStorage.setItem(TMPL_KEY, v) } catch { /* ignore */ } })
watch(aegisubDir, (v) => { try { localStorage.setItem(AEGISUB_DIR_KEY, v) } catch { /* ignore */ } })
const showExportOpts = ref(false)

// --- staff 制作人员行（随导出注入 ass 顶部；职位固定，ID 可自定义） ---
const STAFF_KEY = 'autotiming:staffInfo'
interface StaffInfo {
  group: string; episode: string; title: string; recorder: string
  translator: string; proofread: string; timer: string; suppressor: string
}
function loadStaff(): StaffInfo {
  const base: StaffInfo = { group: '', episode: '', title: '', recorder: '', translator: '', proofread: '', timer: '', suppressor: '' }
  try { return { ...base, ...JSON.parse(localStorage.getItem(STAFF_KEY) || '{}') } } catch { return base }
}
const staff = ref<StaffInfo>(loadStaff())
watch(staff, (v) => { try { localStorage.setItem(STAFF_KEY, JSON.stringify(v)) } catch { /* ignore */ } }, { deep: true })
const staffFilled = computed(() => Object.values(staff.value).some((v) => v.trim() !== ''))
// 话数/标题是每集都变的字段，其余（组名/成员）跨集复用——staffPayload 只在有内容时携带
const staffPayload = computed(() => (staffFilled.value ? { ...staff.value } : null))

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
  () => ({ ...staff.value }),
  (d) => { staff.value = { ...staff.value, ...d } },
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
let syncTimer: any = null
const dirtyCount = computed(() => (syncStatus.value?.dirtyLines?.length as number) || 0)

async function exportAss() {
  if (timingStatus.value !== 'done' || exporting.value) return
  exporting.value = true
  try {
    // Aegisub 侧有未回读的保存时先拉取，导出才不会覆盖人家的精调
    if (syncStatus.value?.changedOnDisk) await pullFromAegisub(true)
    const r = await post('/engine/timing/export?task=' + timingTaskId.value, {
      outputDir: assOutputDir.value,
      clean: cleanExport.value,
      syncTags: exportSyncTags.value,
      styleTemplate: styleTemplate.value,
      // 未指定自定义模板时用内置团队模板（路径优先于内容，后端同口径）
      styleTemplateContent: styleTemplate.value ? '' : BUILTIN_STYLE_TEMPLATE,
      aegisubDir: aegisubDir.value, // 用户指定的 autoload 目录（便携版探测不到时）
      staff: staffPayload.value, // staff 制作人员行；全空则不注入
    })
    exportedAss.value = r.assPath
    syncScriptPath.value = r.syncScript || ''
    aegisubMacroPath.value = r.aegisubMacro || ''
    for (const wmsg of r.warnings || []) toast(wmsg, 'warn', 7000)
    // 一条龙：自动填充压制段
    if (!sourceVideo.value) sourceVideo.value = videoPath.value
    sourceSubtitle.value = r.assPath
    if (!outputPath.value) outputPath.value = defaultOutput()
    toast('字幕已导出: ' + r.assPath, 'success')
    startSyncPoll()
  } catch (e: any) {
    toast('导出字幕失败: ' + e.message, 'error')
  } finally {
    exporting.value = false
  }
}

function startSyncPoll() {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(pollSync, 3000)
  pollSync()
}
async function pollSync() {
  if (!exportedAss.value || !timingTaskId.value) return
  try {
    const s = await api('/engine/timing/sync/status?task=' + timingTaskId.value)
    syncStatus.value = s
    // Aegisub 里 Ctrl+S 保存 → 自动回读换行时间，轴机列表跟着刷新
    if (s.changedOnDisk && !pulling.value) await pullFromAegisub()
  } catch { /* transient */ }
}
async function pullFromAegisub(silent = false) {
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
    } else if (!silent) {
      toast('已检查 Aegisub 文件，没有需要回读的改动', 'info')
    }
    if (syncStatus.value) syncStatus.value.changedOnDisk = false
  } catch (e: any) {
    if (!silent) toast('回读 Aegisub 改动失败: ' + e.message, 'error')
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
// 编码器：上次手选的优先，否则按平台给个必然能跑的默认（此前写死 HevcVideoToolbox，
// Windows 上 "Unknown encoder" 压制 100% 起不来）。宿主 ≥5.7.3 时 probeEncoders 会
// 拿到按显卡逐个试编码验证过的列表 + 推荐项，自动精确化。
const ENCODER_KEY = 'autotiming:encoder'
const encoder = ref(localStorage.getItem(ENCODER_KEY) || FALLBACK_DEFAULT_ENCODER)
watch(encoder, (v) => { try { localStorage.setItem(ENCODER_KEY, v) } catch { /* ignore */ } })
const encoderOptions = ref<string[]>([...FALLBACK_ENCODERS])
const recommendedEncoder = ref('')
let encodersProbed = false
async function probeEncoders() {
  if (encodersProbed) return
  try {
    const p = await api('/engine/suppress/probe')
    if (!Array.isArray(p.encoders) || !p.encoders.length) return // 老内核（<2.1.0）没这字段，维持兜底
    encodersProbed = true
    encoderOptions.value = p.encoders
    recommendedEncoder.value = p.recommended || ''
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
  try {
    const s = await api('/engine/status')
    engineAvailable.value = !!s.available
    engineReady.value = !!s.ready
    engineError.value = s.error || ''
    engineVersion.value = s.engine ? s.engine.name + ' v' + s.engine.version : ''
    // 内核在位就探测本机可用编码器（结果后端缓存，只有首次真的跑试编码）
    if (engineAvailable.value) void probeEncoders()
  } catch (e: any) {
    engineAvailable.value = false
    engineReady.value = false
    engineError.value = (e && e.message) || ''
  } finally {
    statusChecked.value = true
  }
}
onMounted(() => {
  refreshEngineStatus()
  startTasksPoll() // 任务快照：并行任务列表 + 页面重建后找回后端仍存活的任务
})

onUnmounted(() => clearAllTimers())
// The host wraps plugin routes in <keep-alive>, so navigating back to the editor
// DEACTIVATES (does not unmount) this page — stop polling while hidden, and
// resume if a run is still in flight when we return.
onDeactivated(() => clearAllTimers())
onActivated(() => {
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
  for (const t of [timingTimer, previewTimer, linesTimer, suppressTimer, syncTimer, tasksTimer, suppressLogTimer]) if (t) clearInterval(t)
  timingTimer = previewTimer = linesTimer = suppressTimer = syncTimer = tasksTimer = suppressLogTimer = null
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
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
  const parallel = parallelEnabled.value && !hostNoTasks.value
  if (timingRunning.value && !parallel) return
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
    timingTaskId.value = r.taskId
    timingTimer = setInterval(pollTiming, 500)
    previewTimer = setInterval(pollPreview, 500)
    linesTimer = setInterval(loadLines, 2000)
    void pollTasks()
  } catch (e: any) {
    timingStatus.value = '' // re-enable button so the user can retry
    toast('启动打轴失败: ' + e.message, 'error')
  }
}
function resetTiming(keepSuppressInputs = false) {
  stopTimingPolls()
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  timingDoneHandled = false
  timingPercent.value = 0; timingFps.value = 0; timingEta.value = ''
  dialogTotal.value = 0; bannerTotal.value = 0; markerTotal.value = 0
  matchedDialog.value = 0; matchedBanner.value = 0; matchedMarker.value = 0
  previewB64.value = ''
  lines.value = []; linesFps.value = 0; expandedKey.value = ''
  exportedAss.value = ''; syncScriptPath.value = ''; aegisubMacroPath.value = ''; syncStatus.value = null
  // Clear suppress carry-over inputs so a new timing run never leaves the 压制 section
  // pointing at the PREVIOUS video's source/subtitle/output (export repopulates them;
  // on failure they stay empty instead of stale). 并行模式不清：老任务导出的字幕
  // 正在/等着压制是常态，不能被新打轴顺手抹掉。
  if (!keepSuppressInputs) {
    sourceVideo.value = ''; sourceSubtitle.value = ''; outputPath.value = ''
  }
}
function stopTimingPolls() {
  if (timingTimer) clearInterval(timingTimer)
  if (previewTimer) clearInterval(previewTimer)
  if (linesTimer) clearInterval(linesTimer)
  timingTimer = previewTimer = linesTimer = null
}
async function pollTiming() {
  const id = timingTaskId.value
  if (!id) return
  try {
    const p = await api('/engine/timing/progress?task=' + id)
    // 等待响应期间切换了查看的任务：丢弃，防止旧任务的数据/终态 toast 盖到新任务头上
    if (timingTaskId.value !== id) return
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
  timingDoneHandled = true
  stopTimingPolls()
  timingPercent.value = 100
  await loadLines() // 完成后引擎会补好每行的默认分隔帧（与导出同源的估算）
  toast('打轴完成——右侧可逐行微调分句，确认后点「导出 ass」', 'success', 6000)
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
    suppressTaskId.value = r.taskId
    suppressTimer = setInterval(pollSuppress, 500)
    void pollTasks()
  } catch (e: any) {
    suppressStatus.value = '' // re-enable button so the user can retry
    toast('启动压制失败: ' + e.message, 'error')
  }
}
function resetSuppress() {
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
async function pollSuppress() {
  const id = suppressTaskId.value
  if (!id) return
  try {
    const p = await api('/engine/suppress/progress?task=' + id)
    // 等待响应期间切换/新建了任务：丢弃旧任务的响应——并行模式下这会把上一个
    // 任务的百分比/终态写进新任务的显示（进度条来回跳 + 误弹完成/失败 toast）
    if (suppressTaskId.value !== id) return
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
}
function stopSuppressPoll() {
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
            <span v-if="lines.length" class="app-help">共 {{ dialogLines.length }} 句 · 过长 {{ tooLongCount }} 句</span>
            <span class="ml-auto"></span>
            <button
              v-if="exportedAss"
              class="btn btn-sm btn-ghost border border-[var(--color-border)]"
              :disabled="pulling"
              title="立即回读 Aegisub 里保存的译文与换行时间（保存后也会自动回读）"
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
                <input type="checkbox" class="checkbox checkbox-sm" v-model="cleanExport" />
                <span class="app-label">成品清理（样式按分行数改 1行/2行/3行、删角色名与调试行；\N 保留）</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" class="checkbox checkbox-sm" v-model="exportSyncTags" />
                <span class="app-label">写入 Aegisub 同步标识（在每行 Effect 字段埋 st:行号 作为对应标记，双向同步必需）</span>
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
                <span class="app-label">staff 制作人员行（随导出写入 ass 顶部 0:00~0:05；留空的职位不输出；时轴与轴校&压制为同一人时自动合并为「时轴&轴校&压制」）</span>
                <div class="grid grid-cols-2 gap-2">
                  <input class="app-input" v-model="staff.group" placeholder="字幕组（字幕制作 by …）" />
                  <input class="app-input" v-model="staff.episode" placeholder="话数（如 第一话）" />
                  <input class="app-input" v-model="staff.title" placeholder="标题（如 六周年）" />
                  <input class="app-input" v-model="staff.recorder" placeholder="录制" />
                  <input class="app-input" v-model="staff.translator" placeholder="翻译" />
                  <input class="app-input" v-model="staff.proofread" placeholder="校对" />
                  <input class="app-input" v-model="staff.timer" placeholder="时轴" />
                  <input class="app-input" v-model="staff.suppressor" placeholder="轴校&压制" />
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
            <input class="app-input flex-1" v-model="outputPath" placeholder="输出文件绝对路径" />
            <button class="btn btn-sm btn-ghost border border-[var(--color-border)] shrink-0" @click="browse((v) => (outputPath = v), [{ name: 'MP4', extensions: ['mp4'] }], { save: true, def: defaultOutput() })">另存为…</button>
          </div>
        </label>

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
