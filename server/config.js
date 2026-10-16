import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const DATA_DIR = join(ROOT, "data")
export const CONFIG_PATH = join(ROOT, "radar.config.json")

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

/**
 * Topics drive the colours and filters in the UI, and the deterministic
 * classifier that runs before the curator sees anything.
 */
export const DEFAULT_TOPICS = [
  {
    id: "models",
    name: "Models",
    color: "#2E5BE6",
    keywords: [
      "model", "weights", "benchmark", "sota", "parameters", "context window",
      "open weights", "open-weights", "fine-tune", "checkpoint", "llm",
      "gpt", "claude", "gemini", "llama", "qwen", "mistral", "deepseek", "grok",
      "reasoning", "multimodal", "vision model", "inference",
    ],
  },
  {
    id: "funding",
    name: "Funding",
    color: "#C22B62",
    keywords: [
      "raises", "raised", "funding", "series a", "series b", "series c", "series d",
      "seed round", "valuation", "acquires", "acquisition", "acquired", "merger",
      "ipo", "investment", "backed by", "led by", "pitch deck", "term sheet",
      "revenue", "arr", "ipo filing",
    ],
  },
  {
    id: "agents",
    name: "Agents",
    color: "#6A45D9",
    keywords: [
      "agent", "agents", "agentic", "autonomous", "coding agent", "copilot",
      "tool use", "tool-calling", "function calling", "orchestration", "workflow",
      "mcp", "multi-agent", "computer use", "browser agent", "eval", "evals",
      "deep research", "swarm",
    ],
  },
  {
    id: "platforms",
    name: "Platforms",
    color: "#0E8C7F",
    keywords: [
      "api", "sdk", "pricing", "rate limit", "endpoint", "generally available",
      "ga release", "launch", "launches", "available now", "developer", "console",
      "cloud", "gpu", "inference provider", "serverless", "integration", "plugin",
      "open source", "open-source", "github", "framework", "library", "runtime",
    ],
  },
  {
    id: "research",
    name: "Research",
    color: "#A8730A",
    keywords: [
      "paper", "arxiv", "research", "study", "we find", "we show", "state of the art",
      "novel", "method", "training", "architecture", "attention", "scaling law",
      "interpretability", "alignment", "rlhf", "distillation", "quantization",
    ],
  },
  {
    id: "industry",
    name: "Industry",
    color: "#66707A",
    keywords: [
      "regulation", "policy", "law", "lawsuit", "court", "eu ai act", "ban",
      "safety", "hiring", "layoffs", "partnership", "deal", "compute", "datacenter",
      "data center", "chips", "nvidia", "talent", "compensation",
    ],
  },
]

