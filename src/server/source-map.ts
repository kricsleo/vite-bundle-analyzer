import { SourceMapConsumer } from 'source-map'
import type { MappingItem } from 'source-map'
import type { ChunkMetadata } from './trie'

const decoder = new TextDecoder()

export async function convertSourcemapToContents(rawSourceMap: string) {
  const consumer = await new SourceMapConsumer(rawSourceMap)
  const sources = await consumer.sources
  const result = sources.reduce((acc, source) => {
    const s = consumer.sourceContentFor(source, true)
    if (s) acc.push({ id: source, code: s })
    return acc
  }, [] as Array<ChunkMetadata>)
  consumer.destroy()
  return result
}

type Loc = MappingItem & { lastGeneratedColumn: number | null }

function splitBytesByNewLine(bytes: Uint8Array) {
  const result = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0A) {
      const line = bytes.subarray(start, i)
      result.push(line)
      start = i + 1
    }
  }

  if (start < bytes.length) {
    result.push(bytes.subarray(start))
  }
  return result
}

// we convert javaScript String to unit8Array 
// But like chinese characters and the like may occupy more bytes if they are encoded in UTF8.
// So we should respect the generated column (Because javaScript String are encoded according to UTF16)
function getStringFromSerializeMappings(bytes: Uint8Array[], mappings: Array<Loc>) {
  const maapingWithLine = mappings.reduce((acc, cur) => {
    const { generatedLine } = cur
    if (!(generatedLine in acc)) {
      acc[generatedLine] = []
    }
    acc[generatedLine].push(cur)
    return acc
  }, {} as Record<number, Array<Loc>>)

  let s = ''
  for (const line in maapingWithLine) {
    const l = parseInt(line) - 1
    if (bytes[l]) {
      const runes = decoder.decode(bytes[l])
      const mappings = maapingWithLine[line]
      const cap = mappings.length
      for (let i = 0; i < cap; i++) {
        const currentMaaping = mappings[i]
        const nextMapping = i + 1 >= cap ? null : mappings[i + 1]
        if (cap === 1 || currentMaaping.lastGeneratedColumn === null) {
          s += runes.substring(currentMaaping.generatedColumn)
          continue
        }
        if (typeof currentMaaping.lastGeneratedColumn === 'number') {
          const end = currentMaaping.lastGeneratedColumn + 1 === nextMapping?.generatedColumn
            ? nextMapping.generatedColumn
            : currentMaaping.lastGeneratedColumn
          s += runes.substring(currentMaaping.generatedColumn, end)
        }
      }
    }
  }
  return s
}

// https://esbuild.github.io/faq/#minified-newlines
// https://github.com/terser/terser/issues/960
// an unstable mapping computed function
// There seems to be some problems with the sourcemap generated by terser.
export async function getSourceMappings(code: Uint8Array, rawSourceMap: string, formatter: (id: string) => string) {
  const hints: Record<string, string> = {}
  const bytes = splitBytesByNewLine(code)
  const consumer = await new SourceMapConsumer(rawSourceMap)
  const mappingWithId: Record<string, { mappings: Array<Loc> }> = Object.create(null)
  consumer.eachMapping(mapping => {
    if (mapping.source) {
      const id = formatter(mapping.source)
      if (!(id in mappingWithId)) {
        mappingWithId[id] = { mappings: [] }
      }
      mappingWithId[id].mappings.push(mapping as Loc)
    }
  }, null, SourceMapConsumer.ORIGINAL_ORDER)

  for (const id in mappingWithId) {
    const { mappings } = mappingWithId[id]
    mappings.sort((a, b) => a.generatedColumn - b.generatedColumn)
    if (mappings.length > 0) {
      hints[id] = getStringFromSerializeMappings(bytes, mappings)
    }
  }
  consumer.destroy()
  return hints
}
