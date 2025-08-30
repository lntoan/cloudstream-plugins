/* eslint-disable no-restricted-globals */
/**
 * KKPhim (phim.nguonc.com) plugin — Pro merged edition
 * - Stream preference (m3u8 vs embed) + debug log
 * - LRU cache for http + detail cache
 * - Robust detail fallback: slug -> id -> search -> detail
 * - True browse endpoints for Home/Discover
 */

const PLUGIN_ID = 'phim-nguonc';

/** ================= Config ================= */
const config = {
  preferredStreamType: 'embed', // 'm3u8' | 'embed'
  debugLog: true
};
const log = (...args) => { if (config.debugLog) try { console.log('[Plugin]', ...args); } catch {} };

/** ================= API endpoints ================= */
const API = {
  BASE: 'https://phim.nguonc.com',
  search: (q) => `/api/films/search?keyword=${encodeURIComponent(q)}`,
  detailBySlug: (slug) => `/api/film/${encodeURIComponent(slug)}`,
  detailById: (id) => `/api/film?id=${encodeURIComponent(id)}`
};

/** ================= LRU cache ================= */
class LRU {
  constructor(max = 100) { this.max = max; this.map = new Map(); }
  get(k) { if (!this.map.has(k)) return; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
}

const httpCache = new LRU(150);     // URL -> {ts, data, ttl}
const detailCache = new LRU(400);   // slug|id -> {ts, data}
const now = () => Date.now();

/** ================= Small utils ================= */
const stripHtml = (s = '') => String(s).replace(/<[^>]+>/g, '').trim();
const uniqBy = (arr = [], keyFn) => { const seen = new Set(), out=[]; for (const it of arr||[]) { const k = keyFn(it); if (k==null||seen.has(k)) continue; seen.add(k); out.push(it);} return out; };
const pickOne = (arr = []) => (arr && arr.length ? arr[(Math.random()*arr.length)|0] : null);
const asInt = (x, def) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const buildUrl = (path) => new URL(path, API.BASE).toString();

/** heuristic year from category name (optional) */
function yFromCategoryName(name='') {
  const m = String(name).match(/\b(19|20)\d{2}\b/);
  return m ? asInt(m[0]) : undefined;
}

/** ================= HTTP with cache ================= */
async function httpJson(path, {timeoutMs = 10000, ttlMs = 5 * 60 * 1000} = {}) {
  const url = buildUrl(path);
  const cached = httpCache.get(url);
  if (cached && (now() - cached.ts) < (cached.ttl || ttlMs)) return cached.data;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {headers: {'accept':'application/json'}, signal: ctrl.signal});
    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status} : ${t.slice(0,200)}`);
    }
    const data = await res.json();
    httpCache.set(url, {ts: now(), data, ttl: ttlMs});
    return data;
  } finally { clearTimeout(timer); }
}

/** ================= ID helpers ================= */
function extractSlugAndOpts(globalId) {
  const raw = String(globalId || '');
  const idPart = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw; // remove plugin prefix
  const [slugOrId, ...rest] = idPart.split('::');
  let epNum = 1, serverIndex = 0;
  for (const tok of rest) {
    const mEp = tok.match(/^E(\d+)$/i);
    const mSrv = tok.match(/^server=(\d+)$/i);
    if (mEp) epNum = parseInt(mEp[1], 10) || 1;
    if (mSrv) serverIndex = parseInt(mSrv[1], 10) || 0;
  }
  return {slugOrId, epNum, serverIndex};
}
const makeEpisodeId = (slug, epNum, serverIndex = 0) => `${slug}::E${epNum}::server=${serverIndex}`;

/** ================= Normalizers ================= */
function normalizeListItems(json) {
  const arr = Array.isArray(json?.items) ? json.items
           : Array.isArray(json?.data?.items) ? json.data.items
           : Array.isArray(json?.data) ? json.data
           : Array.isArray(json) ? json : [];
  return arr.map(raw => normalizeBriefItem(raw));
}

function normalizeBriefItem(raw) {
  const slug = raw.slug || raw.id || raw?.movie?.slug || raw?.slug_name;
  const poster = raw.poster_url || raw.thumb_url || raw.poster || raw?.image || '';
  const yearFromCat = Array.isArray(raw?.category) ? yFromCategoryName(raw.category.map(x=>x?.name).join(' ')) : undefined;

  return {
    id: `${PLUGIN_ID}:${slug}`,
    pluginId: PLUGIN_ID,
    type: (Number(raw.total_episodes || raw.episode_total) > 1) ? 'series' : 'movie',
    title: raw.name || raw.title || raw.origin_name || raw.original_name || raw.vn_name,
    year: asInt(raw.year || raw.publish_year, yearFromCat),
    poster: poster,
    backdrop: poster,
    genres: raw.category || raw.categories || undefined,
    rating: raw.tmdb?.vote_average || undefined,
    description: stripHtml(raw.description || raw.content || ''),
    meta: {
      current_episode: raw.current_episode || raw.episode_current,
      time: raw.modified?.time || raw.updated_at || raw.time,
      quality: raw.quality,
      language: raw.lang || raw.language
    }
  };
}

function normalizeDetail(json, slug) {
  if (!json) return null;
  const data = json.data || json;
  const mv = data.movie || data.item || data;
  let episodes = data.episodes || mv?.episodes || [];
  if (!Array.isArray(episodes)) episodes = [];
  const poster = mv?.poster_url || mv?.thumb_url || mv?.poster || '';
  const year = asInt(mv?.year || mv?.release_year || mv?.publish_year, yFromCategoryName((mv?.category||[]).map(x=>x?.name).join(' ')));
  return {
    movie: {
      slug: mv?.slug || slug,
      id: mv?._id || mv?.id,
      name: mv?.name || mv?.title || mv?.origin_name || mv?.original_name,
      original_name: mv?.origin_name || mv?.original_name || mv?.name,
      description: stripHtml(mv?.description || mv?.content || ''),
      total_episodes: asInt(mv?.total_episodes || mv?.episode_total, 1),
      poster_url: poster,
      thumb_url : poster,
      year,
      categories: mv?.category || mv?.categories || [],
      countries: mv?.country || mv?.countries || [],
    },
    episodes
  };
}

/** ================= Streams ================= */
function buildSeasonsFromEpisodes(slug, movie) {
  const servers = Array.isArray(movie.episodes) ? movie.episodes : [];
  const firstServer = servers[0] || {items: []};
  const eps = Array.isArray(firstServer.items) ? firstServer.items : [];
  return [{
    seasonNumber: 1,
    episodes: eps.map((ep, idx) => {
      const n = Number.isFinite(+ep.name) ? +ep.name : (idx + 1);
      return {
        episodeNumber: n,
        id: makeEpisodeId(slug, n, 0),
        title: `Tập ${ep.name ?? (idx + 1)}`
      };
    })
  }];
}

function extractAllStreams(movie, epNum, serverIndex) {
  const servers = Array.isArray(movie.episodes) ? movie.episodes : [];
  const pickFrom = (srvIdx) => {
    const srv = servers[srvIdx] || {items: []};
    const items = Array.isArray(srv.items) ? srv.items : [];
    const found = items.find(x => (Number.isFinite(+x.name) ? +x.name : null) === epNum) || items[epNum - 1];
    return found || null;
  };

  const current = pickFrom(serverIndex);
  const out = [];
  
  console.log('[Plugin] Current episode data:', {
    hasEmbed: !!current?.embed,
    hasM3u8: !!current?.m3u8,
    embedUrl: current?.embed,
    m3u8Url: current?.m3u8
  });
  
  // Ưu tiên embed trước để test
  if (current?.embed) {
    out.push({url: current.embed, quality: 'HD', type: 'embed'});
    console.log('[Plugin] Added embed stream:', current.embed);
  }
  // Fallback sang m3u8 nếu không có embed
  if (current?.m3u8 && !current?.embed) {
    out.push({url: current.m3u8, quality: 'auto', subtitles: undefined, headers: undefined, drm: null});
    console.log('[Plugin] Added m3u8 stream:', current.m3u8);
  }
  // Nếu cả hai đều có, embed trước, m3u8 sau
  if (current?.m3u8 && current?.embed) {
    out.push({url: current.m3u8, quality: 'auto', subtitles: undefined, headers: undefined, drm: null});
    console.log('[Plugin] Added m3u8 stream (fallback):', current.m3u8);
  }

  // Lấy thêm các server khác (nếu có cùng tập)
  for (let s = 0; s < servers.length; s++) {
    if (s === serverIndex) continue;
    const alt = pickFrom(s);
    if (alt?.m3u8) out.push({url: alt.m3u8, quality: `server-${s}`, subtitles: undefined, headers: undefined, drm: null});
  }
  // unique theo url+quality
  return uniqBy(out, it => `${it.url}|${it.quality ?? ''}`);
}

function chooseStream(streams) {
  if (!streams || !streams.length) return null;
  if (config.preferredStreamType === 'm3u8') {
    return streams.find(s => s.type === 'm3u8') || streams.find(s => !s.type && s.url?.includes('.m3u8')) || streams[0];
  }
  if (config.preferredStreamType === 'embed') {
    return streams.find(s => s.type === 'embed') || streams[0];
  }
  return streams[0];
}

/** ================= Detail fetch (robust) ================= */
async function fetchDetailBySlug(slug) {
  const key = `slug:${slug}`;
  const cached = detailCache.get(key);
  const ONE_HOUR = 60 * 60 * 1000;
  if (cached && (now() - cached.ts) < ONE_HOUR) return cached.data;

  const json = await httpJson(API.detailBySlug(slug), {ttlMs: ONE_HOUR});
  const norm = normalizeDetail(json, slug);
  if (!norm || !norm.movie) throw new Error(`Detail not found by slug "${slug}"`);
  detailCache.set(key, {ts: now(), data: norm});
  return norm;
}

async function fetchDetailById(id) {
  const key = `id:${id}`;
  const cached = detailCache.get(key);
  const ONE_HOUR = 60 * 60 * 1000;
  if (cached && (now() - cached.ts) < ONE_HOUR) return cached.data;

  const json = await httpJson(API.detailById(id), {ttlMs: ONE_HOUR});
  const norm = normalizeDetail(json, undefined);
  if (!norm || !norm.movie) throw new Error(`Detail not found by id "${id}"`);
  detailCache.set(key, {ts: now(), data: norm});
  return norm;
}

async function searchFirst(q) {
  const r = await httpJson(API.search(q), {ttlMs: 5 * 60 * 1000});
  const list = Array.isArray(r) ? r : (r.items || []);
  return list && list[0];
}

/** Try best: slug -> id -> search -> detail(slug) */
async function fetchDetailByAny(slugOrId) {
  // 1) try as slug
  try { log('fetchDetailByAny -> slug', slugOrId); return await fetchDetailBySlug(slugOrId); } catch (e) { log('slug fail:', String(e)); }
  // 2) try as id
  try { log('fetchDetailByAny -> id', slugOrId); return await fetchDetailById(slugOrId); } catch (e) { log('id fail:', String(e)); }
  // 3) search then detail by result slug
  try {
    const hit = await searchFirst(slugOrId);
    if (hit?.id) {
      const normalized = String(hit.id).split(':').slice(1).join(':'); // remove plugin prefix
      log('fetchDetailByAny -> search hit', normalized);
      return await fetchDetailBySlug(normalized);
    }
  } catch (e) { log('search fail:', String(e)); }
  throw new Error(`Detail not found for "${slugOrId}" by any method`);
}

/** ================= Public API: search/getItem/getStreams/play ================= */
async function search(q) {
  try {
    if (!q) return [];
    log('search -> q:', q);
    const json = await httpJson(API.search(q));
    const result = normalizeListItems(json);
    log('search -> result count:', result.length);
    return result;
  } catch (error) {
    log('search error:', error);
    return []; // Return empty array instead of crashing
  }
}

async function getItem(globalId) {
  try {
    if (!globalId) {
      log('getItem called with empty globalId');
      return null;
    }
    
    const {slugOrId} = extractSlugAndOpts(globalId);
    log('getItem -> slugOrId:', slugOrId);
    
    const detail = await fetchDetailByAny(slugOrId);
    if (!detail) {
      log('getItem -> detail not found for:', slugOrId);
      return null;
    }
    
    const mv = detail.movie;
    const result = {
      id: `${PLUGIN_ID}:${slugOrId}`,
      pluginId: PLUGIN_ID,
      type: (Number(mv.total_episodes) > 1) ? 'series' : 'movie',
      title: mv.name || mv.original_name || 'Không có tiêu đề',
      year: mv.year,
      overview: mv.description || '',
      poster: mv.poster_url || '',
      backdrop: mv.thumb_url || mv.poster_url || '',
      seasons: (Number(mv.total_episodes) > 1) ? buildSeasonsFromEpisodes(detail) : undefined
    };
    
    log('getItem -> result:', result);
    return result;
  } catch (error) {
    log('getItem error:', error);
    return null; // Return null instead of crashing
  }
}

async function getStreams(globalId) {
  try {
    if (!globalId) {
      log('getStreams called with empty globalId');
      return {servers: []};
    }
    
    const {slugOrId, epNum, serverIndex} = extractSlugAndOpts(globalId);
    log('getStreams -> slugOrId:', slugOrId, 'epNum:', epNum, 'serverIndex:', serverIndex);
    
    const detail = await fetchDetailByAny(slugOrId);
    if (!detail) {
      log('getStreams -> detail not found for:', slugOrId);
      return {servers: []};
    }
    
    const streams = extractAllStreams(detail, epNum, serverIndex);
    const servers = [{name: 'Nguonc', streams}];
    
    log('getStreams -> result:', {serversCount: servers.length, streamsCount: streams.length});
    return {servers};
  } catch (error) {
    log('getStreams error:', error);
    return {servers: []}; // Return empty servers instead of crashing
  }
}

async function play({globalId, serverIndex = 0, episodeIndex = 0} = {}) {
  try {
    if (!globalId) {
      throw new Error('globalId is required');
    }
    
    const {slugOrId} = extractSlugAndOpts(globalId);
    log('play -> slugOrId:', slugOrId, 'serverIndex:', serverIndex, 'episodeIndex:', episodeIndex);
    
    const detail = await fetchDetailByAny(slugOrId);
    if (!detail) {
      throw new Error(`Detail not found for: ${slugOrId}`);
    }
    
    const streams = extractAllStreams(detail, 1, serverIndex);
    if (!streams.length) {
      throw new Error('Không tìm thấy stream khả dụng');
    }
    
    const result = streams[0]; // Lấy stream đầu tiên
    log('play -> result:', result);
    return result;
  } catch (error) {
    log('play error:', error);
    throw error; // Re-throw for proper error handling
  }
}

/** ================= Browse / Home ================= */
const TYPE_LISTS = [
  {key: 'phim-moi-cap-nhat', title: 'Mới cập nhật'},
  {key: 'phim-le', title: 'Phim lẻ'},
  {key: 'phim-bo', title: 'Phim bộ'},
  {key: 'phim-hoat-hinh', title: 'Hoạt hình'},
  {key: 'tv-shows', title: 'TV Shows'},
];

async function fetchList(path, page = 1) {
  const json = await httpJson(path, {ttlMs: 5 * 60 * 1000});
  const items = normalizeListItems(json);
  const pagination = {
    page: asInt(json?.data?.params?.page || json?.params?.page || page, page),
    totalPages: asInt(json?.data?.params?.totalPages || json?.params?.totalPages, undefined)
  };
  return {items, pagination};
}

async function listGenres() {
  // Nếu có endpoint genres riêng hãy gọi API; tạm cứng
  return ['Kiếm hiệp', 'Tình Cảm', 'Hành Động', 'Hài', 'Phiêu Lưu'];
}

async function listCountries() {
  try {
    const json = await httpJson(API.countries(), {ttlMs: 12 * 60 * 60 * 1000});
    const arr = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
    return arr.map(x => ({ slug: x.slug || x.id || x.path || x.name, name: x.name || x.title || x.vi || x.slug }));
  } catch {
    return [
      {slug:'viet-nam', name:'Việt Nam'},
      {slug:'thai-lan', name:'Thái Lan'},
      {slug:'han-quoc', name:'Hàn Quốc'},
      {slug:'trung-quoc', name:'Trung Quốc'},
      {slug:'my', name:'Mỹ'}
    ];
  }
}

function listYears({from=2010, to=(new Date()).getFullYear()} = {}) {
  const arr = []; for (let y = to; y >= from; y--) arr.push({slug:String(y), name:String(y)}); return arr;
}

async function discover({type, genre, limit = 20} = {}) {
  let items = [];
  try {
    if (type === 'genre' && genre) {
      items = await search(genre);
    } else if (type === 'trending') {
      for (const q of ['hot', 'top']) {
        const r = await search(q);
        items.push(...(r || []));
        if (items.length >= limit * 2) break;
      }
    } else if (type === 'new') {
      for (const q of ['2025', '2024', '2023']) {
        const r = await search(q);
        items.push(...(r || []));
        if (items.length >= limit * 2) break;
      }
    }
  } catch {}
  return uniqBy(items, it => it.id).slice(0, limit);
}

async function getHome({rows = 3, limit = 14} = {}) {
  const names = await listGenres();
  const chosen = names.slice(0, rows);
  const sections = [];
  for (const g of chosen) {
    let items = [];
    try { items = await discover({type:'genre', genre:g, limit}); } catch {}
    sections.push({title: g, items});
  }
  const pool = uniqBy(sections.flatMap(s => s.items || []), it => it.id);
  const banner = pickOne(pool) || null;
  log('getHome -> sections', sections.length, 'banner?', !!banner);
  return {banner, sections};
}

/** ================= Worker bridge ================= */
self.addEventListener('error', (e) => {
  try {
    console.error('[phim-nguonc] Worker error:', e);
    self.postMessage({id: -1, error: `WorkerRuntimeError: ${e.message} @${e.filename}:${e.lineno}`});
  } catch {}
});

self.onmessage = async (e) => {
  const {type, id, method, payload} = e.data || {};
  if (type !== 'call') return;
  
  try {
    console.log(`[phim-nguonc] Worker called: ${method}`, payload);
    
    const api = {
      search, getItem, getStreams, play,
      listGenres, listCountries, listYears, discover, getHome
    };
    
    if (!api[method]) {
      throw new Error(`Method ${method} not found. Available: ${Object.keys(api).join(', ')}`);
    }
    
    const args = Array.isArray(payload) ? payload : (payload != null ? [payload] : []);
    const result = await api[method](...args);
    
    console.log(`[phim-nguonc] Worker result for ${method}:`, result);
    self.postMessage({id, result});
    
  } catch (err) {
    console.error(`[phim-nguonc] Worker error in ${method}:`, err);
    self.postMessage({id, error: String(err?.message || err)});
  }
};