const DEFAULT_SOURCES = [
  // The labs, straight from the source. Anthropic and Meta publish no feed of their
  // own; Google News queries below cover their announcements instead.
  { id: "openai", name: "OpenAI", url: "https://openai.com/news/rss.xml", category: "lab", weight: 20 },
  { id: "deepmind", name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", category: "lab", weight: 18 },
  { id: "hf-blog", name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", category: "lab", weight: 16 },
  { id: "mistral", name: "Mistral AI", url: "https://mistral.ai/news/rss", category: "lab", weight: 14 },
  { id: "aws-ml", name: "AWS Machine Learning", url: "https://aws.amazon.com/blogs/machine-learning/feed/", category: "lab", weight: 8 },
  { id: "nvidia-blog", name: "NVIDIA Blog", url: "https://blogs.nvidia.com/feed/", category: "lab", weight: 7 },

  // Reporting
  { id: "techcrunch-ai", name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", category: "press", weight: 16 },
  { id: "the-decoder", name: "The Decoder", url: "https://the-decoder.com/feed/", category: "press", weight: 12 },
  { id: "verge-ai", name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", category: "press", weight: 12 },
  { id: "arstechnica-ai", name: "Ars Technica", url: "https://arstechnica.com/ai/feed/", category: "press", weight: 10 },
  { id: "techmeme", name: "Techmeme", url: "https://www.techmeme.com/feed.xml", category: "press", weight: 10 },
  { id: "mit-tech-review", name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "press", weight: 10 },
  { id: "ieee-spectrum-ai", name: "IEEE Spectrum AI", url: "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss", category: "press", weight: 9 },
  { id: "marktechpost", name: "MarkTechPost", url: "https://www.marktechpost.com/feed/", category: "press", weight: 8 },

  // Funding and markets
  { id: "crunchbase", name: "Crunchbase News", url: "https://news.crunchbase.com/feed/", category: "funding", weight: 14 },

  // Practitioner and analyst writing
  { id: "simonw", name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "practitioner", weight: 16 },
  { id: "latent-space", name: "Latent Space", url: "https://www.latent.space/feed", category: "practitioner", weight: 12 },
  { id: "interconnects", name: "Interconnects", url: "https://www.interconnects.ai/feed", category: "practitioner", weight: 12 },
  { id: "import-ai", name: "Import AI", url: "https://importai.substack.com/feed", category: "practitioner", weight: 12 },
  { id: "one-useful-thing", name: "One Useful Thing", url: "https://www.oneusefulthing.org/feed", category: "practitioner", weight: 10 },
  { id: "ahead-of-ai", name: "Ahead of AI", url: "https://magazine.sebastianraschka.com/feed", category: "practitioner", weight: 9 },
  { id: "stratechery", name: "Stratechery", url: "https://stratechery.com/feed/", category: "practitioner", weight: 9 },

  // Community signal
  { id: "hn-front", name: "Hacker News", url: "https://hnrss.org/frontpage?points=150", category: "community", weight: 12 },
  { id: "hn-new", name: "Hacker News (new)", url: "https://hnrss.org/newest?q=LLM", category: "community", weight: 7 },
  { id: "reddit-localllama", name: "r/LocalLLaMA", url: "https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day", category: "community", weight: 10 },

  // Research firehose. Low weight: papers are plentiful and rarely the day's lead.
  { id: "arxiv-cs-ai", name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI", category: "research", weight: 6, limit: 12 },
  { id: "arxiv-cs-lg", name: "arXiv cs.LG", url: "https://rss.arxiv.org/rss/cs.LG", category: "research", weight: 6, limit: 10 },

  // Release feeds: the granular truth about API and SDK changes.
  { id: "gh-openai-py", name: "openai-python releases", url: "https://github.com/openai/openai-python/releases.atom", category: "release", weight: 8, limit: 8 },
  { id: "gh-langchain", name: "LangChain releases", url: "https://github.com/langchain-ai/langchain/releases.atom", category: "release", weight: 7, limit: 8 },
  { id: "gh-llamacpp", name: "llama.cpp releases", url: "https://github.com/ggml-org/llama.cpp/releases.atom", category: "release", weight: 7, limit: 8 },
  { id: "gh-transformers", name: "transformers releases", url: "https://github.com/huggingface/transformers/releases.atom", category: "release", weight: 6, limit: 6 },
  { id: "gh-vllm", name: "vLLM releases", url: "https://github.com/vllm-project/vllm/releases.atom", category: "release", weight: 6, limit: 6 },
  { id: "gh-vercel-ai", name: "Vercel AI SDK releases", url: "https://github.com/vercel/ai/releases.atom", category: "release", weight: 6, limit: 8 },
  { id: "gh-github", name: "GitHub Blog", url: "https://github.blog/feed/", category: "release", weight: 8 },

  // Coverage for labs that publish no feed of their own.
  { id: "gnews-anthropic", name: "Google News: Anthropic", url: "https://news.google.com/rss/search?q=Anthropic&hl=en-US&gl=US&ceid=US:en", category: "search", weight: 9, limit: 12 },
  { id: "gnews-ai", name: "Google News: AI", url: "https://news.google.com/rss/search?q=%22artificial+intelligence%22+when:1d&hl=en-US&gl=US&ceid=US:en", category: "search", weight: 6, limit: 14 },
]

const DEFAULT_CONFIG = {
  model: { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: null },
  refreshMinutes: 60,
  autoScanOnBoot: true,
  port: 4310,
  collection: {
    windowHours: 48,
    maxCandidates: 130,
    summaryChars: 340,
    maxPerSource: 25,
    concurrency: 6,
    feedTimeoutMs: 15000,
  },
  scoring: {
    muteKeywords: [
      "sponsored", "webinar", "podcast", "newsletter", "giveaway", "coupon",
      "top 10", "top 5", "best ai tools", "how to prompt", "prompt engineering tips",
      "hiring", "we're hiring", "join our team",
    ],
  },
  curator: {
    enabled: true,
    timeoutMs: 300000,
    keepSourcesInNotes: false,
  },
  topics: DEFAULT_TOPICS,
  sources: DEFAULT_SOURCES,
}

function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (typeof base !== "object" || typeof override !== "object") return override
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v)
  return out
}

let cached = null

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached
  let fromDisk = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      fromDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    } catch (err) {
      throw new Error(`radar.config.json is not valid JSON: ${err.message}`)
    }
  }
  cached = deepMerge(DEFAULT_CONFIG, fromDisk)
  applyEnvOverrides(cached)
  cached.topicsById = Object.fromEntries(cached.topics.map((t) => [t.id, t]))
  return cached
}

/**
 * Environment overrides, so the same radar.config.json can drive a run in a
 * place that has no OpenCode service — notably the static build on a CI runner.
 */
function applyEnvOverrides(cfg) {
  if (process.env.RADAR_NO_CURATE === "1") cfg.curator.enabled = false
  if (process.env.RADAR_REFRESH_MINUTES) {
    const minutes = Number(process.env.RADAR_REFRESH_MINUTES)
    if (Number.isFinite(minutes) && minutes > 0) cfg.refreshMinutes = minutes
  }
  if (process.env.RADAR_PORT) {
    const port = Number(process.env.RADAR_PORT)
    if (Number.isFinite(port) && port > 0) cfg.port = port
  }
}

export function saveConfigJson(partial) {
  // Merge into the file on disk (not the merged defaults) so the user's own
  // file stays readable, then reload the effective config.
  let onDisk = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    } catch {
      onDisk = {}
    }
  }
  const next = deepMerge(onDisk, partial)
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  loadConfig({ reload: true })
  return next
}
