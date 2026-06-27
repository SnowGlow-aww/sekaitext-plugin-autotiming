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
  <div class="space-y-2 text-sm">
    <div v-if="checked && ready" class="badge badge-success">引擎就绪 · {{ version }}</div>
    <div v-else-if="checked" class="badge badge-error">{{ errorMsg || '引擎未安装' }}</div>
    <p class="opacity-70 leading-relaxed">
      自动打轴需要:日文剧情 <b>scenario JSON</b> + 对应的<b>视频录像</b>(打轴按视频画面匹配台词生成时间轴)。<br />
      压制(烧录字幕)需要 <b>libass 版 ffmpeg</b>;macOS 默认走 <code>hevc_videotoolbox</code> 硬件编码。<br />
      引擎二进制与 ffmpeg 需随应用版本打包到后端的 <code>engine/</code> 目录;若上方显示“引擎未安装”,请参考发布说明放置后重启。
    </p>
  </div>
</template>
