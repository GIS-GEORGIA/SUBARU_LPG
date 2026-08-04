// scrape.mjs — საწვავის ფასების scraper (dependency-free, Node 18+/20+/24)
//
// წყაროები:
//   1) priceshub.ge  — მთავარი (8 კომპანია, სერვერ-რენდერდ ცხრილები)
//   2) geogid.ge     — მეორეული / ჯვარედინი შემოწმება (თითო კომპანიის გვერდზე ჩაშენებული JSON სერია)
//
// შედეგი: data/prices.json — კატეგორიების მიხედვით დალაგებული (იაფიდან ძვირისკენ),
// ცალკე cheapest, კომპანიების ნედლი პროდუქტები და discrepancies (სად არ ემთხვევა წყაროები).
//
// tarifebi.ge განზრახ არ გამოიყენება — Cloudflare Turnstile-ს (ბოტ-დაცვას) იყენებს.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'prices.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// კომპანიის კანონიკური სია (ქართული სახელი → key + label + geogid slug)
// geogid: null → geogid.ge ამ კომპანიას არ ფარავს (არასწორი slug default გვერდს აბრუნებს),
// ამიტომ ჯვარედინი შემოწმება მისთვის არ ხდება.
const COMPANIES = [
  { key: 'socar',     ka: 'სოკარი',     geogid: 'socar' },
  { key: 'gulf',      ka: 'გალფი',      geogid: 'gulf' },
  { key: 'wissol',    ka: 'ვისოლი',     geogid: 'wissol' },
  { key: 'rompetrol', ka: 'რომპეტროლი', geogid: null },
  { key: 'portal',    ka: 'პორტალი',    geogid: 'portal' },
  { key: 'connect',   ka: 'ქონექთი',    geogid: 'connect' },
  { key: 'lukoil',    ka: 'ლუკოილი',    geogid: null },
  { key: 'neogas',    ka: 'ნეოგაზი',    geogid: null },
];
const byKa = Object.fromEntries(COMPANIES.map(c => [c.ka, c]));

// კატეგორიები — თანმიმდევრობა = ჩვენების რიგი
const CATEGORIES = {
  regular: 'რეგულარი (92/93)',
  premium: 'პრემიუმი (95)',
  super:   'სუპერი (98)',
  diesel:  'დიზელი',
  lpg:     'თხევადი გაზი (LPG)',
  cng:     'ბუნებრივი აირი (CNG)',
};

// განსხვავების ზღვარი (₾), რომლის ზემოთაც წყაროებს შორის შეუსაბამობა აღინიშნება
const DISCREPANCY_THRESHOLD = 0.05;

// ---- helpers ----
const stripTags = s => s.replace(/<[^>]+>/g, ' ');
const decode = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const clean = s => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ka,en;q=0.8' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// საწვავის ტიპის კლასიფიკაცია სახელისა და (თუ არსებობს) ოქტანის მიხედვით
function classify(name, octane) {
  const n = name.toLowerCase();
  const o = String(octane || '');
  if (/თხევადი|lpg/.test(n)) return 'lpg';
  if (/ბუნებრივი|cng/.test(n)) return 'cng';
  if (/დიზ|diesel/.test(n)) return 'diesel';
  if (/სუპერ|super/.test(n) || o === '98') return 'super';
  if (/პრემიუმ|premium/.test(n) || o === '95') return 'premium';
  if (/რეგულარ|regular/.test(n) || /^9[23](\/9[23])?$/.test(o)) return 'regular';
  return null;
}

// ---------- Source 1: priceshub.ge ----------
async function scrapePriceshub() {
  const html = await fetchText('https://priceshub.ge/');
  const out = {}; // key -> [{name, octane, price, category}]
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const table = m[0];
    // კომპანია — ცხრილის წინ მდებარე უახლესი <h*> სათაური
    const pre = html.slice(Math.max(0, m.index - 700), m.index);
    const heads = [...pre.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(x => clean(x[1]));
    const companyKa = heads.reverse().find(h => byKa[h]);
    const company = companyKa ? byKa[companyKa] : null;
    if (!company) continue;

    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(r =>
      [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => clean(c[1]))
    );
    for (const cells of rows) {
      if (cells.length < 3) continue;
      const [name, octane, priceRaw] = cells;
      const price = parseFloat(String(priceRaw).replace(',', '.'));
      if (!name || !Number.isFinite(price)) continue;
      const category = classify(name, octane);
      if (!category) continue;
      (out[company.key] ||= []).push({ name, octane: octane || '', price, category });
    }
  }
  return out;
}

