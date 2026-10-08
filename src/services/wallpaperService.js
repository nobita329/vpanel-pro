const https = require('https');
const http = require('http');

const CATEGORIES = [
  { id: 'all', name: 'All Wallpapers', path: '' },
  { id: 'anime', name: 'Anime', path: '/anime/' },
  { id: 'dark', name: 'Dark / AMOLED', path: '/dark/' },
  { id: 'space', name: 'Space & Cosmos', path: '/space/' },
  { id: 'nature', name: 'Nature & Landscape', path: '/nature/' },
  { id: 'cars', name: 'Cars & Supercars', path: '/cars/' },
  { id: 'games', name: 'Gaming', path: '/games/' },
  { id: 'minimalism', name: 'Minimalist', path: '/minimalism/' },
  { id: 'abstract', name: 'Abstract & 3D', path: '/abstract/' },
  { id: 'city', name: 'City & Architecture', path: '/city/' },
  { id: 'technology', name: 'Technology & AI', path: '/technology/' },
  { id: 'animals', name: 'Animals & Wildlife', path: '/animals/' },
  { id: 'movies', name: 'Movies & TV Shows', path: '/movies/' },
  { id: 'fantasy', name: 'Fantasy', path: '/fantasy/' },
  { id: 'sci-fi', name: 'Sci-Fi', path: '/sci-fi/' },
];

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP error ${res.statusCode}`));
      }
      let html = '';
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => resolve(html));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function parseWallpapersFromHtml(html) {
  const wallpapers = [];
  // Regex to extract items: <p ... class="wallpapers__item" ...> ... </p>
  const itemRegex = /<p[^>]*class=["'][^"']*wallpapers__item[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];
    
    // Extract thumbnail and preview URLs
    const srcMatch = block.match(/src=["'](https:\/\/4kwallpapers\.com\/images\/walls\/thumbs\/(\d+)\.(jpg|png|webp))["']/i);
    const contentUrlMatch = block.match(/href=["'](https:\/\/4kwallpapers\.com\/images\/walls\/thumbs_2t\/(\d+)\.(jpg|png|webp))["']/i);
    const altMatch = block.match(/alt=["']([^"']+)["']/i);
    const keywordsMatch = block.match(/content=["']([^"']+)["']/i);

    let id = '';
    let ext = 'jpg';
    let thumb = '';
    let preview = '';
    let full = '';

    if (srcMatch) {
      thumb = srcMatch[1];
      id = srcMatch[2];
      ext = srcMatch[3];
    } else if (contentUrlMatch) {
      id = contentUrlMatch[2];
      ext = contentUrlMatch[3];
      thumb = `https://4kwallpapers.com/images/walls/thumbs/${id}.${ext}`;
    }

    if (id) {
      preview = `https://4kwallpapers.com/images/walls/thumbs_2t/${id}.${ext}`;
      full = `https://4kwallpapers.com/images/walls/thumbs_3t/${id}.${ext}`;
      const title = (altMatch ? altMatch[1] : (keywordsMatch ? keywordsMatch[1].split(',')[0] : `Wallpaper ${id}`)).trim();
      const tags = (keywordsMatch ? keywordsMatch[1].split(',').map((s) => s.trim()) : []);

      wallpapers.push({
        id,
        title,
        tags,
        thumb,
        preview,
        full,
      });
    }
  }

  // Fallback regex if schema layout differs
  if (wallpapers.length === 0) {
    const fallbackRegex = /https:\/\/4kwallpapers\.com\/images\/walls\/thumbs_2t\/(\d+)\.(jpg|png|webp)/gi;
    let fbMatch;
    const seen = new Set();
    while ((fbMatch = fallbackRegex.exec(html)) !== null) {
      const id = fbMatch[1];
      const ext = fbMatch[2];
      if (!seen.has(id)) {
        seen.add(id);
        wallpapers.push({
          id,
          title: `Wallpaper ${id}`,
          tags: ['4K', 'Ultra HD'],
          thumb: `https://4kwallpapers.com/images/walls/thumbs/${id}.${ext}`,
          preview: `https://4kwallpapers.com/images/walls/thumbs_2t/${id}.${ext}`,
          full: `https://4kwallpapers.com/images/walls/thumbs_3t/${id}.${ext}`,
        });
      }
    }
  }

  return wallpapers;
}

