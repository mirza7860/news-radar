/* AI Radar — client. Renders the brief, the 24-hour strip, and Explore. */

const state = {
  brief: null,
  briefItems: new Map(),
  timeline: null,
  stats: null,
  scan: null,
  topics: [],
  topicMap: {},
  sources: [],
  refreshMinutes: 60,
  model: null,
  view: "brief",
  items: [],
  filters: { topic: "all", source: "all", q: "", unread: false, saved: false },
  limit: 120,
  scanning: false,
  notFound: new Set(),
}

const el = (id) => document.getElementById(id)
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c])

const isBareUrl = (value) => /^https?:\/\/\S+$/i.test(String(value ?? "").trim())
const normText = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ")

/** A title that is only a raw link is useless in a list; fall back to its host. */
function displayTitle(item) {
  const title = String(item?.title ?? "").trim()
  if (!isBareUrl(title)) return title
  try {
    return new URL(title).hostname.replace(/^www\./, "")
  } catch {
    return item?.sourceName ?? "Untitled"
  }
}

/** Never render a description that only parrots the headline back. */
function displaySummary(item) {
  const summary = String(item?.summary ?? "").trim()
  if (!summary) return ""
  const t = normText(item?.title)
  const s = normText(summary)
  if (!s || s === t || (t && s.startsWith(t) && s.length <= t.length + 24)) return ""
  return summary
}

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days}d ago`
}

function shortTime(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 60) return "now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function stamp(ts) {
  const date = new Date(ts)
  const day = date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })
  return `${day}, ${clock(ts)}`
}

function dayLabel(ts) {
  const date = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })
}

function topicColor(id) {
  return state.topicMap[id]?.color ?? "var(--ink-3)"
}
function topicName(id) {
  return state.topicMap[id]?.name ?? "Other"
}

/* --- data ---------------------------------------------------------------- */

async function api(path, options) {
  const res = await fetch(path, options)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap")
  state.brief = data.brief
  state.timeline = data.timeline
  state.stats = data.stats
  state.scan = data.scan
  state.topics = data.topics
  state.topicMap = Object.fromEntries(data.topics.map((t) => [t.id, t]))
  state.sources = data.sources
  state.refreshMinutes = data.refreshMinutes
  state.model = data.model
  state.scanning = Boolean(data.scan?.scanning)

  if (state.brief?.id && state.brief.id !== state.briefItems.briefId) {
    state.briefItems = new Map()
    state.briefItems.briefId = state.brief.id
    try {
      const detail = await api(`/api/briefs/${encodeURIComponent(state.brief.id)}`)
      for (const item of detail.items) state.briefItems.set(item.id, item)
    } catch {
      /* the payload already carries the item records */
    }
  }
  render()
}

/* --- render: status ------------------------------------------------------ */

function renderStatus() {
  const node = el("status")
  const last = state.scan?.last
  const dot = (cls) => `<span class="status-dot ${cls}"></span>`

  if (state.scanning) {
    node.innerHTML = `${dot("is-live")}<span>${esc(state.scanStep ?? "Scanning")}</span>`
    el("scan-now").disabled = true
    el("scan-now").textContent = "Scanning…"
    return
  }

  el("scan-now").disabled = false
  el("scan-now").textContent = "Scan now"

  const brief = state.brief
  if (!brief && !last) {
    node.innerHTML = `${dot("is-live")}<span>No scan has run yet. Starting one now.</span>`
    el("brand-sub").textContent = "first scan starting"
    return
  }

  const when = last ? timeAgo(last.started_at) : "never"
  const failed = last?.status === "error"
  const parts = [`Last scan ${when}`]
  if (last) {
    parts.push(`${last.items_new} new of ${last.items_seen} collected`)
    if (last.feeds_failed) parts.push(`${last.feeds_failed} source${last.feeds_failed === 1 ? "" : "s"} unreachable`)
  }
  if (brief?.status === "error") parts.push("curation failed")
  else if (brief && failed) parts.push("curation failed")

  node.innerHTML = `${dot(failed ? "is-error" : "is-live")}<span>${esc(parts.join(". "))}.</span>`
  el("brand-sub").textContent = state.stats
    ? `${state.stats.last24h} stories in the last 24 hours`
    : "ready"
}

/* --- render: strip ------------------------------------------------------- */

function renderStrip() {
  const strip = el("strip")
  const axis = el("strip-axis")
  const timeline = state.timeline
  if (!timeline?.slots?.length) {
    strip.innerHTML = ""
    axis.innerHTML = ""
    return
  }

  const slots = timeline.slots
  const bucketMinutes = Math.round(timeline.bucketMs / 60000)

  strip.innerHTML = slots
    .map((slot, index) => {
      const items = [...slot.items].sort((a, b) => b.score - a.score).slice(0, 8)
      const delay = `--d:${index * 13}ms`
      if (!items.length) return `<span class="slot is-empty" style="${delay}"></span>`
      const bars = items
        .map(
          (item) =>
            `<span class="bar" style="--h:${3 + Math.round(item.score / 24)}px;--c:${topicColor(item.topic)}"></span>`,
        )
        .join("")
      return `<button class="slot" data-slot="${index}" style="${delay}" aria-label="${esc(
        `${items.length} ${items.length === 1 ? "story" : "stories"} at ${clock(slot.start)}`,
      )}">${bars}</button>`
    })
    .join("")

  const labelIndexes = [0, 12, 24, 36]
  axis.innerHTML = labelIndexes
    .map((index) => {
      const pct = ((index + 0.5) / slots.length) * 100
      const ts = timeline.from + index * timeline.bucketMs
      return `<span class="axis-label" style="left:${pct}%">${clock(ts)}</span>`
    })
    .join("")

  const total = slots.reduce((sum, slot) => sum + slot.items.length, 0)
  el("strip-caption").textContent = `${total} stories collected in the last 24 hours. Every bar is one story, as tall as its signal score and coloured by topic. Hover an hour to read that window.`

  strip.dataset.bucketMinutes = String(bucketMinutes)
}

