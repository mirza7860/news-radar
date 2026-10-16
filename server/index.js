import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { ROOT, loadConfig, saveConfigJson } from "./config.js"
import { bus, emit } from "./bus.js"
import { runScan, scanStatus } from "./scan.js"
import { defaultModel, listModels } from "./curate.js"
import {
  getBrief,
  getItemsByIds,
  latestBrief,
  latestScan,
  listBriefs,
  markAllRead,
  pruneHistory,
  queryItems,
  setItemState,
  sourceHealth,
  stats,
  timeline,
} from "./db.js"

const PUBLIC_DIR = join(ROOT, "public")
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return {}
  }
}

async function serveStatic(res, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
  const target = resolve(PUBLIC_DIR, relative === "" ? "index.html" : relative)
  if (!target.startsWith(resolve(PUBLIC_DIR))) {
    res.writeHead(403).end("forbidden")
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error("not a file")
    const body = await readFile(target)
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    })
    res.end(body)
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  }
}

function bootstrap() {
  const config = loadConfig()
  return {
    brief: latestBrief(),
    timeline: timeline(24, 48),
    stats: stats(),
    scan: { ...scanStatus(), last: latestScan() },
    sources: sourceHealth(),
    sourceCount: config.sources.length,
    refreshMinutes: config.refreshMinutes,
    model: config.model,
    topics: config.topics.map(({ id, name, color }) => ({ id, name, color })),
    serverTime: Date.now(),
  }
}

const routes = {
  "GET /api/bootstrap": async (_req, res) => sendJson(res, 200, bootstrap()),

  "GET /api/timeline": async (req, res, url) => {
    const hours = Number(url.searchParams.get("hours") ?? 24)
    sendJson(res, 200, timeline(Number.isFinite(hours) ? hours : 24, 48))
  },

  "GET /api/items": async (_req, res, url) => {
    const items = queryItems({
      topic: url.searchParams.get("topic") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      hours: url.searchParams.get("hours") ? Number(url.searchParams.get("hours")) : undefined,
      saved: url.searchParams.get("saved") === "1",
      unread: url.searchParams.get("unread") === "1",
      limit: Math.min(Number(url.searchParams.get("limit") ?? 150), 500),
      offset: Number(url.searchParams.get("offset") ?? 0),
    })
    sendJson(res, 200, { items })
  },

  "GET /api/briefs": async (_req, res) => sendJson(res, 200, { briefs: listBriefs(40) }),

  "POST /api/scan": async (_req, res) => {
    if (scanStatus().scanning) {
      sendJson(res, 202, { started: false, reason: "a scan is already running" })
      return
    }
    sendJson(res, 202, { started: true })
    setImmediate(() => runScan({ trigger: "manual" }).catch(() => {}))
  },

  "POST /api/items/read": async (req, res) => {
    const body = await readBody(req)
    const ids = Array.isArray(body.ids) ? body.ids : []
    sendJson(res, 200, { updated: markAllRead(ids) })
  },

  "POST /api/maintenance/prune": async (_req, res) => sendJson(res, 200, pruneHistory()),
}

async function handleItemRoutes(req, res, pathname) {
  const match = pathname.match(/^\/api\/items\/([^/]+)$/)
  if (!match || req.method !== "POST") return false
  const id = decodeURIComponent(match[1])
  const body = await readBody(req)
  const patch = {}
  if (body.read !== undefined) patch.read = Boolean(body.read)
  if (body.saved !== undefined) patch.saved = Boolean(body.saved)
  setItemState(id, patch)
  sendJson(res, 200, { id, ...patch })
  return true
}

