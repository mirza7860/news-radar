/**
 * Re-run topic classification and scoring over every stored item inside the
 * collection window and persist the result. Useful after editing topics,
 * keywords or the mute list in radar.config.json.
 *
 *   node server/reclassify.mjs
 */
import { loadConfig } from "./config.js"
import { allItems, stats, updateItemMeta } from "./db.js"
import { enrich } from "./rank.js"

const config = loadConfig({ reload: true })
const weights = Object.fromEntries(config.sources.map((s) => [s.id, s.weight ?? 0]))

const pool = allItems().map((item) => ({
  ...item,
  sourceWeight: weights[item.sourceId] ?? 0,
}))

const enriched = enrich(pool, {
  topics: config.topics,
  mutedPatterns: config.scoring.muteKeywords,
})
const updated = updateItemMeta(enriched)

const spread = {}
for (const item of enriched) spread[item.primaryTopic] = (spread[item.primaryTopic] ?? 0) + 1

console.log(`reclassified ${updated} of ${pool.length} stored items`)
console.log("topics:", spread)
console.log("stats:", JSON.stringify(stats()))
