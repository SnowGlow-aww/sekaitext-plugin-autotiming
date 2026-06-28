<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { API_BASE } from '../constants'

const checked = ref(false)
const ready = ref(false)        // engine actually usable
const errorMsg = ref('')        // backend-provided reason when not ready
const version = ref('')

onMounted(async () => {
  try {
    const res = await fetch(API_BASE + '/engine/status')
    const s = await res.json()
    ready.value = !!s.ready
    errorMsg.value = s.error || ''
    version.value = s.engine ? s.engine.name + ' v' + s.engine.version : ''
  } catch { /* ignore */ } finally {
    checked.value = true
  }
})
</script>

<template>
  <div class="space-y-2">
    <span v-if="checked && ready" class="app-chip bg-success/15 text-success">内核就绪 · {{ version }}</span>
    <span v-else-if="checked" class="app-chip bg-error/15 text-error">{{ errorMsg || '内核未安装' }}</span>
    <p class="app-help leading-relaxed">
      自动打轴需要:日文剧情 <b>scenario JSON</b> + 对应的<b>视频录像</b>(打轴按视频画面匹配台词生成时间轴)。<br />
      压制(烧录字幕)需要 <b>libass 版 ffmpeg</b>;macOS 默认走 <code>hevc_videotoolbox</code> 硬件编码。<br />
      内核二进制与 ffmpeg 需随应用版本打包到后端的 <code>engine/</code> 目录;若上方显示“内核未安装”,请参考发布说明放置后重启。
    </p>
  </div>
</template>