let tipTimer = null

function showTip(slotIndex, target) {
  const timeline = state.timeline
  const slot = timeline?.slots?.[slotIndex]
  if (!slot?.items?.length) return
  const tip = el("tip")
  const items = [...slot.items].sort((a, b) => b.score - a.score).slice(0, 5)
  const end = slot.start + timeline.bucketMs
  tip.innerHTML =
    `<div class="tip-head">${clock(slot.start)} – ${clock(end)} · ${slot.items.length} item${
      slot.items.length === 1 ? "" : "s"
    }</div>` +
    items
      .map(
        (item) =>
          `<div class="tip-row"><span class="tip-bar" style="--c:${topicColor(item.topic)}"></span>` +
          `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(displayTitle(item))}</a></div>`,
      )
      .join("")
  tip.classList.add("is-on")

  const rect = target.getBoundingClientRect()
  const width = 330
  const left = Math.min(Math.max(10, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 10)
  tip.style.width = `${width}px`
  tip.style.left = `${left}px`
  const above = rect.top > 170
  tip.style.top = above ? `${rect.top - tip.offsetHeight - 8}px` : `${rect.bottom + 8}px`
}

function hideTip(delay = 110) {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => el("tip").classList.remove("is-on"), delay)
}

/* --- render: brief ------------------------------------------------------ */

function entryHtml(entry) {
  const item = entry.item
  const sources = [...new Set((entry.alsoCoveredBy ?? []).map((a) => a.source))]
  const also = sources.length ? `<span class="also">also covered by ${esc(sources.join(", "))}</span>` : ""
  return `<div class="entry">
    <a class="entry-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(displayTitle(item))}</a>
    <p class="entry-note">${esc(entry.note)}</p>
    <div class="entry-meta"><span>${esc(item.sourceName)}</span><span>${timeAgo(item.publishedAt)}</span>${also}</div>
  </div>`
}

