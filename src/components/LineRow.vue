<script setup lang="ts">
// 结果面板里的一行：对话行可展开分句编辑器（文本分割点 + 换行帧微调 +
// 该帧画面实时预览 + 打字速度建议帧 + 按字数均分）；对话译文和地点横幅
// 都可双击快速编辑。
import { ref, computed, watch, onUnmounted } from 'vue'
import { api, post, trimAll, frameToTime, CHAR_TIME_MS, type EngineLine } from '../engine'

const props = defineProps<{
  line: EngineLine
  fps: number
  taskId: string
  expanded: boolean
}>()
const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'updated', line: EngineLine): void
  (e: 'error', msg: string): void
}>()

const isDialog = computed(() => props.line.type === 'dialog')
const isBanner = computed(() => props.line.type === 'banner')
const isEditable = computed(() => isDialog.value || isBanner.value)
// 原文 3 行才允许分句（与 GUI QuickEdit 的 CanReturn 一致）
const canSeparate = computed(
  () => isDialog.value && (props.line.body.match(/\n/g)?.length ?? 0) >= 2,
)

const startTime = computed(() => frameToTime(props.line.startIndex, props.fps))
const endTime = computed(() => frameToTime(props.line.endIndex, props.fps))

// 对齐桌面 QuickEdit：\R 是时间分轴点；同一译文里存在 \R 时，\N/\n 只负责
// 原 ASS 的排版，进入编辑器前移除，避免一次无改动保存把断点提前到 \N。
function dialogEditText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.includes('\\R')) {
    return normalized
      .replace(/\n/g, '')
      .replace(/\\(?:N|n)/g, '')
      .replace(/\\R/g, '\n')
  }
  return normalized.replace(/\\(?:N|n)/g, '\n')
}

function hasValidExplicitSplit(text: string): boolean {
  const normalized = dialogEditText(text)
  const first = normalized.indexOf('\n')
  return first > 0
    && first === normalized.lastIndexOf('\n')
    && trimAll(normalized.slice(0, first)).length > 0
    && trimAll(normalized.slice(first + 1)).length > 0
}

const displayText = computed(() => {
  const text = props.line.bodyTranslated || props.line.body
  return isDialog.value ? dialogEditText(text) : text
})

// --- 分句本地编辑态（提交成功后以引擎回包为准） ---
const ci = ref(props.line.separatorContentIndex ?? 1)
const sf = ref(props.line.separateFrame ?? 0)
watch(
  () => [props.line.separatorContentIndex, props.line.separateFrame],
  () => {
    ci.value = props.line.separatorContentIndex ?? 1
    sf.value = props.line.separateFrame ?? 0
  },
)

const trimmed = computed(() => trimAll(props.line.bodyTranslated))
const ciMax = computed(() => Math.max(1, trimmed.value.length - 1))
const part1 = computed(() => trimmed.value.slice(0, ci.value))
const part2 = computed(() => trimmed.value.slice(ci.value))
const sfMin = computed(() => props.line.startIndex + 1)
const sfMax = computed(() => Math.max(sfMin.value, props.line.endIndex - 1))

// 溢出预警（与 Avalonia 卡片同公式：80ms/字 vs 半段显示时长）
const frameDurMs = computed(() => (props.fps > 0 ? 1000 / props.fps : 0))
const warn1 = computed(
  () => part1.value.length * CHAR_TIME_MS > (sf.value - props.line.startIndex) * frameDurMs.value,
)
const warn2 = computed(
  () => part2.value.length * CHAR_TIME_MS > (props.line.endIndex - sf.value) * frameDurMs.value,
)

function clampSf(v: number) {
  return Math.min(sfMax.value, Math.max(sfMin.value, Math.round(v)))
}
function nudge(delta: number) {
  sf.value = clampSf(sf.value + delta)
  commitSeparator()
}
function evenSplit() {
  // 无配音时按字数比例均分显示时长（教程截图里的推荐做法）
  const len = trimmed.value.length || 1
  sf.value = clampSf(props.line.startIndex + ((props.line.endIndex - props.line.startIndex) * ci.value) / len)
  commitSeparator()
}

