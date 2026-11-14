// VEROKIMALL static public search index builder (Node 18+).
// Reads ONLY public category listings (same contract as the Railway server's
// SourceClient.inventory). Restricted menus are never requested or emitted.
// Usage: node build-index.mjs [outDir]
import { parseHTML } from 'linkedom';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SITE = 'https://verokimall.shop';
const PRIVATE = new Set(['85','624','625','626','627','628','629','630','631','632','633','634','635','636','637','638','639','640','641','642','1121','700']);
const ROOTS = ['464','78','79','80','81','82','83','1187'];
const INTERVAL = 800; // ms between requests; polite single-threaded crawl
const outDir = process.argv[2] || 'dist';

const clean = v => String(v ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
const pathId = href => new URL(href, SITE).pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || '';
const parse = html => parseHTML(html).document;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cookies = new Map();
let next = 0, requests = 0;
async function get(path, headers = {}) {
  const url = new URL(path, SITE);
  if (url.origin !== SITE || PRIVATE.has(pathId(url.href))) throw new Error('Unsafe source URL ' + url);
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = Math.max(Date.now(), next); next = start + INTERVAL; await sleep(start - Date.now());
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), headers: {
        'User-Agent': 'VEROKIMALL-Static-Indexer/1.0 (+https://verokimall.shop)', 'Accept': 'text/html,application/json',
        'Cookie': [...cookies].map(([k, v]) => k + '=' + v).join('; '), ...headers } });
      requests++;
      if (res.status === 403 || res.status === 429) throw Object.assign(new Error('Source refused ' + res.status + '; stopping'), { fatal: true });
      if (res.status >= 300 && res.status < 400) throw Object.assign(new Error('Redirect not followed: ' + url), { fatal: true });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      for (const c of res.headers.getSetCookie?.() || []) { const p = c.split(';')[0], i = p.indexOf('='); if (i > 0) cookies.set(p.slice(0, i), p.slice(i + 1)); }
      const text = await res.text();
      if (/요청\s*과다|too many requests|request blocked/i.test(text.slice(0, 10000))) throw Object.assign(new Error('Block page detected'), { fatal: true });
      return text;
    } catch (e) { if (e.fatal || attempt === 2) throw e; await sleep(2000 * (attempt + 1)); }
  }
}