function renderBrief() {
  const view = el("view-brief")
  const brief = state.brief

  if (!brief) {
    view.innerHTML = `<div class="state">
      <h2>No brief yet</h2>
      <p>Radar collects headlines from ${state.sources.length || 36} sources and has the curator write a brief every ${
        state.refreshMinutes
      } minutes. Nothing has been written yet.</p>
      <div class="state-actions"><button class="primary" data-action="scan">Scan now</button></div>
    </div>`
    return
  }

  if (brief.status !== "ok") {
    view.innerHTML = `<div class="state">
      <h2>The curator didn't answer</h2>
      <p>Headlines were collected and stored, so nothing was lost. The brief for this scan failed to generate.</p>
      <div class="state-error">${esc(brief.error ?? "unknown error")}</div>
      <div class="state-actions">
        <button class="primary" data-action="scan">Scan again</button>
        <button class="ghost" data-action="explore">Browse the ${state.stats?.last24h ?? 0} stories instead</button>
      </div>
    </div>`
    return
  }

  const payload = brief.payload ?? {}
  const lead = payload.lead
  const leadItem = lead ? (state.briefItems.get(lead.item.id) ?? lead.item) : null
  const storyCount = (payload.sections ?? []).reduce((sum, s) => sum + s.entries.length, 0) + (leadItem ? 1 : 0)
  const sourceCount = new Set(
    [
      leadItem,
      ...(payload.sections ?? []).flatMap((s) => s.entries.map((e) => e.item)),
    ]
      .filter(Boolean)
      .map((i) => i.sourceName),
  ).size

  const sections = (payload.sections ?? [])
    .map(
      (section) => `<section class="section">
        <h2 class="section-head"><span class="swatch" style="--c:${topicColor(section.id)}"></span>${
          esc(topicName(section.id))
        }<span class="section-count">${section.entries.length}</span></h2>
        ${section.entries.map(entryHtml).join("")}
      </section>`,
    )
    .join("")

  const watching = payload.watchlist?.length
    ? `<section class="watching"><h2>Watching</h2><ul class="watch-list">${payload.watchlist
        .map((line) => `<li>${esc(line)}</li>`)
        .join("")}</ul></section>`
    : ""

  view.innerHTML = `
    <p class="dateline">${stamp(brief.createdAt)}. ${storyCount} stor${
      storyCount === 1 ? "y" : "ies"
    } worth your time, drawn from ${sourceCount} source${sourceCount === 1 ? "" : "s"} and chosen from ${
      brief.candidateCount
    } candidates.</p>
    ${
      leadItem
        ? `<article class="lead">
      <h1 class="lead-title"><a href="${esc(leadItem.url)}" target="_blank" rel="noopener noreferrer">${esc(
        displayTitle(leadItem),
      )}</a></h1>
      <p class="lead-why">${esc(lead.why)}</p>
      ${lead.context ? `<p class="lead-context">${esc(lead.context)}</p>` : ""}
      <div class="lead-meta"><span>${esc(leadItem.sourceName)}</span><span>${timeAgo(
        leadItem.publishedAt,
      )}</span></div>
    </article>`
        : ""
    }
    ${sections}
    ${watching}
  `
}

/* --- render: explore ---------------------------------------------------- */

function itemHtml(item) {
  return `<article class="item ${item.read ? "is-read" : ""}" data-id="${esc(item.id)}">
    <div class="item-time">${shortTime(item.publishedAt)}</div>
    <div class="item-body">
      <a class="item-title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(displayTitle(item))}</a>
      ${displaySummary(item) ? `<p class="item-summary">${esc(displaySummary(item))}</p>` : ""}
      <div class="item-meta">
        <span class="swatch" style="--c:${topicColor(item.topic)}"></span>
        <span>${esc(topicName(item.topic))}</span>
        <span>${esc(item.sourceName)}</span>
        <span>${clock(item.publishedAt)}</span>
      </div>
    </div>
    <div class="item-actions">
      <button class="icon-btn" data-act="read" aria-pressed="${item.read}" title="Mark read" aria-label="Mark read">
        <svg viewBox="0 0 24 24"><path d="M4 12.5l5 5 11-11"/></svg>
      </button>
      <button class="icon-btn" data-act="save" aria-pressed="${item.saved}" title="Save" aria-label="Save">
        <svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>
      </button>
    </div>
  </article>`
}

