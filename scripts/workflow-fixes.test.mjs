import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/components/AutoTimingPage.vue', import.meta.url),
  'utf8',
)

test('suppression output follows the source video until the user overrides it', () => {
  assert.match(source, /watch\(\[sourceVideo, videoPath\], refreshDerivedOutput, \{ immediate: true \}\)/)
  assert.match(source, /const outputPathModel = computed\(/)
  assert.match(source, /outputPathManual\.value = value\.trim\(\) !== '' && value !== defaultOutput\(\)/)
  assert.match(source, /v-model="outputPathModel"/)
})

test('automatic ASS pull is silent and backs off instead of repeating error toasts', () => {
  assert.match(source, /await pullFromAegisub\(true, contentHash\)/)
  assert.match(source, /function deferSyncPullRetry/)
  assert.match(source, /Math\.min\(60_000/)
})

test('invalid ASS sync identity blocks retries until the file changes or is re-exported', () => {
  assert.match(source, /if \(e\?\.status === 409\)/)
  assert.match(source, /function blockSyncPull/)
  assert.match(source, /syncPullRetryAt = Number\.POSITIVE_INFINITY/)
  assert.match(source, /if \(contentHash === syncPullBlockedHash\) return/)
  assert.match(source, /:disabled="pulling \|\| syncPullBlocked"/)
  assert.match(source, /ASS 同步标识无效，请重新导出/)
})

test('staff export has per-field enable state and separate checker/suppressor roles', () => {
  assert.match(source, /type StaffFieldKey = [^\n]*'checker'[^\n]*'suppressor'/)
  assert.match(source, /staff\.enabled\[field\.key\]/)
  assert.match(source, /const staffPayload = computed\(\(\) => cloneStaff\(staff\.value\)\)/)
  assert.match(source, /label: '轴校'/)
  assert.match(source, /label: '压制'/)
  assert.match(source, /placeholder: '例如：PJS字幕组'/)
  assert.match(source, /placeholder: '例如：六周年'/)
})

test('three-line separator review remains reopenable after rows are corrected', () => {
  assert.match(source, /const showSeparatorReviewOnly = ref\(false\)/)
  assert.match(source, /function openSeparatorReview\(\)/)
  assert.match(source, />复查三行分句<\/button>/)
  assert.match(source, /if \(showSeparatorReviewOnly\.value\) return separatorReviewLines\.value/)
})
