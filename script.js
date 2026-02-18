// ====== Config ======
// Use your Cloudflare Worker as RSS proxy (stable)
const PROXY_BASE = "https://dadcryptonews-proxy.icothestorylingerer.workers.dev/?url=";

async function fetchWithTimeout(url, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const AUTO_REFRESH_MINUTES = 10;

const DEFAULT_SOURCES = [
  // Official Odaily RSS
  { id: "odaily_flash", name: "Odaily 快讯", url: "https://rss.odaily.news/rss/newsflash", enabled: true },
  { id: "odaily_post", name: "Odaily 文章", url: "https://rss.odaily.news/rss/post", enabled: true },

  // BlockBeats RSS v2 (official)
  { id: "blockbeats_all", name: "BlockBeats 全部", url: "https://api.theblockbeats.news/v2/rss/all", enabled: true },
  { id: "blockbeats_flash", name: "BlockBeats 快讯", url: "https://api.theblockbeats.news/v2/rss/newsflash", enabled: false },

  // Community aggregated RSS endpoints (often include Chinese crypto media)
  { id: "web30_blockbeats", name: "rss.web30.lol 律动文章", url: "https://rss.web30.lol/b2", enabled: false },
  { id: "web30_jinse", name: "rss.web30.lol 金色文章", url: "https://rss.web30.lol/jinse2", enabled: false },
];

const FILTERS = {
  all: { label: "全部", keywords: [] },
  btc: { label: "比特币", keywords: ["BTC", "比特币", "Bitcoin", "铭文", "Ordinals"] },
  eth: { label: "以太坊", keywords: ["ETH", "以太坊", "Ethereum", "L2", "Layer2", "EIP"] },
  alt: { label: "山寨/热点", keywords: ["Solana", "SOL", "Base", "Ton", "TON", "DeFi", "NFT", "GameFi", "空投", "meme", "meme币"] },
  reg: { label: "监管/政策", keywords: ["监管", "政策", "法案", "SEC", "CFTC", "FCA", "MiCA", "合规", "税", "法院", "禁令", "牌照", "执法"] },
  sec: { label: "安全/黑客", keywords: ["黑客", "攻击", "漏洞", "盗", "被盗", "安全", "诈骗", "钓鱼", "rug", "Rug", "hack", "exploit"] },
};

const STORAGE_KEY = "dad_crypto_sources_v1";

// ====== State ======
let allItems = [];
let activeFilter = "all";
let searchQuery = "";
let autoRefreshTimer = null;

// ====== DOM ======
const yearEl = document.getElementById("year");
const newsListEl = document.getElementById("newsList");
const statusTextEl = document.getElementById("statusText");
const refreshBtn = document.getElementById("refreshBtn");
const settingsBtn = document.getElementById("settingsBtn");
const searchInput = document.getElementById("searchInput");
const autoRefreshToggle = document.getElementById("autoRefreshToggle");

const modal = document.getElementById("modal");
const sourcesBox = document.getElementById("sourcesBox");
const closeModalBtn = document.getElementById("closeModalBtn");
const resetSourcesBtn = document.getElementById("resetSourcesBtn");
const saveSourcesBtn = document.getElementById("saveSourcesBtn");

// ====== Utilities ======
function setStatus(msg) {
  statusTextEl.textContent = msg;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toTimeString(date) {
  if (!date) return "时间未知";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "时间未知";
  return d.toLocaleString("zh-Hans", { hour12: false });
}

function pickText(el, tagNames) {
  for (const t of tagNames) {
    const n = el.getElementsByTagName(t)[0];
    if (n && n.textContent) return n.textContent.trim();
  }
  return "";
}

function cleanSnippet(html) {
  const txt = String(html ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return txt.length > 160 ? txt.slice(0, 160) + "…" : txt;
}

function normalizeLink(link) {
  if (!link) return "";
  return link.trim();
}

function parseRss(xmlText, sourceName) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "text/xml");

  // RSS: <item> ; Atom: <entry>
  const items = Array.from(xml.getElementsByTagName("item"));
  const entries = Array.from(xml.getElementsByTagName("entry"));

  const out = [];

  if (items.length) {
    for (const it of items) {
      const title = pickText(it, ["title"]);
      const link = normalizeLink(pickText(it, ["link"]));
      const pubDate = pickText(it, ["pubDate", "date", "published", "updated"]);
      const desc = pickText(it, ["description", "content:encoded", "summary"]);
      out.push({
        title,
        link,
        date: pubDate ? new Date(pubDate) : null,
        desc: cleanSnippet(desc),
        source: sourceName,
      });
    }
  } else if (entries.length) {
    for (const e of entries) {
      const title = pickText(e, ["title"]);
      let link = "";
      const linkEl = e.getElementsByTagName("link")[0];
      if (linkEl) link = linkEl.getAttribute("href") || linkEl.textContent || "";
      link = normalizeLink(link);

      const pubDate = pickText(e, ["published", "updated"]);
      const summary = pickText(e, ["summary", "content"]);
      out.push({
        title,
        link,
        date: pubDate ? new Date(pubDate) : null,
        desc: cleanSnippet(summary),
        source: sourceName,
      });
    }
  }

  return out
    .filter((x) => x.title && x.link)
    .map((x) => ({
      ...x,
      dateMs: x.date && !Number.isNaN(x.date.getTime()) ? x.date.getTime() : 0,
    }));
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.link || it.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function loadSources() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length) {
      // merge with defaults so new sources can appear later
      const byId = new Map(saved.map((s) => [s.id, s]));
      return DEFAULT_SOURCES.map((d) => ({ ...d, ...(byId.get(d.id) || {}) }));
    }
  } catch {}
  return DEFAULT_SOURCES.map((x) => ({ ...x }));
}

