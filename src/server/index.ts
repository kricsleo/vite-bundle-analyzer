import path from 'path'
import fs from 'fs'
import type { Logger, Plugin } from 'vite'
import ansis from 'ansis'
import { opener } from './opener'
import { arena, createServer, renderView } from './render'
import { searchForWorkspaceRoot } from './search-root'
import type { AnalyzerPluginOptions, AnalyzerStore, OutputAsset, OutputBundle, OutputChunk } from './interface'
import { AnalyzerNode, createAnalyzerModule } from './analyzer-module'
import { analyzerDebug, convertBytes, fsp } from './shared'
import { states } from './states'

const isCI = !!process.env.CI

const defaultOptions: AnalyzerPluginOptions = {
  analyzerMode: 'server',
  defaultSizes: 'stat',
  summary: true
}

function openBrowser(address: string) {
  opener([address])
}

const formatNumber = (number: number | string) => ansis.dim(ansis.bold(number + ''))

const formatSize = (number: number) => formatNumber(convertBytes(number))

const generateSummaryMessage = (modules: AnalyzerNode[]) => {
  const count = modules.length
  const meta = modules.reduce((acc, module) => {
    acc.gzip += module.gzipSize
    acc.parsed += module.parsedSize
    acc.map += module.mapSize
    return acc
  }, {
    gzip: 0,
    parsed: 0,
    map: 0
  })
  const extra = [
    meta.gzip && `gzip: ${formatSize(meta.gzip)}`,
    meta.map && `map: ${formatSize(meta.map)}`
  ].filter(Boolean).join(' | ')
  return `${formatNumber(count)} chunks of ${formatSize(meta.parsed)} ${extra ? `(${extra})` : ''}`
}

function expectFile(fileName: string, ext: string) {
  return path.extname(fileName) === ext
}

function validateChunk(chunk: OutputAsset | OutputChunk, allChunks: OutputBundle): [boolean, string | undefined] {
  // https://github.com/rollup/rollup/blob/master/CHANGELOG.md#features-22
  // So we should check it and implement a polyfill.
  if (expectFile(chunk.fileName, '.js')) {
    const possiblePath = chunk.fileName + '.map'
    if (possiblePath in allChunks) return [true, possiblePath]
    return [true, undefined]
  }
  return [false, undefined]
}

// Design for race condition is called
let callCount = 0

