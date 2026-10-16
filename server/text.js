import { createHash } from "node:crypto"

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", rsquo: "\u2019",
  lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d", middot: "\u00b7",
  bull: "\u2022", times: "\u00d7", laquo: "\u00ab", raquo: "\u00bb",
}

export function decodeEntities(input = "") {
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase()
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m
    })
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

export function stripHtml(input = "") {
  let text = String(input)
  // Drop script/style bodies outright, then comments, then tags.
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  text = text.replace(/<!--[\s\S]*?-->/g, " ")
  text = text.replace(/<br\s*\/?>/gi, " ")
  text = text.replace(/<\/p>/gi, " ")
  text = text.replace(/<[^>]+>/g, " ")
  text = decodeEntities(text)
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Feed descriptions are frequently junk: bare URLs, Hacker News comment
 * footers ("Comments URL: … Points: 862 # Comments: 431"), or the title
 * repeated verbatim. Strip all of it, then return "" when nothing of value
 * is left so the UI can simply omit the summary line.
 */
export function cleanSummary(title, summary) {
  let text = String(summary ?? "")
  if (!text) return ""
  // Hacker News / aggregator footers: "Article URL: … Comments URL: … Points: … # Comments: …"
  text = text.replace(/\b(?:article|story|link|video|comments?)\s*url:\s*\S+/gi, " ")
  text = text.replace(/#?\s*comments?:\s*\d+/gi, " ")
  text = text.replace(/\bpoints:\s*\d+/gi, " ")
  // Bare URLs, including ones glued to punctuation.
  text = text.replace(/https?:\/\/\S+/gi, " ")
  text = decodeEntities(text).replace(/\s+/g, " ").trim()
  // Trim leftover connector words, dangling labels, and edge punctuation.
  text = text
    .replace(/^(?:article|story|link|video|comments?)\s*url\b[:.]?\s*/i, "")
    .replace(/^[\s\-–—:;,.|/]+/, "")
    .replace(/[\s\-–—:;,.|/]+$/, "")
    .replace(/^(from|via|by)\s+/i, "")
    .trim()

  if (!text) return ""
  const t = normalizeTitle(title)
  const s = normalizeTitle(text)
  if (!s) return ""
  // The description is just the headline again (possibly with a suffix).
  if (s === t || (t && s.startsWith(t) && s.length <= t.length + 24)) return ""
  // Or the headline is a prefix of a summary that adds nothing but stopwords.
  return text
}

export function truncate(text, chars) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim()
  if (clean.length <= chars) return clean
  const cut = clean.slice(0, chars)
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "))
  if (lastStop > chars * 0.5) return cut.slice(0, lastStop + 1)
  return `${cut.trimEnd()}\u2026`
}

/** Aggressive normalisation so "OpenAI ships GPT-6!" and "openai ships gpt 6" collapse. */
export function normalizeTitle(title = "") {
  return String(title)
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function fingerprint(...parts) {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16)
}

/**
 * Cheap token-overlap similarity. Used to collapse the same story syndicated
 * across several outlets before the curator ever sees it.
 */
export function titleSimilarity(a, b) {
  const A = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2))
  const B = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2))
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared += 1
  return shared / Math.min(A.size, B.size)
}

export function toMillis(value) {
  if (value == null) return null
  if (typeof value === "number") {
    // Seconds vs milliseconds heuristic.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
