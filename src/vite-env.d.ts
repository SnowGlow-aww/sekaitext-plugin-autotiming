// tsconfig 的 types:[] 屏蔽了 vite/client，这里单独声明 ?raw 资源导入
// （内置团队样式模板以整段文本随 bundle 分发）。
declare module '*.ass?raw' {
  const content: string
  export default content
}
