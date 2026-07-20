// Auto-timing(打轴) + suppress(压制) plugin entry. The host calls setup(host)
// after loading this bundle. All host singletons (Vue/router/pinia/stores/api)
// are reached via the bridge — see vite.config.ts host-shim and ./host.ts.
import AutoTimingPage from './components/AutoTimingPage.vue'
import AutoTimingSettings from './components/AutoTimingSettings.vue'

const PLUGIN_ID = 'auto-timing'

export function setup(host: any) {
  host.registerRoute(PLUGIN_ID, {
    path: '/auto-timing',
    component: AutoTimingPage,
  })
  host.registerSidebarItem(PLUGIN_ID, {
    id: 'auto-timing:main',
    label: '自动轴机',
    icon: 'Clapperboard',
    to: '/auto-timing',
    order: 60,
  })
  host.registerSettingsSection(PLUGIN_ID, {
    id: 'auto-timing:settings',
    title: '打轴 / 压制',
    component: AutoTimingSettings,
    order: 60,
  })
}

export function teardown() {
  document.getElementById('sekai-plugin-autotiming-css')?.remove()
}