function renderExplore() {
  const view = el("view-explore")
  const { topic, source, q, unread, saved } = state.filters

  const counts = Object.fromEntries((state.stats?.byTopic ?? []).map((t) => [t.topic, t.n]))
  const chips = [{ id: "all", name: "Everything" }, ...state.topics]
    .map(
      (t) =>
        `<button class="chip" data-topic="${esc(t.id)}" aria-pressed="${t.id === topic}">${
          t.id === "all" ? "" : `<span class="swatch" style="--c:${topicColor(t.id)}"></span>`
        }${esc(t.name)}${t.id === "all" ? "" : `<span class="chip-count">${counts[t.id] ?? 0}</span>`}</button>`,
    )
    .join("")

  const sources = [...new Set(state.sources.map((s) => s.name))].sort()
  const sourceOptions = [`<option value="all">All sources</option>`]
    .concat(
      sources.map((name) => {
        const health = state.sources.find((s) => s.name === name)
        return `<option value="${esc(health?.id ?? name)}" ${health?.id === source ? "selected" : ""}>${esc(name)}</option>`
      }),
    )
    .join("")

  let feed = ""
  if (!state.items.length) {
    feed = `<div class="state">
      <h2>Nothing matches</h2>
      <p>No stories in the last 48 hours match these filters. Widen the search or clear the topic.</p>
      <div class="state-actions"><button class="ghost" data-action="clear">Clear filters</button></div>
    </div>`
  } else {
    let currentDay = ""
    feed = state.items
      .map((item) => {
        const day = dayLabel(item.publishedAt)
        const header = day === currentDay ? "" : ((currentDay = day), `<h2 class="feed-day">${esc(day)}</h2>`)
        return header + itemHtml(item)
      })
      .join("")
    if (state.items.length >= state.limit) {
      feed += `<div class="load-more"><button class="ghost" data-action="more">Show older stories</button></div>`
    }
  }

  view.innerHTML = `
    <div class="filters">
      ${chips}
      <input class="search" type="search" id="filter-q" placeholder="Search headlines and summaries" value="${esc(q)}" />
      <select class="search" id="filter-source">${sourceOptions}</select>
      <button class="chip" data-act="unread" aria-pressed="${unread}">Unread</button>
      <button class="chip" data-act="saved" aria-pressed="${saved}">Saved</button>
    </div>
    ${feed}
  `

  const search = el("filter-q")
  if (search && q) {
    search.focus()
    search.setSelectionRange(q.length, q.length)
  }
}

/* --- orchestration ------------------------------------------------------ */

function render() {
  renderStatus()
  renderStrip()
  if (state.view === "brief") renderBrief()
  else renderExplore()
}

async function loadItems({ reset = true } = {}) {
  const { topic, source, q, unread, saved } = state.filters
  if (reset) state.limit = 120
  const params = new URLSearchParams({
    hours: "48",
    limit: String(state.limit),
    topic,
    source,
  })
  if (q) params.set("q", q)
  if (unread) params.set("unread", "1")
  if (saved) params.set("saved", "1")
  const data = await api(`/api/items?${params}`)
  state.items = data.items
  renderExplore()
}

function setView(view) {
  state.view = view
  for (const button of document.querySelectorAll(".view-btn")) {
    button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false")
  }
  el("view-brief").hidden = view !== "brief"
  el("view-explore").hidden = view !== "explore"
  el("hero").hidden = view !== "brief"
  el("mark-read").hidden = view !== "brief"
  if (view === "explore") loadItems()
  else renderBrief()
}

async function triggerScan() {
  el("scan-now").disabled = true
  el("scan-now").textContent = "Starting…"
  try {
    await api("/api/scan", { method: "POST" })
    state.scanning = true
    state.scanStep = "Reading sources"
    renderStatus()
  } catch (err) {
    el("scan-now").disabled = false
    el("scan-now").textContent = "Scan now"
    el("status").innerHTML = `<span class="status-dot is-error"></span><span>Could not start a scan: ${esc(
      err.message,
    )}</span>`
  }
}

