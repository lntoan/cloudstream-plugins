/* eslint-disable no-restricted-globals */
const PLUGIN_ID = 'phim-nguonc';
const w = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});

/**
 * KHỚP JSON THỰC TẾ:
 * - Search: { status, paginate, items: [ { id, name, slug, original_name, thumb_url, poster_url, ... } ] }
 * - Detail: { status, movie: { id, name, slug, description, total_episodes, category{Năm}, episodes:[ {server_name, items:[{name, slug, m3u8, embed}]} ] } }
 *
 * Quy ước ID trong app:
 * - Title ID: `${PLUGIN_ID}:${slug}` (ưu tiên slug cho thân thiện)
 * - Episode ID: `${PLUGIN_ID}:${slug}::E${epNum}::server=${serverIndex}`
 *   → giúp getStreams biết bạn đang chọn tập & server nào.
 */

const API = {
  BASE: 'https://phim.nguonc.com',
  search: (q) => `/api/films/search?keyword=${encodeURIComponent(q)}`,
  detailBySlug: (slug) => `/api/films/${encodeURIComponent(slug)}`,
  detailById:   (id)   => `/api/films?id=${encodeURIComponent(id)}`
};

// -------------------- utils --------------------
function yFromCategory(cat) {
  try {
    const yearList = cat?.['3']?.list || []; // "3" = nhóm "Năm" theo mẫu bạn gửi
    const y = yearList[0]?.name;
    const yi = parseInt(y, 10);
    return Number.isFinite(yi) ? yi : undefined;
  } catch { return undefined; }
}
function stripHtml(s = '') { return String(s).replace(/<[^>]+>/g, '').trim(); }

function buildSeasonsFromEpisodes(slug, movie) {
  // API trả "episodes": mảng server, mỗi server có items[] (tập)
  // Ta gom thành 1 season, tạo episodeRef có id encode tập + server=0 (server đầu tiên) làm mặc định
  const servers = Array.isArray(movie.episodes) ? movie.episodes : [];
  const firstServer = servers[0] || {items: []};
  const eps = Array.isArray(firstServer.items) ? firstServer.items : [];
  return [{
    seasonNumber: 1,
    episodes: eps.map((ep, idx) => ({
      episodeNumber: Number.isFinite(+ep.name) ? +ep.name : (idx + 1),
      id: `${slug}::E${Number.isFinite(+ep.name) ? +ep.name : (idx + 1)}::server=0`,
      title: `Tập ${ep.name ?? (idx + 1)}`
    }))
  }];
}

