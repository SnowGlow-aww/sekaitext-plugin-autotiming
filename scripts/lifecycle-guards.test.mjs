import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pageSource = await readFile(
  new URL('../src/components/AutoTimingPage.vue', import.meta.url),
  'utf8',
)

test('terminal timing completion revalidates task and lifecycle after loading lines', () => {
  assert.match(pageSource, /const isCurrentCompletion = \(\) => pageActive/)
  assert.match(
    pageSource,
    /await loadLines\(\)[\s\S]*?if \(!isCurrentCompletion\(\)\) return/,
  )
})

test('engine readiness and encoder probes reject stale lifecycle responses', () => {
  assert.match(pageSource, /const isCurrentStatus = \(\) => pageActive/)
  assert.match(pageSource, /if \(!isCurrentStatus\(\)\) return/)
  assert.match(pageSource, /const isCurrentProbe = \(\) => pageActive/)
  assert.match(pageSource, /if \(!isCurrentProbe\(\)\) return/)
})
