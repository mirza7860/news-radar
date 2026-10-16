import { loadConfig } from "./config.js"
import { collectFromSource, mapPool } from "./collect.js"
import { buildCandidateList, enrich } from "./rank.js"
import { curate } from "./curate.js"
import { fingerprint } from "./text.js"
import { emit } from "./bus.js"
import {
  itemsSince,
  markSourceHealth,
  recordBrief,
  runningScan,
  startScan,
  updateItemMeta,
  updateScan,
  upsertItems,
} from "./db.js"

let inFlight = null

export function isScanning() {
  return inFlight != null
}

export async function runScan({ trigger = "manual" } = {}) {
  if (inFlight) return inFlight
  inFlight = executeScan({ trigger }).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function executeScan({ trigger }) {
  const config = loadConfig()
  const id = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const startedAt = Date.now()
  startScan({ id, trigger })
  emit("scan.started", { id, trigger })

  const log = (step) => {
    updateScan(id, { step })
    emit("scan.step", { id, step })
  }

  try {
    log(`reading ${config.sources.length} sources`)
    const results = await mapPool(config.sources, config.collection.concurrency, async (source) => {
      const t0 = Date.now()
      try {
        const items = await collectFromSource(source, {
          timeoutMs: config.collection.feedTimeoutMs,
          maxPerSource: config.collection.maxPerSource,
          summaryChars: config.collection.summaryChars,
        })
        markSourceHealth(source, { ok: true, count: items.length, ms: Date.now() - t0 })
        return { source, ok: true, items, ms: Date.now() - t0 }
      } catch (err) {
        const message = String(err?.message ?? err).slice(0, 200)
        markSourceHealth(source, { ok: false, error: message })
        return { source, ok: false, items: [], error: message, ms: Date.now() - t0 }
      }
    })

    const okResults = results.filter((r) => r.ok)
    const failed = results.filter((r) => !r.ok)
    const collected = okResults.flatMap((r) => r.items).map((item) => ({ ...item, fetchedAt: Date.now() }))

    // Classify and score before storing, so the strip, the filters and the
    // database all agree on what kind of story this is.
    const classified = enrich(collected, {
      topics: config.topics,
      mutedPatterns: config.scoring.muteKeywords,
    })
    const itemsNew = upsertItems(classified)

    updateScan(id, {
      feeds_ok: okResults.length,
      feeds_failed: failed.length,
      items_seen: collected.length,
      items_new: itemsNew,
    })
    emit("scan.collected", {
      id,
      feedsOk: okResults.length,
      feedsFailed: failed.length,
      seen: collected.length,
      added: itemsNew,
      failures: failed.map((f) => ({ source: f.source.name, error: f.error })),
    })

    const weights = Object.fromEntries(config.sources.map((s) => [s.id, s.weight ?? 0]))
    const pool = itemsSince(config.collection.windowHours).map((item) => ({
      ...item,
      sourceWeight: weights[item.sourceId] ?? 0,
    }))

    // Re-enrich the whole window and persist it: this repairs rows written
    // before a topic or scoring change and keeps filters honest.
    const reclassified = enrich(pool, {
      topics: config.topics,
      mutedPatterns: config.scoring.muteKeywords,
    })
    updateItemMeta(reclassified)

    const enrichedPool = reclassified
    const { candidates, considered, fresh } = buildCandidateList(enrichedPool, config)
    emit("scan.ranked", { id, considered, fresh, candidates: candidates.length, pool: pool.length })

    if (!config.curator.enabled) {
      updateScan(id, { status: "ok", finished_at: Date.now(), step: "curation disabled" })
      emit("scan.finished", { id, status: "ok", note: "curation disabled" })
      return { id, status: "ok", itemsNew, candidates: candidates.length, note: "curation disabled" }
    }

    if (!candidates.length) {
      updateScan(id, { status: "ok", finished_at: Date.now(), step: "nothing new to curate" })
      emit("scan.finished", { id, status: "ok", note: "no candidates" })
      return { id, status: "ok", itemsNew, candidates: 0 }
    }

    const curateStart = Date.now()
    emit("scan.curating", { id, candidates: candidates.length, model: `${config.model.providerID}/${config.model.id}` })
    log(`curating with ${config.model.providerID}/${config.model.id}`)

    const outcome = await curate(candidates, config, { onStep: (step) => log(step) })
    const durationMs = Date.now() - curateStart

    const briefId = `brief_${startedAt}`
    const payload = outcome.ok
      ? outcome.brief
      : { headline: "", lead: null, sections: [], watchlist: [], failure: outcome.error, raw: (outcome.raw ?? "").slice(0, 4000) }

    recordBrief({
      id: briefId,
      createdAt: Date.now(),
      windowStart: candidates.length ? Math.min(...candidates.map((c) => c.publishedAt)) : null,
      windowEnd: Date.now(),
      model: outcome.model,
      headline: outcome.ok ? outcome.brief.headline : null,
      payload,
      itemCount: outcome.ok ? outcome.itemIds.length : 0,
      candidateCount: candidates.length,
      durationMs,
      status: outcome.ok ? "ok" : "error",
      error: outcome.ok ? null : outcome.error,
      itemIds: outcome.ok ? outcome.itemIds : [],
    })

    updateScan(id, {
      status: outcome.ok ? "ok" : "error",
      finished_at: Date.now(),
      brief_id: briefId,
      curate_ms: durationMs,
      error: outcome.ok ? null : outcome.error,
      step: outcome.ok ? "done" : "curation failed",
    })

    emit("scan.finished", {
      id,
      status: outcome.ok ? "ok" : "error",
      briefId,
      itemsNew,
      candidates: candidates.length,
      durationMs,
      error: outcome.ok ? null : outcome.error,
    })

    return { id, status: outcome.ok ? "ok" : "error", briefId, itemsNew, candidates: candidates.length }
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 400)
    updateScan(id, { status: "error", finished_at: Date.now(), error: message, step: "failed" })
    emit("scan.failed", { id, error: message })
    return { id, status: "error", error: message }
  }
}

export function scanStatus() {
  return { scanning: isScanning(), current: runningScan() ?? null }
}

export function newScanId() {
  return fingerprint(String(Date.now()), String(Math.random()))
}