async function getWallpapers({ category = 'all', page = 1, query = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const cat = String(category || 'all').toLowerCase();
  const q = String(query || '').trim();

  const cacheKey = `${cat}:${p}:${q}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }

  let url = 'https://4kwallpapers.com/';

  if (q) {
    url = `https://4kwallpapers.com/search/?q=${encodeURIComponent(q)}${p > 1 ? `&page=${p}` : ''}`;
  } else if (cat && cat !== 'all') {
    const found = CATEGORIES.find((c) => c.id === cat);
    const catPath = found ? found.path : `/${cat}/`;
    url = `https://4kwallpapers.com${catPath}${p > 1 ? `?page=${p}` : ''}`;
  } else {
    if (p > 1) url = `https://4kwallpapers.com/?page=${p}`;
  }

  try {
    const html = await fetchHtml(url);
    const items = parseWallpapersFromHtml(html);

    // Check pagination
    const hasNext = html.includes(`page=${p + 1}`) || (p === 1 && (html.includes('?page=2') || html.includes('&page=2')));
    const hasPrev = p > 1;

    const result = {
      ok: true,
      category: cat,
      page: p,
      query: q,
      hasNext,
      hasPrev,
      total: items.length,
      categories: CATEGORIES,
      wallpapers: items,
    };

    cache.set(cacheKey, { time: Date.now(), data: result });
    return result;
  } catch (err) {
    // If external fetch fails, provide a rich set of built-in curated 4K wallpapers so user is never stranded
    return getCuratedFallback(cat, p, q, err.message);
  }
}

function getCuratedFallback(category, page, query, errMsg) {
  const fallbackList = [
    { id: '26984', title: 'Vortex Colorful 5K', tags: ['Abstract', '5K'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26984.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26984.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26984.jpg' },
    { id: '26940', title: 'Grand Theft Auto VI', tags: ['Gaming', '4K'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26940.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26940.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26940.jpg' },
    { id: '26970', title: 'Alcohol Ink Liquid 5K', tags: ['Abstract', 'Colors'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26970.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26970.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26970.jpg' },
    { id: '26957', title: 'McLaren 788HS Supercar', tags: ['Cars', 'Dark'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26957.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26957.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26957.jpg' },
    { id: '26937', title: 'Firefly Star Rail Anime', tags: ['Anime', '5K'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26937.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26937.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26937.jpg' },
    { id: '26972', title: 'Lah Kara Star Wars 8K', tags: ['Sci-Fi', '8K'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26972.png', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26972.png', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26972.png' },
    { id: '26741', title: 'Europa Jupiter Moon 5K', tags: ['Space', 'NASA'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26741.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26741.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26741.jpg' },
    { id: '26342', title: 'Planet Earth Dark 5K', tags: ['Space', 'Minimal'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26342.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26342.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26342.jpg' },
    { id: '26344', title: 'Moon Surface Dark 5K', tags: ['Space', 'Monochrome'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26344.png', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26344.png', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26344.png' },
    { id: '26347', title: 'Mars Red Planet 5K', tags: ['Space', 'Astronomy'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26347.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26347.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26347.jpg' },
    { id: '26348', title: 'Jupiter Great Red Spot 5K', tags: ['Space', 'Cosmos'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26348.png', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26348.png', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26348.png' },
    { id: '26864', title: 'Solo Leveling Jinwoo 4K', tags: ['Anime', 'Action'], thumb: 'https://4kwallpapers.com/images/walls/thumbs/26864.jpg', preview: 'https://4kwallpapers.com/images/walls/thumbs_2t/26864.jpg', full: 'https://4kwallpapers.com/images/walls/thumbs_3t/26864.jpg' },
  ];

  return {
    ok: true,
    category,
    page,
    query,
    hasNext: false,
    hasPrev: page > 1,
    total: fallbackList.length,
    categories: CATEGORIES,
    wallpapers: fallbackList,
    note: errMsg ? `Using curated library (${errMsg})` : undefined,
  };
}

function clearCache() {
  const size = cache.size;
  cache.clear();
  return size;
}

function getCacheSize() {
  return cache.size;
}

module.exports = {
  CATEGORIES,
  getWallpapers,
  clearCache,
  getCacheSize,
};