function publicHref(href, idx) {
  const url = new URL(href, SITE);
  if (url.origin !== SITE || PRIVATE.has(pathId(url.href))) throw new Error('Non-public product path');
  if (String(url.searchParams.get('idx')) !== String(idx)) throw new Error('Product ID mismatch');
  return url.pathname + url.search;
}
function extractInventory(html, menu) {
  const out = [], starts = [...html.matchAll(/<div\b[^>]*class=["'][^"']*\bshop-item\b[^"']*["'][^>]*>/gi)];
  for (let i = 0; i < starts.length; i++) {
    const fragment = html.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const card = parse(fragment).querySelector('.shop-item[data-product-properties]');
    if (!card) throw new Error('Product markup changed');
    for (const n of card.querySelectorAll('script,style,noscript')) n.remove();
    const p = JSON.parse(card.getAttribute('data-product-properties'));
    if (!/^\d+$/.test(String(p.idx)) || !clean(p.name)) throw new Error('Invalid inventory record');
    const href = [...card.querySelectorAll('a[href*="idx="]')].map(a => a.getAttribute('href'))
      .find(h => { try { return !PRIVATE.has(pathId(h)) && new URL(h, SITE).origin === SITE; } catch { return false; } });
    if (!href) throw new Error('Inventory record lacks public product link');
    const amount = Number(p.price);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid product price');
    out.push({ idx: String(p.idx), href: publicHref(href, p.idx), title: clean(p.name), price: amount.toLocaleString('en-US') + '원', image: String(p.image_url || ''), cardText: clean(card.textContent), menu });
  }
  if (!out.length && /data-product-properties\s*=/.test(html)) throw new Error('Product markup changed');
  return out;
}
function discoverMenus(html) {
  const menus = new Set(ROOTS);
  for (const n of parse(html).querySelectorAll('#mobile_carousel_menu .nav-item[data-url],.mobile_table_nav .nav-item[data-url]')) {
    const id = String(n.getAttribute('data-url') || '').replace(/^\/|\/$/g, '');
    if (/^\d+$/.test(id) && !PRIVATE.has(id)) menus.add(id);
  }
  return [...menus];
}
function categoryConfig(html, menu) {
  // Match Imweb's widget config call, not other scripts (e.g. the site search script) that mention the URL.
  const callMatch = html.match(/url\s*:\s*\(\s*['"]\/ajax\/get_shop_list_view\.cm['"]\s*\)/);
  const at = callMatch ? callMatch.index : -1;
  if (at < 0) { if (parse(html).querySelector('.shop-content,.shop-grid')) throw new Error('Shopping list contract changed: ' + menu); return null; }
  const block = html.slice(at, at + 2600);
  const field = name => block.match(new RegExp('["\']' + name + '["\']\\s*:\\s*["\']([^"\']*)["\']'))?.[1];
  const category = field('category'), widget_code = field('widget_code'), menu_url = field('menu_url');
  if (!category || !widget_code || !menu_url || new URL(menu_url, SITE).pathname.replace(/\/$/, '') !== '/' + menu) throw new Error('Category configuration unavailable: ' + menu);
  const pageCount = Number(html.match(/var\s+page_count\s*=\s*(\d+)/)?.[1]);
  const pageSize = Number(block.match(/["']pagesize["']\s*:\s*(\d+)/)?.[1]);
  if (!Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Total category count unavailable: ' + menu);
  return { category, widget_code, menu_url, pageCount, pageSize };
}

const startedAt = Date.now();
const home = await get('/');
const menus = discoverMenus(home), queued = new Set(menus), products = new Map(), scopes = [];
for (const menu of menus) {
  const html = await get('/' + menu), cfg = categoryConfig(html, menu);
  if (!cfg) {
    for (const a of parse(html).querySelectorAll('main a[href]')) {
      const m = a.getAttribute('href')?.match(/^\/(\d+)\/?$/);
      if (m && !PRIVATE.has(m[1]) && !queued.has(m[1])) { queued.add(m[1]); menus.push(m[1]); }
    }
    scopes.push({ menu, count: 0, landing: true }); continue;
  }
  const upper = Math.max(1, cfg.pageCount * cfg.pageSize), lower = Math.max(0, (cfg.pageCount - 1) * cfg.pageSize);
  const q = new URLSearchParams({ category: cfg.category, widget_code: cfg.widget_code, menu_url: cfg.menu_url, page: '1', pagesize: String(upper), sort: 'recent' });
  const payload = JSON.parse(await get('/ajax/get_shop_list_view.cm?' + q, { 'Referer': SITE + '/' + menu, 'X-Requested-With': 'XMLHttpRequest' }));
  if (payload.msg !== 'SUCCESS' || typeof payload.html !== 'string') throw new Error('Inventory API failed: ' + menu);
  const rows = extractInventory(payload.html, menu), seen = new Set();
  if (rows.length > upper || (cfg.pageCount > 0 && rows.length <= lower)) throw new Error('Full category count not verified: ' + menu + ' rows=' + rows.length + ' bounds=' + lower + '-' + upper);
  for (const r of rows) {
    if (seen.has(r.idx)) throw new Error('Duplicate category item: ' + menu);
    seen.add(r.idx);
    const old = products.get(r.idx);
    if (!old || r.href.localeCompare(old.href) < 0) products.set(r.idx, r);
  }
  scopes.push({ menu, count: seen.size });
  console.error('menu', menu, 'rows', rows.length, 'total', products.size);
}
if (!products.size) throw new Error('No public products collected');

// Compact row format: [idx, href, title, price, image, cardText]
const list = [...products.values()].sort((a, b) => Number(b.idx) - Number(a.idx));
const verifiedAt = Date.now();
const index = { schema: 1, format: 'rows-v1', scope: 'public', complete: true, revision: randomUUID(), startedAt, verifiedAt,
  count: list.length, requests, scopes, fields: ['idx', 'href', 'title', 'price', 'image', 'cardText'],
  rows: list.map(p => [p.idx, p.href, p.title, p.price, p.image, p.cardText]) };
mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(index);
writeFileSync(join(outDir, 'public-index.json'), json);
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ revision: index.revision, verifiedAt, count: list.length, scopes }));
console.log(JSON.stringify({ count: list.length, requests, seconds: Math.round((verifiedAt - startedAt) / 1000), bytes: json.length, gzipBytes: gzipSync(json).length, scopes }));
