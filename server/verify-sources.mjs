import { loadConfig } from "./config.js"
import { collectFromSource, mapPool } from "./collect.js"

const cfg = loadConfig()
const only = process.argv.slice(2)

const sources = cfg.sources.filter(
  (s) => !only.length || only.some((o) => s.id.includes(o) || (s.category ?? "").includes(o)),
)

const results = await mapPool(sources, 6, async (source) => {
  const t0 = Date.now()
  try {
    const items = await collectFromSource(source, {
      timeoutMs: cfg.collection.feedTimeoutMs,
      maxPerSource: 3,
      summaryChars: 200,
    })
    return {
      id: source.id,
      ok: true,
      ms: Date.now() - t0,
      n: items.length,
      sample: items[0].title.slice(0, 70),
      dated: items.filter((i) => i.publishedAt).length,
    }
  } catch (err) {
    return { id: source.id, url: source.url, ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 90) }
  }
})

const ok = results.filter((r) => r.ok)
const bad = results.filter((r) => !r.ok)

console.log("\n=== WORKING ===")
for (const r of ok.sort((a, b) => a.ms - b.ms)) {
  console.log(`  ${r.id.padEnd(20)} ${String(r.ms).padStart(6)}ms  n=${r.n}  ${r.sample}`)
}

console.log("\n=== BROKEN ===")
for (const r of bad) {
  console.log(`  ${r.id.padEnd(20)} ${r.error}`)
  console.log(`      ${r.url}`)
}

console.log(`\n${ok.length}/${results.length} feeds OK`)