// ---------- Source 2: geogid.ge (per company) ----------
async function scrapeGeogidCompany(company) {
  const html = await fetchText(`https://geogid.ge/fuel.php?company=${company.geogid}`);
  const out = [];
  // ჩაშენებული JSON: "საწვავის სახელი":[{"x":"...","y":ფასი}, ... ] — ბოლო ჩანაწერი = მიმდინარე
  const arrRe = /"([^"]{2,60}?)":\[((?:\{"x":"[^"]*","y":[0-9.]+\},?)+)\]/g;
  let m;
  const seen = new Set();
  while ((m = arrRe.exec(html)) !== null) {
    const name = decode(m[1]);
    const category = classify(name, '');
    if (!category) continue;
    const ys = [...m[2].matchAll(/"y":([0-9.]+)/g)].map(x => parseFloat(x[1]));
    const price = ys[ys.length - 1];
    if (!Number.isFinite(price)) continue;
    const dedupKey = name + '|' + price;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ name, octane: '', price, category });
  }
  return out;
}

async function scrapeGeogid() {
  const out = {};
  for (const c of COMPANIES) {
    if (!c.geogid) continue; // geogid ამ კომპანიას არ ფარავს
    try {
      const products = await scrapeGeogidCompany(c);
      if (products.length) out[c.key] = products;
    } catch (e) {
      console.warn(`geogid ${c.key}: ${e.message}`);
    }
  }
  return out;
}

// per company/category → ყველაზე დაბალი ფასი (ერთ კომპანიას შეიძლება ბრენდირებული + უბრალო ჰქონდეს)
function minByCategory(products) {
  const map = {};
  for (const p of products || []) {
    if (!(p.category in map) || p.price < map[p.category].price) map[p.category] = p;
  }
  return map; // category -> {name, octane, price}
}

async function main() {
  const [ph, gg] = await Promise.all([
    scrapePriceshub().catch(e => { console.error('priceshub failed:', e.message); return {}; }),
    scrapeGeogid().catch(e => { console.error('geogid failed:', e.message); return {}; }),
  ]);

  if (!Object.keys(ph).length) {
    throw new Error('მთავარი წყარო (priceshub) ცარიელია — ვჩერდები, რომ არ დაიწეროს ცუდი მონაცემი.');
  }

  const phMin = Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, minByCategory(v)]));
  const ggMin = Object.fromEntries(Object.entries(gg).map(([k, v]) => [k, minByCategory(v)]));

  // კატეგორიების აგება priceshub-ის ბაზაზე, geogid ჯვარედინ შესამოწმებლად
  const categories = {};
  const discrepancies = [];
  const cheapest = {};

  for (const [cat, label] of Object.entries(CATEGORIES)) {
    const ranking = [];
    for (const c of COMPANIES) {
      const p = phMin[c.key]?.[cat];
      if (!p) continue;
      const g = ggMin[c.key]?.[cat];
      const entry = {
        company: c.key,
        label: c.ka,
        price: p.price,
        product: p.name,
        octane: p.octane,
      };
      if (g) {
        entry.cross = { geogid: g.price, diff: +(p.price - g.price).toFixed(2) };
        if (Math.abs(p.price - g.price) > DISCREPANCY_THRESHOLD) {
          discrepancies.push({
            company: c.key, label: c.ka, category: cat,
            priceshub: p.price, geogid: g.price, diff: +(p.price - g.price).toFixed(2),
          });
        }
      }
      ranking.push(entry);
    }
    ranking.sort((a, b) => a.price - b.price);
    categories[cat] = { label, ranking };
    if (ranking.length) cheapest[cat] = { company: ranking[0].company, label: ranking[0].label, price: ranking[0].price };
  }

  const companies = {};
  for (const c of COMPANIES) {
    if (ph[c.key]) companies[c.key] = { label: c.ka, products: ph[c.key] };
  }

  const now = new Date();
  const tbilisi = new Intl.DateTimeFormat('ka-GE', {
    timeZone: 'Asia/Tbilisi', dateStyle: 'medium', timeStyle: 'short',
  }).format(now);

  const data = {
    updated: now.toISOString(),
    updatedTbilisi: tbilisi,
    currency: 'GEL',
    sources: ['priceshub.ge', 'geogid.ge'],
    categories,
    cheapest,
    companies,
    discrepancies,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // მოკლე რეზიუმე ლოგში
  console.log(`✓ ${OUT}`);
  console.log(`  updated: ${tbilisi}`);
  for (const [cat, { ranking }] of Object.entries(categories)) {
    if (!ranking.length) continue;
    const top = ranking[0];
    console.log(`  ${cat.padEnd(8)} → ${top.label} ${top.price.toFixed(2)}₾ (${ranking.length} კომპ.)`);
  }
  if (discrepancies.length) {
    console.log(`  ⚠ ${discrepancies.length} შეუსაბამობა წყაროებს შორის (>${DISCREPANCY_THRESHOLD}₾)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
