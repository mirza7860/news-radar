import { XMLParser } from "fast-xml-parser"
import { cleanSummary, decodeEntities, fingerprint, hostOf, stripHtml, toMillis, truncate } from "./text.js"

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
})

const USER_AGENT = "NewsRadar/1.0 (personal local reader)"

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(node) {
  if (node == null) return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (typeof node === "object") {
    if (typeof node["#text"] === "string") return node["#text"]
    if (typeof node["#text"] === "number") return String(node["#text"])
  }
  return ""
}

function linkOf(node) {
  if (node == null) return ""
  if (typeof node === "string") return node.trim()
  if (Array.isArray(node)) {
    const preferred =
      node.find((l) => l?.["@_rel"] === "alternate" && l?.["@_href"]) ??
      node.find((l) => l?.["@_href"] && !l["@_rel"]) ??
      node.find((l) => l?.["@_href"])
    return preferred ? String(preferred["@_" + "href"] ?? preferred["@_href"]).trim() : ""
  }
  if (typeof node === "object") {
    if (typeof node["@_href"] === "string") return node["@_href"].trim()
    return textOf(node).trim()
  }
  return ""
}

function authorOf(node) {
  const author = node?.author ?? node?.creator
  if (!author) return ""
  if (Array.isArray(author)) return textOf(author[0]).trim()
  return textOf(author).trim()
}

function dateOf(node) {
  return (
    toMillis(node?.published) ??
    toMillis(node?.updated) ??
    toMillis(node?.pubDate) ??
    toMillis(node?.date) ??
    toMillis(node?.issued) ??
    toMillis(node?.created) ??
    toMillis(textOf(node?.date)) ??
    null
  )
}

function bodyOf(node) {
  return (
    textOf(node?.encoded) ||
    textOf(node?.content) ||
    textOf(node?.summary) ||
    textOf(node?.description) ||
    textOf(node?.subtitle) ||
    ""
  )
}

/** Pull the entry list out of RSS 2.0, RSS 1.0/RDF and Atom documents. */
function extractEntries(doc) {
  const root = doc?.rss?.channel ?? doc?.feed ?? doc?.RDF ?? doc?.rdf ?? doc
  const channel = root?.channel ?? root
  const items = channel?.item ?? root?.item ?? root?.entry ?? channel?.entry
  return asArray(items)
}

export async function fetchFeed(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const body = await res.text()
  if (!body || body.length < 40) throw new Error("empty feed body")
  return body
}

export function parseFeed(xml) {
  let doc
  try {
    doc = parser.parse(xml)
  } catch (err) {
    throw new Error(`XML parse failed: ${err.message}`)
  }
  const entries = extractEntries(doc)
  if (!entries.length) throw new Error("no entries found in feed")
  return entries
}

export function normalizeEntry(entry, source, { summaryChars = 340 } = {}) {
  const title = stripHtml(textOf(entry.title) || textOf(entry.name) || "")
  if (!title) return null

  const url = linkOf(entry.link) || linkOf(entry.guid) || linkOf(entry.id) || ""
  const summary = truncate(cleanSummary(title, stripHtml(bodyOf(entry))), summaryChars)
  const published = dateOf(entry)

  return {
    title,
    url,
    author: stripHtml(authorOf(entry)),
    summary,
    publishedAt: published,
    sourceId: source.id,
    sourceName: source.name,
    sourceCategory: source.category ?? "other",
    sourceWeight: source.weight ?? 0,
    host: hostOf(url) || source.id,
  }
}

export async function collectFromSource(source, options = {}) {
  const { timeoutMs = 15000, maxPerSource = 25, summaryChars = 340 } = options
  const limit = Number.isFinite(source.limit) ? source.limit : maxPerSource
  const xml = await fetchFeed(source.url, { timeoutMs })
  const entries = parseFeed(xml)
  const items = []
  for (const entry of entries.slice(0, limit)) {
    const item = normalizeEntry(entry, source, { summaryChars })
    if (!item) continue
    item.id = fingerprint(source.id, item.url || item.title)
    if (item.publishedAt == null) item.publishedAt = Date.now()
    items.push(item)
  }
  if (!items.length) throw new Error("feed parsed but produced no usable items")
  return items
}

/** Run `worker` over `values` with a bounded number of in-flight promises. */
export async function mapPool(values, limit, worker) {
  const results = new Array(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), values.length || 1) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
