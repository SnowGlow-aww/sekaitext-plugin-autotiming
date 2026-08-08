export interface PollContext {
  isCurrent: () => boolean
}

/**
 * Coalesces overlapping polls within one generation while allowing a newly
 * selected task to start immediately after invalidation. Handlers must check
 * isCurrent() after awaited work before applying a response.
 */
export function createSingleFlightPoll<Args extends unknown[]>(
  handler: (context: PollContext, ...args: Args) => Promise<void>,
) {
  let generation = 0
  let flight: { generation: number } | null = null

  return {
    invalidate() {
      generation += 1
    },

    async run(...args: Args) {
      const runGeneration = generation
      if (flight?.generation === runGeneration) return

      const token = { generation: runGeneration }
      flight = token
      try {
        await handler({ isCurrent: () => generation === runGeneration }, ...args)
      } finally {
        if (flight === token) flight = null
      }
    },
  }
}