function connectEvents() {
  const stream = new EventSource("/api/events")
  stream.onmessage = (message) => {
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    switch (event.type) {
      case "scan.started":
        state.scanning = true
        state.scanStep = "Reading sources…"
        break
      case "scan.step":
        state.scanStep = `${event.step}…`
        break
      case "scan.collected":
        state.scanStep = `Collected ${event.added} new stories from ${event.feedsOk} sources. Ranking…`
        break
      case "scan.ranked":
        state.scanStep = `Curating the strongest ${event.candidates} of ${event.pool} stories…`
        break
      case "scan.curating":
        state.scanStep = `Writing the brief with ${event.model}…`
        break
      case "scan.finished":
        state.scanning = false
        state.scanStep = null
        loadBootstrap().catch(() => renderStatus())
        return
      case "scan.failed":
        state.scanning = false
        state.scanStep = null
        el("status").innerHTML = `<span class="status-dot is-error"></span><span>Scan failed: ${esc(
          event.error,
        )}</span>`
        return
      default:
        break
    }
    renderStatus()
  }
  stream.onerror = () => {
    /* EventSource reconnects on its own; the strip and brief stay on screen. */
  }
}

/* --- interactions ------------------------------------------------------- */

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, a")
  if (!target) return

  if (target.classList.contains("view-btn")) return setView(target.dataset.view)

  if (target.id === "scan-now" || target.dataset.action === "scan") return triggerScan()

  if (target.dataset.action === "clear") {
    state.filters = { topic: "all", source: "all", q: "", unread: false, saved: false }
    return loadItems()
  }

  if (target.dataset.action === "more") {
    state.limit += 120
    return loadItems({ reset: false })
  }

  if (target.dataset.action === "explore") return setView("explore")

  if (target.dataset.topic) {
    state.filters.topic = target.dataset.topic
    return loadItems()
  }

  if (target.dataset.act === "unread" || target.dataset.act === "saved") {
    const key = target.dataset.act
    state.filters[key] = !state.filters[key]
    return loadItems()
  }

  const itemNode = target.closest(".item")
  if (itemNode && target.dataset.act) {
    const id = itemNode.dataset.id
    const item = state.items.find((i) => i.id === id)
    if (!item) return
    if (target.dataset.act === "read") {
      item.read = !item.read
      itemNode.classList.toggle("is-read", item.read)
      target.setAttribute("aria-pressed", String(item.read))
      await api("/api/items/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: item.read ? [id] : [] }),
      })
    }
    if (target.dataset.act === "save") {
      item.saved = !item.saved
      target.setAttribute("aria-pressed", String(item.saved))
      await api(`/api/items/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saved: item.saved }),
      })
    }
  }
})

document.addEventListener("change", (event) => {
  if (event.target.id === "filter-source") {
    state.filters.source = event.target.value
    loadItems()
  }
})

let searchTimer = null
document.addEventListener("input", (event) => {
  if (event.target.id !== "filter-q") return
  state.filters.q = event.target.value.trim()
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadItems(), 260)
})

el("strip").addEventListener("mouseover", (event) => {
  const slot = event.target.closest(".slot[data-slot]")
  if (!slot) return
  clearTimeout(tipTimer)
  showTip(Number(slot.dataset.slot), slot)
})
el("strip").addEventListener("mouseleave", () => hideTip())
el("strip").addEventListener("focusin", (event) => {
  const slot = event.target.closest(".slot[data-slot]")
  if (slot) showTip(Number(slot.dataset.slot), slot)
})
el("strip").addEventListener("focusout", () => hideTip())

el("mark-read").addEventListener("click", async () => {
  const ids = []
  if (state.brief?.payload?.lead?.item?.id) ids.push(state.brief.payload.lead.item.id)
  for (const section of state.brief?.payload?.sections ?? []) {
    for (const entry of section.entries) ids.push(entry.item.id)
  }
  if (!ids.length) return
  el("mark-read").disabled = true
  await api("/api/items/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  })
  el("mark-read").disabled = false
  el("mark-read").textContent = "Brief marked read"
  setTimeout(() => (el("mark-read").textContent = "Mark brief read"), 2200)
})

window.addEventListener("scroll", () => hideTip(0), { passive: true })

/* --- model dialog ------------------------------------------------------- */

async function openModelDialog() {
  const dialog = el("model-dialog")
  const fields = el("model-fields")
  dialog.hidden = false
  fields.innerHTML = `<div class="field">Loading the model list…</div>`
  let models = []
  try {
    const data = await api("/api/models")
    models = data.models
  } catch (err) {
    fields.innerHTML = `<div class="field">Could not read the model list: ${esc(err.message)}</div>`
    return
  }

  const providers = [...new Set(models.map((m) => m.providerID))].sort()
  const render = (provider, selectedId) => {
    const list = models
      .filter((m) => m.providerID === provider)
      .sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0))
    return list
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.id === selectedId ? "selected" : ""}>${esc(m.id)}${
            m.cost?.input ? ` — $${m.cost.input}/M in` : " — free"
          }</option>`,
      )
      .join("")
  }

  const currentProvider = state.model?.providerID ?? providers[0]
  fields.innerHTML = `
    <div class="field"><label for="dlg-provider">Provider</label>
      <select id="dlg-provider">${providers
        .map((p) => `<option value="${esc(p)}" ${p === currentProvider ? "selected" : ""}>${esc(p)}</option>`)
        .join("")}</select></div>
    <div class="field"><label for="dlg-model">Model</label>
      <select id="dlg-model">${render(currentProvider, state.model?.id)}</select></div>
    <div class="field"><label for="dlg-refresh">Scan every (minutes)</label>
      <input id="dlg-refresh" type="number" min="5" max="720" step="5" value="${state.refreshMinutes}" /></div>
    <div class="field"><label>Mode</label>
      <input id="dlg-mode" readonly value="${
        currentProvider === "opencode"
          ? "plain — free OpenCode models reject session overrides"
          : "locked — no tool access during curation"
      }" /></div>
  `

  el("dlg-provider").addEventListener("change", (event) => {
    el("dlg-model").innerHTML = render(event.target.value, null)
    el("dlg-mode").value =
      event.target.value === "opencode"
        ? "plain — free OpenCode models reject session overrides"
        : "locked — no tool access during curation"
  })
}

