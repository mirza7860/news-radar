import { runScan } from "./scan.js"
import { bus } from "./bus.js"
import { latestScan, stats } from "./db.js"

const started = Date.now()

bus.on("event", (event) => {
  switch (event.type) {
    case "scan.started":
      console.log(`scan ${event.id} (${event.trigger})`)
      break
    case "scan.step":
      console.log(`  … ${event.step}`)
      break
    case "scan.collected":
      console.log(
        `  feeds: ${event.feedsOk} ok, ${event.feedsFailed} failed · ${event.seen} items seen, ${event.added} new`,
      )
      for (const f of event.failures ?? []) console.log(`      ! ${f.source}: ${f.error}`)
      break
    case "scan.ranked":
      console.log(`  pool ${event.pool} → ${event.considered} after dedupe → ${event.candidates} candidates`)
      break
    case "scan.curating":
      console.log(`  curating ${event.candidates} candidates with ${event.model}`)
      break
    case "scan.finished":
      console.log(`  finished: ${event.status}${event.error ? ` — ${event.error}` : ""} in ${event.durationMs ?? 0}ms`)
      break
    case "scan.failed":
      console.log(`  FAILED: ${event.error}`)
      break
    default:
      break
  }
})

const result = await runScan({ trigger: "cli" })
const scan = latestScan()
console.log("\nscan row:", JSON.stringify(scan, null, 2))
console.log("stats:", JSON.stringify(stats()))
console.log(`total ${Date.now() - started}ms`)
process.exit(result?.status === "error" ? 1 : 0)