// --- 提交（防抖合并滑块拖动） ---
let commitTimer: any = null
function commitSeparator() {
  if (commitTimer) clearTimeout(commitTimer)
  commitTimer = setTimeout(async () => {
    commitTimer = null
    try {
      const updated = await post('/engine/timing/line/separator?task=' + props.taskId, {
        index: props.line.index,
        separateFrame: sf.value,
        separatorContentIndex: ci.value,
      })
      emit('updated', updated)
    } catch (e: any) {
      emit('error', '保存分句失败: ' + e.message)
    }
  }, 250)
}

async function toggleSeparator() {
  try {
    const updated = await post('/engine/timing/line/separator?task=' + props.taskId, {
      index: props.line.index,
      useSeparator: !props.line.useSeparator,
    })
    emit('updated', updated)
  } catch (e: any) {
    emit('error', '切换分句失败: ' + e.message)
  }
}

// --- 建议帧：文本分割点变化后按打字速度估算（只算不落地，点「应用」才写） ---
const suggestFrame = ref<number | null>(null)
let suggestTimer: any = null
watch([ci, () => props.expanded, () => props.line.useSeparator], () => {
  if (!props.expanded || !props.line.useSeparator) return
  if (suggestTimer) clearTimeout(suggestTimer)
  suggestTimer = setTimeout(async () => {
    suggestTimer = null
    try {
      const r = await post('/engine/timing/line/estimate?task=' + props.taskId, {
        index: props.line.index,
        separatorContentIndex: ci.value,
      })
      suggestFrame.value = typeof r.separateFrame === 'number' ? r.separateFrame : null
    } catch {
      suggestFrame.value = null
    }
  }, 350)
}, { immediate: true })
function applySuggest() {
  if (suggestFrame.value == null) return
  sf.value = clampSf(suggestFrame.value)
  commitSeparator()
}

// --- 语音停顿候选：拉取该句语音做静音检测，把换行对齐到说话人实际停顿 ---
// （人声台词的分句习惯按语音节奏；无语音的虚拟歌手台词走「按字数均分」）
const voicePauses = ref<{ frame: number; timeSec: number }[] | null>(null)
const voiceState = ref<'idle' | 'loading' | 'novoice' | 'error'>('idle')
const voiceErrMsg = ref('')
async function fetchVoicePauses() {
  if (voiceState.value === 'loading') return
  voiceState.value = 'loading'
  voiceErrMsg.value = ''
  try {
    const r = await post('/engine/timing/line/voicepauses?task=' + props.taskId, { index: props.line.index })
    if (r.noVoice) { voiceState.value = 'novoice'; voicePauses.value = null; return }
    voicePauses.value = (r.pauses || []).map((p: any) => ({ frame: p.frame, timeSec: p.timeSec }))
    if (voicePauses.value!.length) {
      voiceState.value = 'idle'
    } else {
      voiceState.value = 'error'
      voiceErrMsg.value = '这段语音没有明显停顿'
    }
  } catch (e: any) {
    voiceState.value = 'error'
    voiceErrMsg.value = e && e.status === 404 ? '需要 SekaiText ≥ 5.5.0' : (e?.message || '获取失败')
    voicePauses.value = null
  }
}
function applyPause(f: number) {
  sf.value = clampSf(f)
  commitSeparator()
}

// --- 换行帧画面预览（展开时跟随 sf，防抖取帧） ---
const thumbB64 = ref('')
let thumbTimer: any = null
watch([sf, () => props.expanded, () => props.line.useSeparator], () => {
  if (!props.expanded || !props.line.useSeparator) return
  if (thumbTimer) clearTimeout(thumbTimer)
  thumbTimer = setTimeout(async () => {
    thumbTimer = null
    try {
      const r = await api(
        `/engine/timing/frame?task=${props.taskId}&frame=${sf.value}&maxWidth=520`,
      )
      if (r.base64) thumbB64.value = r.base64
    } catch {
      /* 预览失败不打扰操作 */
    }
  }, 250)
}, { immediate: true })
const thumbSrc = computed(() => (thumbB64.value ? 'data:image/jpeg;base64,' + thumbB64.value : ''))

onUnmounted(() => {
  for (const t of [commitTimer, suggestTimer, thumbTimer]) if (t) clearTimeout(t)
})

