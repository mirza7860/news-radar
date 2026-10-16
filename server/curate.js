import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { ROOT } from "./config.js"
import { extractJson } from "./json.js"
import { truncate } from "./text.js"

export const SECTION_ORDER = ["models", "funding", "agents", "platforms", "research", "industry"]

const AGENT_PATH = join(ROOT, ".opencode", "agents", "radar.md")
const CURATOR_AGENT = "radar"

let clientPromise = null
let promptCache = null

/**
 * Connect to the OpenCode background service. The service is discovered and, if
 * it is not already running, started by the client itself.
 */
export async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const endpoint = await Service.ensure()
      return OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      })
    })().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

/** The curator's instructions live in one place: the radar agent's markdown body. */
export function loadCuratorPrompt() {
  if (promptCache) return promptCache
  const raw = readFileSync(AGENT_PATH, "utf8")
  const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  promptCache = withoutFrontmatter.trim()
  return promptCache
}

/**
 * Free `opencode/*` models are only served when a request looks like a stock
 * OpenCode session. A session-level agent or permission override makes the
 * gateway treat it as third-party traffic and refuse it, so those models run in
 * "plain" mode with the instructions inlined into the prompt. Providers the user
 * has configured directly (nvidia, agentrouter, ...) carry no such restriction,
 * so there the session is locked down to the tool-free curator agent instead.
 */
export function curatorMode(model) {
  if (model?.mode === "plain" || model?.mode === "locked") return model.mode
  return model?.providerID === "opencode" ? "plain" : "locked"
}

export async function listModels() {
  const client = await getClient()
  const res = await client.model.list({})
  const models = res.data?.models ?? res.data ?? []
  return (Array.isArray(models) ? models : Object.values(models)).map((m) => ({
    providerID: m.providerID,
    id: m.modelID,
    name: m.name,
    cost: m.cost?.[0] ?? null,
    status: m.status,
  }))
}

export async function defaultModel() {
  const client = await getClient()
  const res = await client.model.default({})
  const m = res?.data
  if (!m) return null
  return { providerID: m.providerID, id: m.modelID, name: m.name }
}

