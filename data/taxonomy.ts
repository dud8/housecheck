/**
 * Classifies every frozen code_info string against the pattern classes that
 * src/predicates.ts must implement, and writes data/taxonomy.json.
 *
 *   node data/taxonomy.ts            # table to stdout, JSON to data/taxonomy.json
 *   node data/taxonomy.ts LOT_RANGE  # dump matching examples for one class
 *
 * Classes are NOT mutually exclusive: a single notice routinely carries a lot
 * list, an expiry date and a UPC, and the predicate engine has to AND them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Notice } from './fetch.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
// Guarded like data/fetch.ts: running this rewrites data/taxonomy.json, so an
// accidental `import` must not do it silently.
if (import.meta.filename !== process.argv[1]) {
  throw new Error('data/taxonomy.ts is a script. Run it with `node data/taxonomy.ts`.');
}

const notices: Notice[] = JSON.parse(readFileSync(join(DIR, 'recalls.json'), 'utf8'));

export const CLASSES: Record<string, { rx: RegExp; note: string }> = {
  UNIVERSAL_ALL: {
    rx: /\ball\s+(lots?|lot\s+codes?|lot\s+numbers?|serial\s+numbers?|batch(es)?|units?|codes?|product)\b|\ball\s+unexpired\b/i,
    note: 'Recall covers every unit. Predicate is constant-true; no code needed.',
  },
  LOT_LIST: {
    rx: /\b(lots?|batch(es)?)\s*(codes?|numbers?|nos?\.?|#s?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9\-.\/]{2,}/i,
    note: 'Enumerated set membership. Exact/normalised match against a token set.',
  },
  LOT_RANGE: {
    rx: /\b(lot|batch|code|number)[^.;]{0,40}\b(through|thru)\b/i,
    note: 'Ordered range over lot codes. Needs a comparable key, not string compare.',
  },
  LOT_PREFIX: {
    rx: /\b(beginning|begins|starting|starts|start)\s+with\b|\bprefix\b/i,
    note: 'startsWith test, sometimes combined with a numeric tail comparison.',
  },
  SERIAL_LIST: {
    rx: /\bserial\s*(nos?\.?|numbers?|#)/i,
    note: 'Serial set membership; frequently paired with a per-model serial range.',
  },
  SERIAL_RANGE: {
    rx: /\bserial[^.;]{0,80}\b(through|thru|to)\b[^.;]{0,40}[A-Z0-9]/i,
    note: 'Min/max serial per model. Mixed alpha-numeric ordering is the hard part.',
  },
  OPEN_ENDED_CUTOFF: {
    rx: /\b(and|or)\s+(before|earlier|prior|sooner|lower|below|older)\b|\bprior\s+to\b|\bmanufactured\s+before\b|\bon\s+or\s+before\b|\bup\s+to\s+and\s+includ\w+\b|\ball\s+[\w\s]{0,20}dates?\s+(through|thru|up\s+to)\b/i,
    note: 'Half-open interval (x <= cutoff). A missing upper bound must not clear a unit.',
  },
  EXPIRY_DATE: {
    rx: /\b(exp(\.|iry|iration)?|expires?|BUD)\s*(date)?s?\s*[:#]?\s*(\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    note: 'Expiry equality or set membership; formats range from 10/2025 to 31-08-25.',
  },
  BEST_BY: {
    rx: /\bbest\s*(by|before|if\s+used\s+by)\b|\b(use|enjoy|fresh|pull|freeze)\s*(by|thru|through)\b|\bsell\s*(by|thru|through)\b|\bbb\s*:|\bpull\s+date\b/i,
    note: 'Consumer-facing date on the package. Highest-value key for grocery items.',
  },
  DATE_RANGE: {
    rx: /\b(between|from)\b[^.;]{0,60}\b(to|through|thru|and)\b[^.;]{0,40}\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}\s*(-|to|through)\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i,
    note: 'Closed date interval. Both endpoints must parse or the answer is NEED_CODE.',
  },
  MFG_DATE: {
    rx: /\b(manufactur\w+|produced|packed|packaging|production)\s*(on|date|dates|from|before|between)?\b[^.;]{0,30}\d/i,
    note: 'Manufacture/pack date, often the only key printed on a durable good.',
  },
  DATE_CODE_FORMAT: {
    rx: /\b(YYDDD|YYYYMM|MMDDYY|DD\.MM\.YYYY|DD\/MM\/YYYY|MM\/DD\/YY(YY)?|MM-YYYY|YYYY-MM-DD)\b/,
    note: 'Notice states the date-code layout explicitly. Free parser spec.',
  },
  JULIAN: {
    rx: /\bjulian\b/i,
    note: 'Day-of-year encoding, usually YYDDD. Range compare after decoding.',
  },
  UPC_GTIN_EAN: {
    rx: /\b(UPC|GTIN|EAN|SKU)\b/i,
    note: 'Product identity, not unit identity. Narrows the candidate set only.',
  },
  UDI: {
    rx: /\bUDI\b/i,
    note: 'Device identity; GS1 AI form (01)…(17)…(10)… embeds expiry and lot.',
  },
  MODEL_CATALOG: {
    rx: /\b(model|catalog|cat\.|REF|part|item|reference|product)\s*(nos?\.?|numbers?|#|codes?)\b/i,
    note: 'Model/catalog set membership. Gate before any lot-level test.',
  },
  MODEL_RANGE: {
    rx: /\b(model|catalog|REF|part|size|date\s*code)[^.;]{0,60}\b(through|thru)\b/i,
    note: 'Model number ranges, e.g. the classic XYZ-100 through XYZ-140 shape.',
  },
  PLANT_EST: {
    rx: /\b(plant|establishment)\s*(code|nos?\.?|numbers?|#)|\bEST\.?\s*[#:]?\s*\d{2,5}\b|\bP-\d{3,5}\b/i,
    note: 'Plant/establishment stamp. Discriminates otherwise identical packages.',
  },
  GS1_AI: {
    rx: /\(01\)\d{12,14}|\(1[07]\)\d{6}|\(2?1\)[A-Z0-9]/i,
    note: 'GS1 application identifiers inline. (01) GTIN, (17) expiry, (10)/(21) lot or serial.',
  },
  SOFTWARE_VERSION: {
    rx: /\bsoftware\s+(version|versions|rev)\b|\bfirmware\b|\bSW\s+\d+\.\d+/i,
    note: 'Device software revision as the discriminator; ordered semver-ish compare.',
  },
  MASKED_CODE: {
    rx: /[A-Z0-9]*x{3,}[A-Z0-9]*/,
    note: 'Source redacted digits (2007xxxxx to 2012xxxxx). Undecidable: NEED_CODE, never a clear.',
  },
  BARE_CODE_LIST: {
    rx: /^[^a-z:]*\b[A-Z0-9][A-Z0-9\-.\/]{4,}(\s*[,;]\s*[A-Z0-9][A-Z0-9\-.\/]{4,})+/,
    note: 'Unlabelled token list. Field type must be inferred from shape, not from a keyword.',
  },
  NO_CODE_SYSTEM: {
    rx: /\bno\s+cod(e|es|ing)\b|\bno\s+coding\s+system\b|\bnot\s+coded\b/i,
    note: 'Firm states the product carries no code. Nothing to discriminate on: every unit is in scope.',
  },
  EMPTY: {
    rx: /^\s*(n\/?a|none|not\s+applicable|unknown|-)?\s*\.?\s*$/i,
    note: 'No code text at all. Must yield NEED_CODE or AFFECTED, never a clear.',
  },
};