// --- 译文/地点横幅快速编辑（双击进入；对话对齐 QuickEdit：最多 2 行） ---
const editing = ref(false)
const editText = ref('')
function startEdit() {
  if (!isEditable.value) return
  const current = props.line.bodyTranslated || (isBanner.value ? props.line.body : '')
  editText.value = isDialog.value ? dialogEditText(current) : current
  editing.value = true
}
function onEditInput() {
  if (isBanner.value) {
    editText.value = editText.value.replace(/[\r\n]+/g, '')
    return
  }
  const parts = dialogEditText(editText.value).split('\n')
  editText.value = parts.length > 2
    ? parts.slice(0, 2).join('\n') + parts.slice(2).join('')
    : parts.join('\n')
}
async function saveEdit() {
  try {
    const endpoint = isBanner.value
      ? '/engine/timing/line/banner-translation'
      : '/engine/timing/line/translation'
    const explicitSplit = isDialog.value && hasValidExplicitSplit(editText.value)
    const updated = await post(endpoint + '?task=' + props.taskId, {
      index: props.line.index,
      text: editText.value,
      // 保留用户已选择的分句状态；显式回车/\N 则明确表示把三行原文拆成两条轴。
      useSeparator: isDialog.value
        ? (!!props.line.useSeparator || (canSeparate.value && explicitSplit))
        : undefined,
    })
    editing.value = false
    emit('updated', updated)
  } catch (e: any) {
    if (isBanner.value && e?.status === 404) {
      emit('error', '保存地点横幅失败：需要更新 SekaiText 主程序')
    } else {
      emit('error', (isBanner.value ? '保存地点横幅失败: ' : '保存译文失败: ') + e.message)
    }
  }
}
</script>