async function handleConfigRoute(req, res) {
  if (req.method !== "POST") return false
  const body = await readBody(req)
  const patch = {}
  if (body.model?.providerID && body.model?.id) {
    patch.model = {
      providerID: String(body.model.providerID),
      id: String(body.model.id),
      variant: body.model.variant ?? null,
    }
  }
  if (body.refreshMinutes != null) {
    const minutes = Number(body.refreshMinutes)
    if (Number.isFinite(minutes) && minutes >= 5) patch.refreshMinutes = Math.round(minutes)
  }
  if (body.curator?.enabled != null) patch.curator = { enabled: Boolean(body.curator.enabled) }
  if (Object.keys(patch).length) {
    saveConfigJson(patch)
    emit("config.updated", { patch })
  }
  sendJson(res, 200, bootstrap())
  return true
}

async function handleBriefRoutes(req, res, url, pathname) {
  const match = pathname.match(/^\/api\/briefs\/(.+)$/)
  if (!match) return false
  const brief = getBrief(decodeURIComponent(match[1]))
  if (!brief) {
    sendJson(res, 404, { error: "brief not found" })
    return true
  }
  // Resolve referenced items so the client can render without a second pass.
  const ids = []
  if (brief.payload?.lead?.item?.id) ids.push(brief.payload.lead.item.id)
  for (const section of brief.payload?.sections ?? []) {
    for (const entry of section.entries ?? []) ids.push(entry.item?.id)
  }
  const items = getItemsByIds(ids.filter(Boolean))
  sendJson(res, 200, { brief, items })
  return true
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(`retry: 3000\n\n`)
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`)

  const listener = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  bus.on("event", listener)
  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 25000)

  req.on("close", () => {
    clearInterval(keepAlive)
    bus.off("event", listener)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const pathname = url.pathname

  try {
    if (req.method === "GET" && pathname === "/api/events") return handleEvents(req, res)
    if (req.method === "GET" && pathname === "/api/models") {
      const [models, fallback] = await Promise.all([listModels(), defaultModel()])
      return sendJson(res, 200, { models, default: fallback })
    }
    if (pathname.startsWith("/api/briefs/") && req.method === "GET") {
      if (await handleBriefRoutes(req, res, url, pathname)) return
    }
    if (pathname.startsWith("/api/items/") && req.method === "POST") {
      if (await handleItemRoutes(req, res, pathname)) return
    }
    if (pathname === "/api/config" && req.method === "POST") {
      if (await handleConfigRoute(req, res)) return
    }

    const key = `${req.method} ${pathname}`
    const handler = routes[key]
    if (handler) return handler(req, res, url)

    if (req.method === "GET") return serveStatic(res, pathname)

    sendJson(res, 404, { error: "no such route" })
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) })
  }
})

const config = loadConfig()
const port = Number(process.env.PORT ?? config.port)

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  AI Radar  ·  http://127.0.0.1:${port}`)
  console.log(`  ${config.sources.length} sources · refresh every ${config.refreshMinutes}m · model ${config.model.providerID}/${config.model.id}\n`)
})

// --- scheduler -------------------------------------------------------------

function msUntilDue() {
  const cfg = loadConfig()
  const last = latestScan()
  if (!last?.started_at) return 3000
  return Math.max(0, last.started_at + cfg.refreshMinutes * 60_000 - Date.now())
}

let timer = null
function schedule() {
  clearTimeout(timer)
  const wait = Math.max(msUntilDue(), 5000)
  timer = setTimeout(async () => {
    if (!scanStatus().scanning) {
      try {
        await runScan({ trigger: "scheduled" })
      } catch (err) {
        console.error("scheduled scan failed:", err?.message ?? err)
      }
    }
    schedule()
  }, wait)
}

if (config.autoScanOnBoot && msUntilDue() < 30_000) {
  setTimeout(() => runScan({ trigger: "boot" }).catch(() => {}), 1500)
}
schedule()

setInterval(() => {
  try {
    pruneHistory()
  } catch {
    /* pruning is best effort */
  }
}, 12 * 3600_000)

process.on("SIGINT", () => {
  console.log("\n  shutting down")
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000)
})
