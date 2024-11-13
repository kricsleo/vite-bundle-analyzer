// adapter for rollup
import type { Plugin } from 'rollup'
import type { Plugin as VitePlugin } from 'vite'
import { searchForWorkspaceRoot } from './search-root'
import type { AnalyzerStore } from './interface'
import { pick } from './shared'
import { states } from './states'

export function adapter(userPlugin: VitePlugin) {
  const plugin = pick(userPlugin, ['name', 'generateBundle', 'closeBundle', 'api'])
  let root = process.cwd()
  const { store }: { store: AnalyzerStore } = plugin.api
  return <Plugin> {
    ...plugin,
    outputOptions(outputOptions) {
      if (states.hasSetupSourcemapOption) return
      states.hasSetupSourcemapOption = true
      if (outputOptions.dir) {
        root = outputOptions.dir
      }
      store.analyzerModule.workspaceRoot = searchForWorkspaceRoot(root)
      // setup sourcemap hack
      if ('sourcemap' in outputOptions) {
        states.lastSourcemapOption = typeof outputOptions.sourcemap === 'boolean'
          ? outputOptions.sourcemap
          : outputOptions.sourcemap === 'hidden'
      }
      if (typeof outputOptions.sourcemap === 'boolean' && outputOptions.sourcemap) {
        outputOptions.sourcemap = true
      } else {
        outputOptions.sourcemap = 'hidden'
      }
      return outputOptions
    }
  }
}