<template>
  <div
    class="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-base-100)]"
    :class="line.needSetSeparator ? 'border-l-2 border-l-warning' : ''"
  >
    <!-- 头行：起始时间 · 说话人 · 结束时间（可点击展开） -->
    <div
      class="flex items-baseline gap-2 px-3 pt-2 select-none"
      :class="isDialog ? 'cursor-pointer' : ''"
      @click="isDialog && emit('toggle')"
    >
      <span class="app-help tabular-nums">{{ startTime }}</span>
      <span v-if="line.type === 'banner'" class="app-chip bg-info/15 text-info">横幅</span>
      <span v-else-if="line.type === 'marker'" class="app-chip bg-info/15 text-info">标记</span>
      <span v-else class="font-medium text-sm truncate">{{ line.character }}</span>
      <span v-if="line.needSetSeparator" class="app-chip bg-warning/15 text-warning">过长</span>
      <span v-if="line.shake" class="app-chip bg-info/15 text-info">抖动</span>
      <span class="app-help tabular-nums ml-auto">{{ endTime }}</span>
    </div>

    <!-- 正文（对话译文/地点横幅双击快速编辑） -->
    <div
      v-if="!editing"
      class="px-3 pb-2 pt-1 text-sm whitespace-pre-wrap"
      :class="isEditable ? 'cursor-text' : ''"
      :title="isDialog ? '双击编辑译文' : isBanner ? '双击编辑地点横幅' : ''"
      @dblclick="startEdit"
    >
      {{ displayText }}
    </div>
    <div v-else class="px-3 pb-2 pt-1 space-y-2">
      <!-- 原文对照：微调译文时随时可见（引擎行数据自带 BodyOriginal） -->
      <div class="app-help whitespace-pre-wrap" title="原文">{{ line.body }}</div>
      <textarea
        v-model="editText"
        :rows="isBanner ? 1 : 2"
        class="app-input w-full text-sm"
        @input="onEditInput"
        @keydown.esc="editing = false"
      ></textarea>
      <div class="flex gap-2">
        <button class="btn btn-xs btn-brand" @click="saveEdit">保存</button>
        <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="editing = false">取消</button>
      </div>
    </div>

    <!-- 分句编辑器 -->
    <div v-if="expanded && isDialog" class="border-t border-[var(--color-border)] px-3 py-3 space-y-3">
      <!-- 日语原文常驻对照：分割点要对着原文的语气/停顿下刀，只看译文没法定 -->
      <div>
        <div class="app-label mb-1">日语原文</div>
        <div class="app-help whitespace-pre-wrap">{{ line.body }}</div>
      </div>
      <label v-if="canSeparate" class="flex items-center gap-2 cursor-pointer w-fit">
        <input type="checkbox" class="checkbox checkbox-sm" :checked="!!line.useSeparator" @change="toggleSeparator" />
        <span class="app-label">分句（长行切成前后两条）</span>
      </label>
      <div v-else class="app-help">此行原文不足三行，无需分句。</div>

      <template v-if="line.useSeparator">
        <!-- 文本分割点 -->
        <div>
          <div class="app-label mb-1">将文本分割为</div>
          <div class="text-sm leading-relaxed">
            <span>{{ part1 }}</span>
            <span class="text-brand font-bold mx-1">/</span>
            <span>{{ part2 }}</span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="app-help tabular-nums w-8 text-right">{{ part1.length }}</span>
            <input
              type="range"
              class="range range-xs range-primary flex-1"
              :min="1"
              :max="ciMax"
              v-model.number="ci"
              @change="commitSeparator"
            />
            <span class="app-help tabular-nums w-8">{{ part2.length }}</span>
          </div>
        </div>

        <!-- 换行帧 -->
        <div>
          <div class="flex items-baseline justify-between">
            <span class="app-label">换行时机</span>
            <span class="app-help tabular-nums">在 {{ sf }} ⇒ {{ frameToTime(sf, fps) }} 处换行</span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="app-help tabular-nums">{{ sfMin }}</span>
            <input
              type="range"
              class="range range-xs range-primary flex-1"
              :min="sfMin"
              :max="sfMax"
              v-model.number="sf"
              @change="commitSeparator"
            />
            <span class="app-help tabular-nums">{{ sfMax }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1 mt-2">
            <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="nudge(-5)">-5</button>
            <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="nudge(-1)">-1</button>
            <input
              type="number"
              class="app-input w-24 text-center tabular-nums"
              :min="sfMin"
              :max="sfMax"
              v-model.number="sf"
              @change="sf = clampSf(sf); commitSeparator()"
            />
            <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="nudge(1)">+1</button>
            <button class="btn btn-xs btn-ghost border border-[var(--color-border)]" @click="nudge(5)">+5</button>
            <button
              class="btn btn-xs btn-ghost border border-[var(--color-border)]"
              :disabled="suggestFrame == null"
              title="按打字机速度估算此分割点的换行时刻"
              @click="applySuggest"
            >
              建议 {{ suggestFrame != null ? suggestFrame : '…' }}
            </button>
            <button
              class="btn btn-xs btn-ghost border border-[var(--color-border)]"
              title="无配音台词：按字数比例均分显示时长"
              @click="evenSplit"
            >
              按字数均分
            </button>
            <button
              class="btn btn-xs btn-ghost border border-[var(--color-border)]"
              :disabled="voiceState === 'loading'"
              title="拉取该句语音做静音检测，把换行对齐到说话人实际的停顿处"
              @click="fetchVoicePauses"
            >
              {{ voiceState === 'loading' ? '语音分析中…' : '语音停顿' }}
            </button>
          </div>
          <div v-if="voicePauses && voicePauses.length" class="flex flex-wrap items-center gap-1 mt-1">
            <span class="app-help">停顿点（点击应用）:</span>
            <button
              v-for="p in voicePauses"
              :key="p.frame"
              class="btn btn-xs btn-ghost border border-[var(--color-border)] tabular-nums"
              :title="'语音 ' + p.timeSec.toFixed(2) + 's 处停顿 → 帧 ' + p.frame"
              @click="applyPause(p.frame)"
            >
              {{ p.frame }}
            </button>
          </div>
          <div v-else-if="voiceState === 'novoice'" class="app-help mt-1">
            该行无语音（虚拟歌手台词）——按观众读完为准，用「按字数均分」或打字速度建议。
          </div>
          <div v-else-if="voiceState === 'error'" class="text-warning text-xs mt-1">语音停顿: {{ voiceErrMsg }}</div>
          <div v-if="warn1 || warn2" class="text-warning text-xs mt-1">
            <span v-if="warn1">第一行文字可能来不及打完；</span>
            <span v-if="warn2">第二行文字可能来不及打完；</span>
            适当移动换行时机或分割点。
          </div>
          <img
            v-if="thumbSrc"
            :src="thumbSrc"
            class="mt-2 rounded-[var(--radius-control)] border border-[var(--color-border)] w-full max-w-lg"
            alt="换行帧画面"
          />
        </div>
      </template>
    </div>
  </div>
</template>