function extractAllStreams(movie, epNum, serverIndex) {
  const servers = Array.isArray(movie.episodes) ? movie.episodes : [];
  const srv = servers[serverIndex] || servers[0] || {items: []};
  const items = Array.isArray(srv.items) ? srv.items : [];
  // epNum bắt đầu từ 1
  const foundIdx = items.findIndex(it => {
    const n = Number.isFinite(+it.name) ? +it.name : null;
    return n === epNum;
  });
  const it = foundIdx >= 0 ? items[foundIdx] : items[epNum - 1];

  const acc = [];
  if (it?.m3u8) {
    acc.push({ url: it.m3u8, quality: 'auto', subtitles: undefined, headers: undefined, drm: null });
  }
  // dùng thêm "embed" nếu muốn (thường là host bên ngoài), ở đây ưu tiên m3u8 direct
  // if (it?.embed) { ... }

  // Ngoài ra, có thể các server khác cũng có cùng tập → gom thêm:
  for (let s = 0; s < servers.length; s++) {
    if (s === serverIndex) continue;
    const altSrv = servers[s];
    const altItems = Array.isArray(altSrv?.items) ? altSrv.items : [];
    const alt = altItems.find(x => (Number.isFinite(+x.name) ? +x.name : null) === epNum) || altItems[epNum - 1];
    if (alt?.m3u8) {
      acc.push({ url: alt.m3u8, quality: `server-${s}`, subtitles: undefined, headers: undefined, drm: null });
    }
  }

  // unique
  const seen = new Set();
  return acc.filter(x => {
    const k = `${x.url}|${x.quality}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function getJSON(path, {timeoutMs = 10000} = {}) {
  const url = new URL(path, API.BASE).toString();
  console.log(`[phim-nguonc] API call: ${path} -> ${url}`);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {headers: {'accept': 'application/json'}, signal: ctrl.signal});
    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      console.error(`[phim-nguonc] API error: ${res.status} - ${t.slice(0,200)}`);
      throw new Error(`HTTP ${res.status} : ${t.slice(0,200)}`);
    }
    return await res.json();
  } catch (e) {
    console.error('[phim-nguonc] fetch failed:', e && e.name, e && e.message);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

// -------------------- PLUGIN METHODS --------------------
async function search(q) {
  const data = await getJSON(API.search(q));
  const list = Array.isArray(data) ? data : (data.items || []);
  return list.map(raw => {
    const slug = raw.slug || raw.id;
    return {
      id: `${PLUGIN_ID}:${slug}`,
      pluginId: PLUGIN_ID,
      type: (Number(raw.total_episodes) > 1) ? 'series' : 'movie',
      title: raw.name || raw.original_name,
      year: undefined, // có thể suy từ created/modified nếu cần
      poster: raw.poster_url || raw.thumb_url,
      backdrop: undefined,
      genres: undefined,
      rating: undefined,
      meta: {
        current_episode: raw.current_episode,
        time: raw.time,
        quality: raw.quality,
        language: raw.language
      }
    };
  });
}

async function getItem(globalId) {
  const idPart = String(globalId).split(':').slice(1).join(':'); // `${slug}` hoặc biến thể có ::E...
  const slug = idPart.split('::')[0];

  let detail = await getJSON(API.detailBySlug(slug)).catch(() => null);
  if (!detail) {
    // fallback: có thể API cho phép query theo id
    detail = await getJSON(API.detailById(slug));
  }
  const mv = detail.movie;

  return {
    id: `${PLUGIN_ID}:${slug}`,
    pluginId: PLUGIN_ID,
    type: (Number(mv.total_episodes) > 1) ? 'series' : 'movie',
    title: mv.name || mv.original_name,
    year: yFromCategory(mv.category),
    overview: stripHtml(mv.description || ''),
    poster: mv.poster_url || mv.thumb_url,
    backdrop: undefined,
    seasons: (Number(mv.total_episodes) > 1) ? buildSeasonsFromEpisodes(slug, mv) : undefined
  };
}

/**
 * globalId có thể là:
 *  - `${PLUGIN_ID}:${slug}` → mặc định E1 server=0
 *  - `${PLUGIN_ID}:${slug}::E${n}::server=${k}`
 */
async function getStreams(globalId) {
  const idPart = String(globalId).split(':').slice(1).join(':'); // slug[..]
  const [slug, ...rest] = idPart.split('::');

  // parse ep & server
  let epNum = 1;
  let serverIndex = 0;
  for (const tok of rest) {
    const mEp = tok.match(/^E(\d+)$/i);
    const mSrv = tok.match(/^server=(\d+)$/i);
    if (mEp) epNum = parseInt(mEp[1], 10) || 1;
    if (mSrv) serverIndex = parseInt(mSrv[1], 10) || 0;
  }

  let detail = await getJSON(API.detailBySlug(slug)).catch(() => null);
  if (!detail) {
    detail = await getJSON(API.detailById(slug));
  }
  const mv = detail.movie;

  // Movie lẻ (total_episodes === 1) → thường sẽ có server 1 item
  // Series → chọn tập theo E{n}
  return extractAllStreams(mv, epNum, serverIndex);
}

// ==== helper unique & pick ====
function uniqById(arr = []) {
  const seen = new Set(); const out = [];
  for (const it of arr) { if (!it?.id || seen.has(it.id)) continue; seen.add(it.id); out.push(it); }
  return out;
}

function pickOne(arr = []) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

// Nếu sau này nguồn có endpoint genres, bạn gọi API thay vì hardcode.
async function listGenres() {
  return ['Cổ Trang', 'Tình Cảm', 'Hành Động', 'Hài', 'Phiêu Lưu'];
}

// ===== Discover: trending/new/genre (tùy nguồn, có thể đổi logic) =====
async function discover({type, genre, limit = 20} = {}) {
  let items = [];
  try {
    if (type === 'genre' && genre) {
      items = await search(genre);
    } else if (type === 'trending') {
      const seeds = ['hot','top','avengers','love']; // tuỳ chỉnh
      for (const q of seeds) { const r = await search(q); items.push(...(r || [])); if (items.length >= limit*2) break; }
    } else if (type === 'new') {
      const seeds = ['2025','2024','2023'];
      for (const q of seeds) { const r = await search(q); items.push(...(r || [])); if (items.length >= limit*2) break; }
    }
  } catch {/* bỏ qua lỗi rời rạc */}
  return uniqById(items).slice(0, limit);
}

// ===== QUAN TRỌNG: getHome để Home chỉ render theo plugin =====
async function getHome({rows = 3, limit = 14} = {}) {
  const names = await listGenres();
  const chosen = names.slice(0, rows);
  const sections = [];

  for (const g of chosen) {
    let items = [];
    try { items = await discover({type: 'genre', genre: g, limit}); }
    catch { items = []; }
    sections.push({title: g, items});
  }

  // banner: random từ pool các rows (đảm bảo nhất quán nội dung)
  const pool = uniqById(sections.flatMap(s => s.items || []));
  const banner = pickOne(pool) || null;

  return {banner, sections};
}

// -------------------- Worker bridge --------------------
/* global self */
self.onmessage = async (e) => {
  console.log('[phim-nguonc] Worker received message:', e.data);
  
  const {type, id, method, payload} = e.data || {};
  if (type !== 'call') {
    console.log('[phim-nguonc] Ignoring non-call message:', type);
    return;
  }
  
  console.log(`[phim-nguonc] Calling method: ${method} with payload:`, payload);
  
  try {
    const api = {search, getItem, getStreams,listGenres,discover,getHome};
    console.log('[phim-nguonc] Available methods:', Object.keys(api));
    
    if (!api[method]) {
      throw new Error(`Method ${method} not found. Available: ${Object.keys(api).join(', ')}`);
    }
    
    const result = await api[method](...(payload || []));
    console.log(`[phim-nguonc] Method ${method} result:`, result);
    self.postMessage({id, result});
  } catch (err) {
    console.error(`[phim-nguonc] Method ${method} error:`, err);
    self.postMessage({id, error: String(err && err.message || err)});
  }
};
