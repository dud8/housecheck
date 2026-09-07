/**
 * Fetches recall notices from openFDA enforcement endpoints and CPSC, then
 * writes a frozen snapshot to data/recalls.json + data/manifest.json.
 *
 * Re-runnable:  node data/fetch.ts
 * Everything downstream reads the frozen snapshot, never the network.
 *
 * Both sources are keyless. openFDA allows 240 req/min and 1000 req/day per IP
 * without a key; a full run costs ~15 requests, so the sleep below is polite
 * rather than necessary.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/** Per-endpoint pull size. openFDA caps `limit` at 1000 and `skip` at 25000. */
const FDA_TARGETS = {
  food: 4000,
  drug: 3000,
  device: 4000,
} as const;

/** CPSC has no paging; one call returns every recall on or after this date. */
const CPSC_SINCE = '2019-01-01';

/**
 * A few hundred device recalls dump every affected serial number into
 * code_info; the largest observed is 8.8 MB of comma-separated lots, which
 * would make the snapshot unshippable. Those are capped and flagged so the
 * matcher can degrade to NEED_CODE instead of reasoning over a partial list
 * and emitting a false clear.
 */
const CODE_INFO_CAP = 20_000;

function capCode(text: string) {
  const s = text.trim();
  return s.length <= CODE_INFO_CAP
    ? { code_info: s }
    : { code_info: s.slice(0, CODE_INFO_CAP), code_info_truncated: s.length };
}

export type Notice = {
  id: string;
  source: 'openfda' | 'cpsc';
  domain: 'food' | 'drug' | 'device' | 'consumer';
  recall_number: string;
  firm: string;
  product_description: string;
  /** Verbatim lot/code text. The predicate engine parses exactly this. */
  code_info: string;
  /** Present only when the source text was longer than CODE_INFO_CAP; holds the true length. */
  code_info_truncated?: number;
  reason: string;
  remedy: string;
  distribution: string;
  status: string;
  classification: string;
  /** ISO yyyy-mm-dd */
  report_date: string;
  url: string;
  upcs?: string[];
  models?: string[];
};

type Query = { source: string; url: string; records: number };
const queries: Query[] = [];

/** Two CPSC records ship a malformed URL ("https:/www…", "hhttps://…"). Repair the
 *  obvious typos and keep only http(s), so every notice's source link resolves. */
const safeUrl = (raw: string): string => {
  const s = String(raw ?? '').trim().replace(/^h+ttps:/i, 'https:').replace(/^(https?:)\/(?!\/)/i, '$1//');
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
};

async function getJSON(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'housecheck/0.1' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null; // openFDA returns 404 for an empty page
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`giving up on ${url}`);
}

const iso = (yyyymmdd: string) =>
  yyyymmdd && yyyymmdd.length === 8
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : '';

async function fetchFDA(domain: keyof typeof FDA_TARGETS): Promise<Notice[]> {
  const base = `https://api.fda.gov/${domain}/enforcement.json`;
  const out: Notice[] = [];
  for (let skip = 0; skip < FDA_TARGETS[domain]; skip += 1000) {
    const url = `${base}?sort=report_date:desc&limit=1000&skip=${skip}`;
    const body = await getJSON(url);
    const rows = body?.results ?? [];
    if (!rows.length) break;
    queries.push({ source: `openfda/${domain}`, url, records: rows.length });
    for (const [i, r] of rows.entries()) {
      // more_code_info carries the overflow when code_info is truncated.
      const code = [r.code_info, r.more_code_info].filter(Boolean).join(' ').trim();
      out.push({
        // A handful of notices ship with a blank or "N/A" recall_number, so
        // fall back to the event id plus offset to keep ids unique.
        id: `fda:${/^[A-Z]-\d+-\d{4}$/.test(r.recall_number ?? '') ? r.recall_number : `${domain}-${r.event_id ?? 'x'}-${skip + i}`}`,
        source: 'openfda',
        domain,
        recall_number: r.recall_number ?? '',
        firm: r.recalling_firm ?? '',
        product_description: r.product_description ?? '',
        ...capCode(code),
        reason: r.reason_for_recall ?? '',
        remedy: '',
        distribution: r.distribution_pattern ?? '',
        status: r.status ?? '',
        classification: r.classification ?? '',
        report_date: iso(r.report_date ?? ''),
        url: `https://api.fda.gov/${domain}/enforcement.json?search=recall_number:"${r.recall_number}"`,
      });
    }
    process.stderr.write(`  ${domain}: ${out.length}\n`);
    await sleep(300);
  }
  return out;
}