function saveSources(sources) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
}

async function fetchFeed(url) {
  const proxied = ALLORIGINS_RAW + encodeURIComponent(url);
  const res = await fetch(proxied, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ====== Render ======
function renderList(items) {
  if (!items.length) {
    newsListEl.innerHTML = `<div class="card"><div class="muted">暂无匹配内容。可以试试切到“全部”或清空搜索。</div></div>`;
    return;
  }

  newsListEl.innerHTML = items
    .slice(0, 120)
    .map((it) => {
      const title = escapeHtml(it.title);
      const desc = escapeHtml(it.desc || "");
      const time = toTimeString(it.dateMs || it.date);
      const source = escapeHtml(it.source || "未知来源");
      const link = escapeHtml(it.link);

      return `
      <article class="card">
        <div class="card-top">
          <div>
            <div class="source">${source}</div>
            <h3 class="title"><a href="${link}" target="_blank" rel="noopener">${title}</a></h3>
          </div>
          <div class="time">${escapeHtml(time)}</div>
        </div>

        ${desc ? `<div class="desc">${desc}</div>` : ""}

        <div class="card-actions">
          <a class="btn" href="${link}" target="_blank" rel="noopener">打开原文</a>
          <span class="badge">${escapeHtml(activeFilter === "all" ? "全部" : FILTERS[activeFilter].label)}</span>
        </div>
      </article>`;
    })
    .join("");
}

function applyFilterAndSearch() {
  const q = searchQuery.trim().toLowerCase();

  let filtered = allItems;

  // topic filter
  const f = FILTERS[activeFilter];
  if (f && f.keywords.length) {
    filtered = filtered.filter((it) => {
      const hay = `${it.title} ${it.desc}`.toLowerCase();
      return f.keywords.some((k) => hay.includes(String(k).toLowerCase()));
    });
  }

  // text search
  if (q) {
    filtered = filtered.filter((it) => {
      const hay = `${it.title} ${it.desc} ${it.source}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // sort newest first
  filtered = filtered.slice().sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));

  renderList(filtered);
}

// ====== Sources modal ======
let currentSources = loadSources();

function openModal() {
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  renderSourcesBox();
}

function closeModal() {
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
}

function renderSourcesBox() {
  sourcesBox.innerHTML = currentSources
    .map((s) => {
      return `
        <div class="source-row">
          <div class="left">
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="url">${escapeHtml(s.url)}</div>
          </div>
          <label class="switch">
            <input type="checkbox" data-source-id="${escapeHtml(s.id)}" ${s.enabled ? "checked" : ""} />
            <span>${s.enabled ? "开启" : "关闭"}</span>
          </label>
        </div>
      `;
    })
    .join("");

  sourcesBox.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-source-id");
      const found = currentSources.find((x) => x.id === id);
      if (found) found.enabled = e.target.checked;
      // Update label text
      e.target.parentElement.querySelector("span").textContent = e.target.checked ? "开启" : "关闭";
    });
  });
}

// ====== Load feeds ======
async function loadAllFeeds() {
  const enabled = currentSources.filter((s) => s.enabled);
  if (!enabled.length) {
    allItems = [];
    setStatus("你关闭了所有源。请在“源设置”里开启至少一个。");
    applyFilterAndSearch();
    return;
  }

  setStatus(`正在抓取 ${enabled.length} 个 RSS 源…`);
  const started = Date.now();

  const results = await Promise.allSettled(
    enabled.map(async (s) => {
      const xml = await fetchFeed(s.url);
      return parseRss(xml, s.name);
    })
  );

  let merged = [];
  let okCount = 0;
  let failCount = 0;

  results.forEach((r) => {
    if (r.status === "fulfilled") {
      okCount++;
      merged = merged.concat(r.value);
    } else {
      failCount++;
    }
  });

  merged = dedupe(merged).sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
  allItems = merged;

  const took = Math.round((Date.now() - started) / 100) / 10;
  setStatus(`完成：成功 ${okCount} / 失败 ${failCount} • 共 ${allItems.length} 条 • 用时 ${took}s`);
  applyFilterAndSearch();
}

// ====== Events ======
yearEl.textContent = new Date().getFullYear();

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.getAttribute("data-filter") || "all";
    applyFilterAndSearch();
  });
});

searchInput.addEventListener("input", (e) => {
  searchQuery = e.target.value || "";
  applyFilterAndSearch();
});

refreshBtn.addEventListener("click", () => loadAllFeeds());
settingsBtn.addEventListener("click", () => openModal());
closeModalBtn.addEventListener("click", () => closeModal());

modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

resetSourcesBtn.addEventListener("click", () => {
  currentSources = DEFAULT_SOURCES.map((x) => ({ ...x }));
  renderSourcesBox();
});

saveSourcesBtn.addEventListener("click", () => {
  saveSources(currentSources);
  closeModal();
  loadAllFeeds();
});

// auto refresh
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => loadAllFeeds(), AUTO_REFRESH_MINUTES * 60 * 1000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}
autoRefreshToggle.addEventListener("change", (e) => {
  if (e.target.checked) startAutoRefresh();
  else stopAutoRefresh();
});

// Initial load
loadAllFeeds();
startAutoRefresh();


