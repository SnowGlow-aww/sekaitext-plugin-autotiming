// Accessors for host-provided singletons/utilities. Everything the plugin needs
// from the core app comes through window.__SEKAI_HOST__ (installed by the host
// bridge), so the plugin never imports core source directly.
declare global {
  interface Window {
    __SEKAI_HOST__?: any
  }
}

export function host() {
  const h = window.__SEKAI_HOST__
  if (!h) throw new Error('SEKAI host bridge not found — plugin loaded outside host?')
  return h
}

// Toast helper (same notifier the core uses).
export const toast = (
  message: string,
  type?: 'success' | 'error' | 'info' | 'warn',
  duration?: number,
) => host().ui.toast(message, type, duration)

// Native file pickers (reuse the host's Tauri dialog). Resolve to an absolute
// path or null. Throws outside Tauri (web dev) — callers should catch.
export const pickFile = (options?: any): Promise<string | null> =>
  host()
    .dialog.open(options)
    .then((r: any) => (typeof r === 'string' ? r : null))
export const pickSave = (options?: any): Promise<string | null> => host().dialog.save(options)

// Navigate back to the host editor (this plugin renders as a top-level route).
export const goHome = () => host().router.push('/')

// Core stores.
export const useStoryStore = () => host().stores.story()

export {}