function humanAge(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function renderItem(item, index) {
  const summary = truncate(item.summary, 300)
  const also = item.alsoOn?.length ? ` | also: ${item.alsoOn.map((a) => a.source).join(", ")}` : ""
  return `[${index}] id=${item.id} | ${item.sourceName} | ${humanAge(item.publishedAt)} | ${item.title} | ${summary}${also}`
}

export function buildPrompt(candidates, { now = new Date() } = {}) {
  const windowStart = new Date(Math.min(...candidates.map((c) => c.publishedAt)))
  return [
    `Scan window: ${windowStart.toISOString()} to ${now.toISOString()}`,
    `Candidates: ${candidates.length}`,
    "",
    candidates.map((item, i) => renderItem(item, i + 1)).join("\n"),
  ].join("\n")
}

/** Map the curator's item numbers back onto real item records. */
export function resolveBrief(parsed, candidates) {
  const byNumber = new Map(candidates.map((item, i) => [i + 1, item]))
  const used = new Set()

  const take = (rawId) => {
    const n = Number.parseInt(rawId, 10)
    const item = byNumber.get(n)
    if (!item || used.has(n)) return null
    used.add(n)
    return item
  }

  const leadItem = parsed?.lead ? take(parsed.lead.itemId) : null

  /**
   * Cross-references come from two places: the numbers the curator listed, and
   * the syndicated outlets the dedupe pass already attached to the item. Merge
   * both, then keep at most one entry per source so the UI never repeats itself.
   */
  const alsoFor = (entry, item) => {
    const seenNumbers = new Set()
    const seenSources = new Set([String(item.sourceName ?? "").toLowerCase()])
    const out = []
    const add = (candidateItem, fallback = null) => {
      const source = candidateItem?.sourceName ?? fallback?.source ?? ""
      const key = String(source).toLowerCase()
      if (!source || seenSources.has(key)) return
      seenSources.add(key)
      out.push({
        title: candidateItem?.title ?? fallback?.title ?? "",
        url: candidateItem?.url ?? fallback?.url ?? "",
        source,
      })
    }
    for (const raw of Array.isArray(entry?.alsoCoveredBy) ? entry.alsoCoveredBy : []) {
      const n = Number.parseInt(raw, 10)
      if (seenNumbers.has(n)) continue
      seenNumbers.add(n)
      add(byNumber.get(n))
    }
    for (const on of item.alsoOn ?? []) add(null, on)
    return out
  }

  const sections = []
  for (const section of Array.isArray(parsed?.sections) ? parsed.sections : []) {
    if (!SECTION_ORDER.includes(section?.id)) continue
    const entries = []
    for (const entry of Array.isArray(section?.entries) ? section.entries : []) {
      const item = take(entry?.itemId)
      if (!item) continue
      entries.push({
        item,
        note: truncate(String(entry?.note ?? ""), 220),
        alsoCoveredBy: alsoFor(entry, item),
      })
    }
    if (entries.length) sections.push({ id: section.id, entries })
  }
  sections.sort((a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id))

  return {
    headline: truncate(String(parsed?.headline ?? ""), 140),
    lead: leadItem
      ? {
          item: leadItem,
          why: truncate(String(parsed?.lead?.why ?? ""), 700),
          context: truncate(String(parsed?.lead?.context ?? ""), 300),
        }
      : null,
    sections,
    watchlist: (Array.isArray(parsed?.watchlist) ? parsed.watchlist : [])
      .map((line) => truncate(String(line), 180))
      .filter(Boolean)
      .slice(0, 3),
  }
}

export async function curate(candidates, config, { onStep = () => {} } = {}) {
  const client = await getClient()
  const model = config.model
  const mode = curatorMode(model)
  const dataPrompt = buildPrompt(candidates)

  onStep(`opening curator session (${mode} mode)`)

  const session = await client.session.create({
    location: { directory: ROOT },
    title: `radar scan ${new Date().toISOString().slice(0, 16)}`,
    model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) },
    ...(mode === "locked"
      ? { agent: CURATOR_AGENT, permissions: [{ action: "*", resource: "*", effect: "deny" }] }
      : {}),
  })

  // In plain mode the agent override is unavailable, so the same instructions
  // are prepended inline. One source of truth either way.
  const prompt = mode === "plain" ? `${loadCuratorPrompt()}\n\n---\n\n${dataPrompt}` : dataPrompt
  onStep(`asking curator (${candidates.length} candidates, ${prompt.length} chars)`)

  let text = ""
  let failure = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.curator.timeoutMs)
  try {
    const result = await client.session.generate(
      { sessionID: session.id, prompt },
      { signal: controller.signal },
    )
    text = typeof result === "string" ? result : (result?.text ?? "")
  } catch (err) {
    failure = err
  } finally {
    clearTimeout(timer)
  }

  const parsed = failure ? null : extractJson(text)
  if (failure || !parsed) {
    return {
      ok: false,
      error: failure
        ? String(failure.message ?? failure)
        : `curator reply was not JSON: ${text.slice(0, 200)}`,
      sessionID: session.id,
      raw: text,
      model: `${model.providerID}/${model.id}`,
      mode,
    }
  }

  const resolved = resolveBrief(parsed, candidates)
  const usedIds = new Set()
  if (resolved.lead) usedIds.add(resolved.lead.item.id)
  for (const section of resolved.sections) {
    for (const entry of section.entries) usedIds.add(entry.item.id)
  }

  return {
    ok: true,
    brief: resolved,
    itemIds: [...usedIds],
    sessionID: session.id,
    raw: text,
    model: `${model.providerID}/${model.id}`,
    mode,
  }
}