function analyzer(opts?: AnalyzerPluginOptions): Plugin {
  opts = { ...defaultOptions, ...opts }

  const { reportTitle = 'vite-bundle-analyzer' } = opts
  const analyzerModule = createAnalyzerModule(opts?.gzipOptions)
  const store: AnalyzerStore = {
    analyzerModule
  }
  let defaultWd = process.cwd()
  let hasViteReporter = true
  let logger: Logger
  let workspaceRoot = process.cwd()
  const preferLivingServer = opts.analyzerMode === 'server' || opts.analyzerMode === 'static'
  const preferSilent = opts.analyzerMode === 'json' || opts.analyzerMode === 'static'

  const b = arena()

  const plugin = <Plugin> {
    name: 'vite-bundle-anlyzer',
    apply: 'build',
    enforce: 'post',
    api: {
      store
    },
    config(config) {
      // For some reason, like `vitepress`,`vuepress` and other static site generator etc. They might use the same config object
      // for multiple build process. So we should ensure the sourcemap option is set correctly.
      if (!states.hasSetupSourcemapOption) {
        states.hasSetupSourcemapOption = true
        if (!config.build) {
          config.build = {}
        }
        if ('sourcemap' in config.build) {
          states.lastSourcemapOption = typeof config.build.sourcemap === 'boolean'
            ? config.build.sourcemap
            : config.build.sourcemap === 'hidden'
          if (config.build.sourcemap === 'inline') {
            // verbose the warning
            logger.warn('vite-bundle-analyzer: sourcemap option is set to `inline`, it might cause the result inaccurate.')
          }
        }
      }
      if (config.build) {
        if (typeof config.build.sourcemap === 'boolean') {
          config.build.sourcemap = true
        } else {
          config.build.sourcemap = 'hidden'
        }
        analyzerDebug(`plugin status is ${config.build.sourcemap ? ansis.green('ok') : ansis.red('invalid')}`)
      }
      return config
    },
    configResolved(config) {
      defaultWd = path.resolve(config.root, config.build.outDir ?? '')
      logger = config.logger
      workspaceRoot = searchForWorkspaceRoot(config.root)
      analyzerModule.workspaceRoot = workspaceRoot
      if (opts.summary) {
        const reporter = config.plugins.find(plugin => plugin.name === 'vite:reporter')
        hasViteReporter = !!reporter?.writeBundle
        if (reporter?.writeBundle) {
          const originalFunction = typeof reporter.writeBundle === 'function'
            ? reporter.writeBundle
            : reporter.writeBundle?.handler
          const fn: Plugin['writeBundle'] = async function writeBundle(...args) {
            await originalFunction?.apply(this, args)
            logger.info(generateSummaryMessage(analyzerModule.modules))
          }

          if (typeof reporter.writeBundle !== 'function') {
            reporter.writeBundle.handler = fn
          } else {
            reporter.writeBundle = fn
          }
        }
      }
    },
    async generateBundle(_, outputBundle) {
      analyzerModule.installPluginContext(this)
      analyzerModule.setupRollupChunks(outputBundle)
      // After consider. I trust process chunk is enough. (If you don't think it's right. PR welcome.)
      // A funny thing is that 'Import with Query Suffixes' vite might think the worker is assets
      // So we should wrapper them as a chunk node.
      for (const bundleName in outputBundle) {
        const bundle = outputBundle[bundleName]
        const [pass, sourcemapFileName] = validateChunk(bundle, outputBundle)
        if (pass) {
          // For classical
          await analyzerModule.addModule(bundle, sourcemapFileName)
        }
        if (!states.lastSourcemapOption) {
          if (pass) {
            if (sourcemapFileName) {
              Reflect.deleteProperty(outputBundle, sourcemapFileName)
              continue
            }
            if (bundle.type === 'chunk') {
              Reflect.deleteProperty(bundle, 'map')
            }
          }
        }
      }
    },
    async closeBundle() {
      if (opts.summary && !hasViteReporter) {
        logger.info(generateSummaryMessage(analyzerModule.modules))
      }
      const analyzeModule = analyzerModule.processModule()
      callCount++

      if (preferSilent) {
        const output = 'fileName' in opts ? opts.fileName : 'stats'
        let p = path.join(defaultWd, `${output}.${opts.analyzerMode === 'json' ? 'json' : 'html'}`)
        if (fs.existsSync(p)) {
          p = path.join(defaultWd, `${output}-${callCount}.${opts.analyzerMode === 'json' ? 'json' : 'html'}`)
        }
        if (opts.analyzerMode === 'json') {
          return fsp.writeFile(p, JSON.stringify(analyzeModule, null, 2), 'utf8')
        }
        const html = await renderView(analyzeModule, { title: reportTitle, mode: opts.defaultSizes || 'stat' })
        fsp.writeFile(p, html, 'utf8')
        b.into(html)
        if (opts.analyzerMode === 'static' && !opts.openAnalyzer) {
          return
        }
      }

      if (preferLivingServer) {
        callCount--
        const html = await renderView(analyzeModule, { title: reportTitle, mode: opts.defaultSizes || 'stat' })
        b.into(html)
        const { setup, port } = await createServer(
          'analyzerPort' in opts
            ? opts.analyzerPort === 'auto'
              ? 0
              : opts.analyzerPort
            : 8888 + callCount
        )
        setup({ title: reportTitle, mode: 'stat', arena: b })
        if (('openAnalyzer' in opts ? opts.openAnalyzer : true) && !isCI) {
          const address = `http://localhost:${port}`
          openBrowser(address)
        }
        callCount++
      }
    }
  }

  return plugin
}

export { analyzer }
export { adapter } from './adapter'
export { analyzer as default }
export type { AnalyzerPluginOptions } from './interface'