type Row = { cls: string; total: number; food: number; drug: number; device: number; consumer: number };

const counts = new Map<string, Row>(
  Object.keys(CLASSES).map((c) => [c, { cls: c, total: 0, food: 0, drug: 0, device: 0, consumer: 0 }]),
);
const noQualifier: Row = { cls: 'NO_QUALIFIER', total: 0, food: 0, drug: 0, device: 0, consumer: 0 };
const examples = new Map<string, { id: string; domain: string; code_info: string }[]>(
  Object.keys(CLASSES).map((c) => [c, []]),
);
examples.set('NO_QUALIFIER', []);

for (const n of notices) {
  let matched = false;
  for (const [cls, { rx }] of Object.entries(CLASSES)) {
    if (!rx.test(n.code_info)) continue;
    matched = true;
    const row = counts.get(cls)!;
    row.total++;
    row[n.domain]++;
    const ex = examples.get(cls)!;
    if (ex.length < 25 && n.code_info.length < 400)
      ex.push({ id: n.id, domain: n.domain, code_info: n.code_info });
  }
  if (!matched) {
    noQualifier.total++;
    noQualifier[n.domain]++;
    const ex = examples.get('NO_QUALIFIER')!;
    if (ex.length < 25) ex.push({ id: n.id, domain: n.domain, code_info: n.code_info.slice(0, 300) });
  }
}

