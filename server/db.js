import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { DATA_DIR } from "./config.js"

const DB_PATH = join(DATA_DIR, "radar.db")

export const db = new DatabaseSync(DB_PATH)

db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = NORMAL")
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  source_name    TEXT NOT NULL,
  source_category TEXT NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL,
  author         TEXT,
  summary        TEXT,
  published_at   INTEGER NOT NULL,
  fetched_at     INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  topics         TEXT NOT NULL DEFAULT '[]',
  primary_topic  TEXT NOT NULL DEFAULT 'industry',
  score          INTEGER NOT NULL DEFAULT 0,
  read_at        INTEGER,
  saved          INTEGER NOT NULL DEFAULT 0,
  brief_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_published ON items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_topic ON items (primary_topic);
CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_id);
CREATE INDEX IF NOT EXISTS idx_items_brief ON items (brief_id);

CREATE TABLE IF NOT EXISTS briefs (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  window_start  INTEGER,
  window_end    INTEGER,
  model         TEXT,
  headline      TEXT,
  payload       TEXT NOT NULL,
  item_count    INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  status        TEXT NOT NULL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs (created_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id           TEXT PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL,
  trigger      TEXT NOT NULL DEFAULT 'manual',
  feeds_ok     INTEGER NOT NULL DEFAULT 0,
  feeds_failed INTEGER NOT NULL DEFAULT 0,
  items_seen   INTEGER NOT NULL DEFAULT 0,
  items_new    INTEGER NOT NULL DEFAULT 0,
  brief_id     TEXT,
  curate_ms    INTEGER,
  error        TEXT,
  step         TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_started ON scans (started_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  category   TEXT,
  last_ok    INTEGER,
  last_error TEXT,
  last_count INTEGER,
  last_ms    INTEGER
);
`)

const statements = {
  insertItem: db.prepare(`
    INSERT INTO items (
      id, source_id, source_name, source_category, title, url, author, summary,
      published_at, fetched_at, first_seen_at, topics, primary_topic, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      url = excluded.url,
      published_at = excluded.published_at,
      fetched_at = excluded.fetched_at,
      score = excluded.score,
      topics = excluded.topics,
      primary_topic = excluded.primary_topic
  `),
  itemExists: db.prepare("SELECT id, first_seen_at FROM items WHERE id = ?"),
  setBriefForItems: db.prepare("UPDATE items SET brief_id = ? WHERE id = ?"),
  upsertSource: db.prepare(`
    INSERT INTO source_health (id, name, url, category, last_ok, last_count, last_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, url = excluded.url, category = excluded.category,
      last_ok = excluded.last_ok, last_count = excluded.last_count,
      last_ms = excluded.last_ms, last_error = NULL
  `),
  failSource: db.prepare(`
    INSERT INTO source_health (id, name, url, category, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, url = excluded.url, category = excluded.category,
      last_error = excluded.last_error
  `),
}

export function upsertItems(items) {
  let added = 0
  for (const item of items) {
    const existing = statements.itemExists.get(item.id)
    if (!existing) added += 1
    statements.insertItem.run(
      item.id,
      item.sourceId,
      item.sourceName,
      item.sourceCategory ?? "other",
      item.title,
      item.url,
      item.author ?? "",
      item.summary ?? "",
      item.publishedAt,
      item.fetchedAt ?? Date.now(),
      existing?.first_seen_at ?? Date.now(),
      JSON.stringify(item.topics ?? []),
      item.primaryTopic ?? "industry",
      item.score ?? 0,
    )
  }
  return added
}

/**
 * Write classifier output back onto items. Called every scan so rows stored
 * before a topic or scoring change are corrected rather than left stale.
 */
export function updateItemMeta(items) {
  const stmt = db.prepare(
    "UPDATE items SET topics = ?, primary_topic = ?, score = ?, summary = ? WHERE id = ?",
  )
  let updated = 0
  for (const item of items) {
    if (!item.primaryTopic) continue
    updated +=
      stmt.run(
        JSON.stringify(item.topics ?? []),
        item.primaryTopic,
        item.score ?? 0,
        item.summary ?? "",
        item.id,
      ).changes ?? 0
  }
  return updated
}

export function markSourceHealth(source, { ok, count, ms, error }) {
  if (ok) {
    statements.upsertSource.run(source.id, source.name, source.url, source.category ?? "", Date.now(), count, ms)
  } else {
    statements.failSource.run(source.id, source.name, source.url, source.category ?? "", error ?? "unknown error")
  }
}

export function recordBrief(brief) {
  db.prepare(
    `INSERT INTO briefs (id, created_at, window_start, window_end, model, headline, payload,
       item_count, candidate_count, duration_ms, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    brief.id,
    brief.createdAt,
    brief.windowStart ?? null,
    brief.windowEnd ?? null,
    brief.model ?? null,
    brief.headline ?? null,
    JSON.stringify(brief.payload ?? {}),
    brief.itemCount ?? 0,
    brief.candidateCount ?? 0,
    brief.durationMs ?? null,
    brief.status,
    brief.error ?? null,
  )
  if (brief.status === "ok" && Array.isArray(brief.itemIds)) {
    for (const id of brief.itemIds) statements.setBriefForItems.run(brief.id, id)
  }
}

export function startScan({ id, trigger }) {
  db.prepare(
    "INSERT INTO scans (id, started_at, status, trigger, step) VALUES (?, ?, 'running', ?, 'collecting')",
  ).run(id, Date.now(), trigger)
}

export function updateScan(id, patch) {
  const columns = {
    status: "status",
    step: "step",
    finished_at: "finished_at",
    feeds_ok: "feeds_ok",
    feeds_failed: "feeds_failed",
    items_seen: "items_seen",
    items_new: "items_new",
    brief_id: "brief_id",
    curate_ms: "curate_ms",
    error: "error",
  }
  const entries = Object.entries(patch).filter(([k]) => k in columns)
  if (!entries.length) return
  const sql = `UPDATE scans SET ${entries.map(([k]) => `${columns[k]} = ?`).join(", ")} WHERE id = ?`
  db.prepare(sql).run(...entries.map(([, v]) => v ?? null), id)
}

export function latestScan() {
  return db.prepare("SELECT * FROM scans ORDER BY started_at DESC LIMIT 1").get() ?? null
}

export function runningScan() {
  return db.prepare("SELECT * FROM scans WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() ?? null
}

export function latestBrief() {
  // Return the newest brief whatever its status, so a failed curation is
  // visible in the UI rather than looking like nothing ever ran.
  const row = db.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT 1").get()
  return row ? hydrateBrief(row) : null
}

export function getBrief(id) {
  const row = db.prepare("SELECT * FROM briefs WHERE id = ?").get(id)
  return row ? hydrateBrief(row) : null
}

export function listBriefs(limit = 30) {
  return db
    .prepare("SELECT id, created_at, headline, item_count, status, model FROM briefs ORDER BY created_at DESC LIMIT ?")
    .all(limit)
}

function hydrateBrief(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    model: row.model,
    headline: row.headline,
    itemCount: row.item_count,
    candidateCount: row.candidate_count,
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error,
    payload: safeParse(row.payload, {}),
  }
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function getItemsByIds(ids) {
  if (!ids.length) return []
  const unique = [...new Set(ids)]
  const placeholders = unique.map(() => "?").join(", ")
  const rows = db
    .prepare(`SELECT * FROM items WHERE id IN (${placeholders})`)
    .all(...unique)
  return rows.map(hydrateItem)
}

export function queryItems({ topic, source, q, hours, saved, unread, limit = 200, offset = 0 } = {}) {
  const where = []
  const args = []
  if (topic && topic !== "all") {
    where.push("primary_topic = ?")
    args.push(topic)
  }
  if (source && source !== "all") {
    where.push("source_id = ?")
    args.push(source)
  }
  if (q) {
    where.push("(title LIKE ? OR summary LIKE ? OR source_name LIKE ?)")
    const like = `%${q}%`
    args.push(like, like, like)
  }
  if (hours) {
    where.push("published_at >= ?")
    args.push(Date.now() - hours * 3600_000)
  }
  if (saved) where.push("saved = 1")
  if (unread) where.push("read_at IS NULL")

  const sql = `SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY published_at DESC LIMIT ? OFFSET ?`
  return db.prepare(sql).all(...args, limit, offset).map(hydrateItem)
}

export function itemsSince(hours, limit = 800) {
  return db
    .prepare("SELECT * FROM items WHERE published_at >= ? ORDER BY published_at DESC LIMIT ?")
    .all(Date.now() - hours * 3600_000, limit)
    .map(hydrateItem)
}

/** Every stored item, newest first. Used by maintenance passes that backfill the whole store. */
export function allItems(limit = 20000) {
  return db.prepare("SELECT * FROM items ORDER BY published_at DESC LIMIT ?").all(limit).map(hydrateItem)
}

export function hydrateItem(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceCategory: row.source_category,
    title: row.title,
    url: row.url,
    author: row.author,
    summary: row.summary,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    topics: safeParse(row.topics, []),
    topic: row.primary_topic,
    score: row.score,
    read: row.read_at != null,
    saved: row.saved === 1,
    briefId: row.brief_id,
  }
}

export function setItemState(id, { read, saved }) {
  if (read !== undefined) db.prepare("UPDATE items SET read_at = ? WHERE id = ?").run(read ? Date.now() : null, id)
  if (saved !== undefined) db.prepare("UPDATE items SET saved = ? WHERE id = ?").run(saved ? 1 : 0, id)
}

export function markAllRead(ids) {
  const stmt = db.prepare("UPDATE items SET read_at = ? WHERE id = ? AND read_at IS NULL")
  const now = Date.now()
  let touched = 0
  for (const id of ids) touched += stmt.run(now, id).changes ?? 0
  return touched
}

export function stats() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM items").get().n
  const last24 = db.prepare("SELECT COUNT(*) AS n FROM items WHERE published_at >= ?").get(Date.now() - 86400_000).n
  const unread = db.prepare("SELECT COUNT(*) AS n FROM items WHERE read_at IS NULL").get().n
  const saved = db.prepare("SELECT COUNT(*) AS n FROM items WHERE saved = 1").get().n
  const byTopic = db
    .prepare("SELECT primary_topic AS topic, COUNT(*) AS n FROM items WHERE published_at >= ? GROUP BY primary_topic")
    .all(Date.now() - 86400_000)
  const byCategory = db
    .prepare("SELECT source_category AS category, COUNT(*) AS n FROM items WHERE published_at >= ? GROUP BY source_category")
    .all(Date.now() - 86400_000)
  return { total, last24h: last24, unread, saved, byTopic, byCategory }
}

export function sourceHealth() {
  return db.prepare("SELECT * FROM source_health ORDER BY name").all()
}

export function timeline(hours = 24, buckets = 48) {
  const now = Date.now()
  const from = now - hours * 3600_000
  const width = (hours * 3600_000) / buckets
  const items = db
    .prepare("SELECT id, title, url, published_at, primary_topic, score, source_name FROM items WHERE published_at >= ? ORDER BY published_at ASC")
    .all(from)
  const slots = Array.from({ length: buckets }, (_, i) => ({
    start: from + i * width,
    items: [],
  }))
  for (const item of items) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((item.published_at - from) / width)))
    slots[index].items.push({
      id: item.id,
      title: item.title,
      url: item.url,
      topic: item.primary_topic,
      score: item.score,
      source: item.source_name,
      publishedAt: item.published_at,
    })
  }
  return { from, to: now, bucketMs: width, slots: slots.map((s) => ({ start: s.start, items: s.items })) }
}

export function pruneHistory({ keepItemsDays = 60, keepBriefsDays = 90 } = {}) {
  const itemCutoff = Date.now() - keepItemsDays * 86400_000
  const briefCutoff = Date.now() - keepBriefsDays * 86400_000
  const items = db.prepare("DELETE FROM items WHERE published_at < ? AND saved = 0").run(itemCutoff).changes
  const briefs = db.prepare("DELETE FROM briefs WHERE created_at < ?").run(briefCutoff).changes
  const scans = db.prepare("DELETE FROM scans WHERE started_at < ?").run(briefCutoff).changes
  return { items, briefs, scans }
}
