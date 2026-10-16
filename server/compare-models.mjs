/**
 * A/B the two candidate curator models on the real candidate set already in the
 * database. Prints the briefs side by side so quality can be judged directly.
 */
import { loadConfig } from "./config.js"
import { buildCandidateList } from "./rank.js"
import { curate } from "./curate.js"
import { itemsSince } from "./db.js"

const config = loadConfig()
const weights = Object.fromEntries(config.sources.map((s) => [s.id, s.weight ?? 0]))
const pool = itemsSince(config.collection.windowHours).map((item) => ({
  ...item,
  sourceWeight: weights[item.sourceId] ?? 0,
}))
const { candidates, considered } = buildCandidateList(pool, config)
console.log(`pool=${pool.length} considered=${considered} candidates=${candidates.length}\n`)

const MODELS = [
  { providerID: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b", mode: "locked" },
  { providerID: "opencode", id: "deepseek-v4.1-flash-free", mode: "plain" },
]

for (const model of MODELS) {
  console.log(`\n${"=".repeat(78)}\n${model.providerID}/${model.id}  [${model.mode}]\n${"=".repeat(78)}`)
  const t0 = Date.now()
  const outcome = await curate(candidates, { ...config, model }, { onStep: (s) => console.log(`  · ${s}`) })
  const ms = Date.now() - t0
  if (!outcome.ok) {
    console.log(`  FAILED after ${ms}ms: ${outcome.error}`)
    continue
  }
  const b = outcome.brief
  console.log(`  ${ms}ms · ${outcome.itemIds.length} items used`)
  console.log(`\nHEADLINE: ${b.headline}`)
  console.log(`\nLEAD: ${b.lead?.item.title ?? "(none)"}`)
  console.log(`  ${b.lead?.why ?? ""}`)
  console.log(`  context: ${b.lead?.context ?? ""}`)
  for (const section of b.sections) {
    console.log(`\n  [${section.id}]`)
    for (const entry of section.entries) {
      console.log(`    • ${entry.item.title}`)
      console.log(`      ${entry.note}`)
      if (entry.alsoCoveredBy.length) console.log(`      also: ${entry.alsoCoveredBy.map((a) => a.source).join(", ")}`)
    }
  }
  console.log(`\nWATCHLIST: ${b.watchlist.join(" / ")}`)
}
process.exit(0)