const rows = [...counts.values(), noQualifier].sort((a, b) => b.total - a.total);

/**
 * How a notice can be answered. UNIT_DECIDABLE is the only bucket where two
 * owners of the same product can get different verdicts - the whole premise.
 */
const UNIT_LEVEL = [
  'LOT_LIST', 'LOT_RANGE', 'LOT_PREFIX', 'SERIAL_LIST', 'SERIAL_RANGE',
  'EXPIRY_DATE', 'BEST_BY', 'DATE_RANGE', 'MFG_DATE', 'DATE_CODE_FORMAT',
  'JULIAN', 'GS1_AI', 'BARE_CODE_LIST', 'PLANT_EST', 'SOFTWARE_VERSION',
  'OPEN_ENDED_CUTOFF',
];
const decidability = { UNIT_DECIDABLE: 0, WHOLE_PRODUCT: 0, UNDECIDABLE: 0 };
for (const n of notices) {
  const hits = Object.entries(CLASSES).filter(([, c]) => c.rx.test(n.code_info)).map(([k]) => k);
  if (n.code_info_truncated || hits.includes('MASKED_CODE')) decidability.UNDECIDABLE++;
  else if (hits.some((h) => UNIT_LEVEL.includes(h))) decidability.UNIT_DECIDABLE++;
  else decidability.WHOLE_PRODUCT++;
}
const truncated = notices.filter((n) => n.code_info_truncated).length;

const only = process.argv[2];
if (only) {
  for (const e of examples.get(only) ?? []) console.log(`[${e.domain}] ${e.code_info}\n`);
} else {
  const pct = (x: number) => `${((100 * x) / notices.length).toFixed(1)}%`;
  console.log(`corpus: ${notices.length} notices\n`);
  console.log('class'.padEnd(20) + 'n'.padStart(6) + 'share'.padStart(8) + '  food/drug/device/consumer');
  for (const r of rows)
    console.log(
      r.cls.padEnd(20) +
        String(r.total).padStart(6) +
        pct(r.total).padStart(8) +
        `  ${r.food}/${r.drug}/${r.device}/${r.consumer}`,
    );
  console.log(`\nTRUNCATED (snapshot cap) ${truncated}`);
  console.log('\ndecidability:');
  for (const [k, v] of Object.entries(decidability)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)} ${pct(v)}`);
}

writeFileSync(
  join(DIR, 'taxonomy.json'),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      corpus: notices.length,
      classes: rows.map((r) => ({
        ...r,
        note: CLASSES[r.cls]?.note ?? 'No recognised discriminator in the notice text.',
        pattern: CLASSES[r.cls]?.rx.source ?? null,
        examples: examples.get(r.cls)?.slice(0, 10) ?? [],
      })),
      truncated_code_info: truncated,
      decidability,
    },
    null,
    2,
  ),
);
