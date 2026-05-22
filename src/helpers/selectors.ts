import fs from 'fs'
import path from 'path'
import { toFunctionSelector } from 'viem'

type AbiItem = {
  type: string
  name?: string
  inputs?: { type: string; name: string }[]
}

/**
 * Build selector map from an ABI
 */
function buildSelectorMap(abi: AbiItem[]): Record<string, string> {
  const map: Record<string, string> = {}

  for (const item of abi) {
    if (item.type === 'function' && item.name && item.inputs) {
      const inputTypes = item.inputs.map((input) => input.type).join(',')
      const signature = `${item.name}(${inputTypes})`
      try {
        const selector = toFunctionSelector(signature).toLowerCase()
        map[selector] = item.name
      } catch {
        // Skip if selector computation fails
      }
    }
  }

  return map
}

/**
 * Load all ABIs from the abis directory and build combined selector map
 */
function loadAllAbis(): Record<string, string> {
  const abisDir = path.resolve(__dirname, '../../abis')
  const selectorMap: Record<string, string> = {}

  try {
    const files = fs.readdirSync(abisDir)

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(abisDir, file)
        const abiContent = fs.readFileSync(filePath, 'utf-8')
        const abi = JSON.parse(abiContent) as AbiItem[]
        Object.assign(selectorMap, buildSelectorMap(abi))
      }
    }
  } catch {
    // If directory reading fails, return empty map
  }

  return selectorMap
}

/**
 * Combined selector map from all ABIs in the abis directory
 * Built once at module load time
 */
const SELECTOR_MAP: Record<string, string> = loadAllAbis()

/**
 * Get human-readable name for a function selector
 * @param selector - The function selector (4-byte like "0xd6febde8" or 32-byte padded)
 * @returns Human-readable function name or the selector if unknown
 */
export function getSelectorName(selector: string): string {
  const normalizedSelector = selector.toLowerCase()
  // Extract 4-byte selector if 32-byte padded value is provided
  const selector4Byte =
    normalizedSelector.length > 10 ? normalizedSelector.slice(0, 10) : normalizedSelector
  return SELECTOR_MAP[selector4Byte] || selector
}
