import assert from 'node:assert/strict'
import test from 'node:test'
import { createSingleFlightPoll } from '../src/polling.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('coalesces overlapping polls in the same generation', async () => {
  const gate = deferred()
  let calls = 0
  const poll = createSingleFlightPoll(async () => {
    calls += 1
    await gate.promise
  })

  const first = poll.run()
  const overlapping = poll.run()
  assert.equal(calls, 1)

  gate.resolve()
  await Promise.all([first, overlapping])

  await poll.run()
  assert.equal(calls, 2)
})

test('invalidation permits a new poll and marks the old response stale', async () => {
  const gates = [deferred(), deferred()]
  const applied = []
  let calls = 0
  const poll = createSingleFlightPoll(async ({ isCurrent }) => {
    const call = calls++
    await gates[call].promise
    if (isCurrent()) applied.push(call)
  })

  const oldPoll = poll.run()
  poll.invalidate()
  const newPoll = poll.run()
  assert.equal(calls, 2)

  gates[1].resolve()
  await newPoll
  gates[0].resolve()
  await oldPoll

  assert.deepEqual(applied, [1])
})
