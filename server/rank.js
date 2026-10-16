import { cleanSummary, normalizeTitle, titleSimilarity } from "./text.js"

const RECENCY_TIERS = [
  [3, 30], [6, 26], [12, 20], [24, 12], [48, 5],
]

const SIGNAL_RULES = [
  [/[$€£]\s?\d[\d.,]*\s?(m|b|bn|billion|million)\b/i, 18],   // a concrete money figure
  [/\b(series [a-e]|seed round|valuation|acquir|merger|ipo)\b/i, 14],
  [/\b(raises|raised|funding|invest)\b/i, 12],
  [/\b(launch|launches|releases?|released|announc|unveil|ships?|debuts?)\b/i, 9],
  [/\b(open[- ]?source|open[- ]?weights?|apache 2|mit license)\b/i, 10],
  [/\b(api|sdk|pricing|rate limit|endpoint|mcp|integration)\b/i, 8],
  [/\b(benchmark|sota|state[- ]of[- ]the[- ]art|outperform|beats|score[sd]?)\b/i, 8],
  [/\b(agent|agentic|autonomous|tool[- ]calling|computer use)\b/i, 6],
  [/arxiv|paper|we (show|find|propose)|novel (method|architecture)/i, -6],
]

const NOISE_RULES = [
  [/\b(opinion|op-ed|editorial)\b/i, 10],
  [/\b(podcast|webinar|livestream|ama|q&a session)\b/i, 14],
  [/\b(top \d+|best \d+|roundup|weekly digest|newsletter)\b/i, 12],
  [/\b(how to|tutorial|guide|tips|tricks)\b/i, 10],
  [/\b(sponsored|advertorial|partner content|press release)\b/i, 16],
  [/\b(crossword|quiz|wordle)\b/i, 25],
]

export function classify(item, topics) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase()
  const matches = []
  for (const topic of topics) {
    let hits = 0
    for (const keyword of topic.keywords) {
      const needle = keyword.toLowerCase()
      if (!haystack.includes(needle)) continue
      hits += needle.includes(" ") ? 2 : 1
    }
    if (hits > 0) matches.push({ id: topic.id, hits })
  }
  matches.sort((a, b) => b.hits - a.hits)
  let primary = matches[0]?.id
  // Titles about a specific lab's release read as "industry" without this nudge.
  if (!primary) {
    primary = item.sourceCategory === "research" ? "research" : "industry"
  }
  return { primaryTopic: primary, topics: matches.slice(0, 3).map((m) => m.id) }
}

export function scoreItem(item, { mutedPatterns = [] } = {}) {
  const haystack = `${item.title} ${item.summary}`
  let score = 28

  const ageHours = (Date.now() - item.publishedAt) / 3600_000
  for (const [limit, points] of RECENCY_TIERS) {
    if (ageHours <= limit) {
      score += points
      break
    }
  }
  if (ageHours > 72) score -= 10

  score += Math.min(item.sourceWeight ?? 0, 20)

  for (const [pattern, points] of SIGNAL_RULES) if (pattern.test(haystack)) score += points
  for (const [pattern, points] of NOISE_RULES) if (pattern.test(haystack)) score -= points

  const lower = haystack.toLowerCase()
  for (const pattern of mutedPatterns) if (lower.includes(String(pattern).toLowerCase())) score -= 30

  // Reward titles that are specific rather than teasers.
  if (item.title.length < 25) score -= 6
  if (/^\[/.test(item.title)) score -= 4
  if (item.summary.length < 60) score -= 6

  return Math.max(0, Math.min(100, Math.round(score)))
}

export function enrich(items, { topics, mutedPatterns }) {
  return items.map((item) => {
    // Repair feed noise (bare URLs, HN footers, title echo) on every pass so
    // stored rows self-heal after a collector change.
    const summary = cleanSummary(item.title, item.summary)
    const prepared = { ...item, summary }
    const { primaryTopic, topics: matched } = classify(prepared, topics)
    const enriched = { ...prepared, primaryTopic, topics: matched }
    enriched.score = scoreItem(enriched, { mutedPatterns })
    return enriched
  })
}

/**
 * Collapse the same story reported by several outlets, keeping the strongest
 * version. Returns survivors only; merged duplicates are attached as `alsoOn`.
 */
export function dedupe(items, threshold = 0.62) {
  const sorted = [...items].sort(
    (a, b) => b.score - a.score || (b.sourceWeight ?? 0) - (a.sourceWeight ?? 0) || b.publishedAt - a.publishedAt,
  )
  const survivors = []
  const buckets = new Map()

  for (const item of sorted) {
    const normalized = normalizeTitle(item.title)
    const tokens = normalized.split(" ").filter((w) => w.length > 3).slice(0, 6)
    const key = tokens.slice(0, 3).join(" ")

    const nearby = new Set(buckets.get(key) ?? [])
    for (const token of tokens) for (const id of buckets.get(token) ?? []) nearby.add(id)

    let merged = false
    for (const index of nearby) {
      const candidate = survivors[index]
      if (!candidate) continue
      if (titleSimilarity(candidate.title, item.title) >= threshold) {
        candidate.alsoOn = candidate.alsoOn ?? []
        const alreadyCited = candidate.alsoOn.some((entry) => entry.source === item.sourceName)
        if (item.sourceId !== candidate.sourceId && !alreadyCited) {
          candidate.alsoOn.push({ source: item.sourceName, url: item.url })
        }
        merged = true
        break
      }
    }
    if (merged) continue

    const index = survivors.length
    survivors.push(item)
    for (const token of tokens) {
      const list = buckets.get(token) ?? []
      list.push(index)
      buckets.set(token, list)
    }
    const list = buckets.get(key) ?? []
    list.push(index)
    buckets.set(key, list)
  }

  return survivors
}

export function buildCandidateList(items, config) {
  const cutoff = Date.now() - config.collection.windowHours * 3600_000
  const fresh = items.filter((item) => item.publishedAt >= cutoff)
  const enriched = enrich(fresh, {
    topics: config.topics,
    mutedPatterns: config.scoring.muteKeywords,
  })
  const unique = dedupe(enriched)
  const ranked = [...unique].sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt)
  const capped = ranked.slice(0, config.collection.maxCandidates)
  // The curator reads newest-first; keep that order stable for the prompt.
  capped.sort((a, b) => b.publishedAt - a.publishedAt)
  return { candidates: capped, considered: unique.length, fresh: fresh.length }
}