el("link-models").addEventListener("click", (event) => {
  event.preventDefault()
  openModelDialog()
})
el("model-cancel").addEventListener("click", () => (el("model-dialog").hidden = true))
el("model-dialog").addEventListener("click", (event) => {
  if (event.target.id === "model-dialog") el("model-dialog").hidden = true
})
el("model-save").addEventListener("click", async () => {
  const providerID = el("dlg-provider").value
  const id = el("dlg-model").value
  const refreshMinutes = Number(el("dlg-refresh").value)
  await api("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID, id, variant: null }, refreshMinutes }),
  })
  el("model-dialog").hidden = true
  await loadBootstrap()
})

/* --- boot --------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  const tip = document.createElement("div")
  tip.className = "tip"
  tip.id = "tip"
  tip.addEventListener("mouseenter", () => clearTimeout(tipTimer))
  tip.addEventListener("mouseleave", () => hideTip())
  document.body.appendChild(tip)

  el("footer-note").textContent = `Headlines come from ${state.sources.length} sources; the brief is written locally by an OpenCode agent.`

  try {
    await loadBootstrap()
  } catch (err) {
    el("view-brief").innerHTML = `<div class="state">
      <h2>Can't reach the local server</h2>
      <p>Radar's server is not answering on this port. Start it with <code>npm start</code> and reload.</p>
      <div class="state-error">${esc(err.message)}</div>
    </div>`
  }
  setView("brief")
  connectEvents()
  setInterval(() => {
    renderStatus()
    renderStrip()
  }, 60000)
})