async function fetchCPSC(): Promise<Notice[]> {
  const url = `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${CPSC_SINCE}`;
  const rows: any[] = await getJSON(url);
  queries.push({ source: 'cpsc', url, records: rows.length });
  return rows.map((r) => {
    const products = r.Products ?? [];
    // CPSC has no code_info field. The lot/date/model qualifiers live in the
    // recall Description free text, so that is what the predicates parse.
    const code = [r.Description, ...products.map((p: any) => p.Description)]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      id: `cpsc:${r.RecallID}`,
      source: 'cpsc' as const,
      domain: 'consumer' as const,
      recall_number: String(r.RecallNumber ?? r.RecallID),
      firm:
        (r.Manufacturers ?? []).map((m: any) => m.Name).join('; ') ||
        (r.Importers ?? []).map((m: any) => m.Name).join('; ') ||
        (r.Retailers ?? []).map((m: any) => m.Name).join('; '),
      product_description: [r.Title, ...products.map((p: any) => p.Name)]
        .filter(Boolean)
        .join(' — '),
      ...capCode(code),
      reason: (r.Hazards ?? []).map((h: any) => h.Name).join(' '),
      remedy: (r.Remedies ?? []).map((x: any) => x.Name).join(' '),
      distribution: (r.ManufacturerCountries ?? []).map((c: any) => c.Country).join(', '),
      status: '',
      classification: '',
      report_date: String(r.RecallDate ?? '').slice(0, 10),
      url: safeUrl(r.URL ?? ''),
      // CPSC returns [{ UPC: "..." }], not bare strings.
      upcs: (r.ProductUPCs ?? []).map((u: any) => (typeof u === 'string' ? u : u?.UPC)).filter(Boolean),
      models: products.map((p: any) => p.Model).filter(Boolean),
    };
  });
}

// ---------------------------------------------------------------------------
// Entry point. GUARDED: this module is also the source of the `Notice` type that
// every other file imports, and running it overwrites the committed snapshot in
// data/. Without this check a plain `import` of the type would silently re-fetch
// the corpus and replace the frozen data the tests and the demo depend on.
// ---------------------------------------------------------------------------

if (import.meta.filename !== process.argv[1]) {
  throw new Error(
    'data/fetch.ts is the ingestion script, not a library. Import its types with ' +
      '`import type`, and run it with `node data/fetch.ts` to refresh the snapshot.',
  );
}

const notices: Notice[] = [];
for (const d of Object.keys(FDA_TARGETS) as (keyof typeof FDA_TARGETS)[]) {
  process.stderr.write(`fetching openfda/${d}\n`);
  notices.push(...(await fetchFDA(d)));
}
process.stderr.write('fetching cpsc\n');
notices.push(...(await fetchCPSC()));

const dates = notices.map((n) => n.report_date).filter(Boolean).sort();
const byDomain = notices.reduce<Record<string, number>>((a, n) => {
  a[n.domain] = (a[n.domain] ?? 0) + 1;
  return a;
}, {});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'recalls.json'), JSON.stringify(notices));
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      fetched_at: new Date().toISOString(),
      generator: 'data/fetch.ts',
      total: notices.length,
      by_domain: byDomain,
      with_code_info: notices.filter((n) => n.code_info.length > 0).length,
      code_info_truncated: notices.filter((n) => n.code_info_truncated).length,
      code_info_cap: CODE_INFO_CAP,
      date_range: { earliest: dates[0], latest: dates.at(-1) },
      queries,
      notes:
        'Frozen snapshot. Downstream code reads this file only; no network access at runtime.',
    },
    null,
    2,
  ),
);
process.stderr.write(`wrote ${notices.length} notices\n`);
