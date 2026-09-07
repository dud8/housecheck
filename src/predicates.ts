/**
 * src/predicates.ts — the predicate engine.
 *
 * Turns a recall notice's `code_info` free text into DECIDABLE PREDICATES over a
 * specific unit's printed codes, so that two owners of the same product can get
 * two different answers.
 *
 * Every predicate answers YES / NO / UNKNOWN. UNKNOWN is a first-class result:
 * it is what makes the tool honest, and it is always preferred over guessing.
 *
 * SAFETY RULE (see data/CODE_INFO_TAXONOMY.md, "Consequences for the matcher"):
 * a clear (NOT_AFFECTED) is legal only when every clause parsed, the user
 * supplied every key those clauses need, the source text was complete, and at
 * least one clause definitively excludes the unit. Anything else is NEED_CODE.
 * A false clear is the worst failure this program can produce.
 *
 * Shape of the engine:
 *   1. scan `code_info` for field LABELS ("Lot Code:", "Best By", "UDI", ...)
 *   2. slice the text between labels into SEGMENTS
 *   3. classify each segment's value shape: universal / cutoff / range / prefix / list
 *   4. compile each into a Clause with a test(value) -> Tri
 *   5. OR clauses that share a key, AND across keys (a notice that lists two
 *      lot/date pairs means "either pair"; a notice with a model gate and a lot
 *      list means "model AND lot")
 *
 * Ambiguity is modelled as a DISJUNCTION OF HYPOTHESES rather than resolved by a
 * coin flip: a date like 06/08/28 yields both the MDY and DMY readings, a Julian
 * code yields every encoding that decodes validly, and the combinator returns
 * YES if any hypothesis says affected, NO only if every hypothesis says clear.
 * That biases uncertainty toward AFFECTED, never toward a clear.
 */

import type { Notice } from '../data/fetch.ts';

export type Tri = 'YES' | 'NO' | 'UNKNOWN';

/** The kinds of code a consumer can actually read off a package or label. */
export type KeyKind =
  | 'lot'
  | 'best_by'
  | 'expiry'
  | 'mfg_date'
  | 'julian'
  | 'date_code'
  | 'model'
  | 'serial'
  | 'upc'
  | 'udi'
  | 'software'
  | 'plant';

export type UnitCodes = Partial<Record<KeyKind, string>>;

export type ClauseForm = 'list' | 'range' | 'cutoff' | 'prefix' | 'universal';

export type Clause = {
  key: KeyKind;
  form: ClauseForm;
  /** Taxonomy class from data/CODE_INFO_TAXONOMY.md that this clause came from. */
  cls: string;
  /** Verbatim slice of code_info this clause reasoned over. Always surfaced. */
  evidence: string;
  /** The FULL segment text this clause compiled from. Longer than `evidence`,
   *  which is clipped for display. Tests read tokens from here so they cannot
   *  be fooled by the same clipping the engine applies. */
  source: string;
  /** The question to ask when the unit's value for `key` is missing. */
  question: string;
  test(value: string | undefined): Tri;
};

export type Parsed = {
  clauses: Clause[];
  /** True when nothing in the text discriminates units: every unit is in scope. */
  wholeProduct: boolean;
  /** True when the source text is truncated or redacted. Forbids any NO. */
  sourceIncomplete: boolean;
  /** Exclusion / inspection clauses lifted verbatim; shown, never auto-applied. */
  caveats: string[];
  /** "The date code is etched on the ..." — appended to questions when present. */
  locationHint?: string;
};

// ---------------------------------------------------------------------------
// tri-state combinators
// ---------------------------------------------------------------------------

/** Disjunction of hypotheses: YES wins, NO only when every hypothesis says NO. */
export function anyOf(results: Tri[]): Tri {
  if (!results.length) return 'UNKNOWN';
  if (results.includes('YES')) return 'YES';
  return results.every((r) => r === 'NO') ? 'NO' : 'UNKNOWN';
}

/** Conjunction across independent gates: NO wins, YES needs every gate YES. */
export function allOf(results: Tri[]): Tri {
  if (!results.length) return 'UNKNOWN';
  if (results.includes('NO')) return 'NO';
  return results.every((r) => r === 'YES') ? 'YES' : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

/** Codes are compared on alphanumerics only: "LZ1 R169" === "lz1-r169". */
export const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------------------
// dates — a value is an inclusive span of day numbers, so "11/2028" (a whole
// month) and "March 15, 2028" (a day) compare with the same code path.
// ---------------------------------------------------------------------------

export type Span = { lo: number; hi: number };

const DAY_MS = 86_400_000;
const NEG = Number.NEGATIVE_INFINITY;
const POS = Number.POSITIVE_INFINITY;

const dayNum = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS;

const validYear = (y: number): boolean => y >= 1990 && y <= 2060;

function day(y: number, m: number, d: number): Span | null {
  if (!validYear(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null; // 31 Feb etc.
  const n = dayNum(y, m, d);
  return { lo: n, hi: n };
}

function month(y: number, m: number): Span | null {
  if (!validYear(y) || m < 1 || m > 12) return null;
  return { lo: dayNum(y, m, 1), hi: dayNum(y, m + 1, 1) - 1 };
}

const yr = (s: string): number => {
  const n = Number(s);
  return s.length === 4 ? n : n < 70 ? 2000 + n : 1900 + n;
};

const MON =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const monthOf = (w: string): number => MONTH_INDEX[w.slice(0, 3).toLowerCase()] ?? 0;

export type DateCtx = {
  /** Year to assume when a date carries none (the notice's report year). */
  contextYear?: number;
  /** Set when the notice annotates its own order, e.g. "13/01/2026 (DD/MM/YYYY)". */
  order?: 'MDY' | 'DMY';
};

const dedupe = (spans: (Span | null)[]): Span[] => {
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const s of spans) {
    if (!s) continue;
    const k = `${s.lo}:${s.hi}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
};

/**
 * Every plausible reading of one date token. More than one span means the token
 * is genuinely ambiguous in the source (06/08/28 is both 8 Jun 2028 and 6 Aug
 * 2028); the caller keeps them all rather than picking.
 */
export function dateSpans(tok: string, ctx: DateCtx = {}): Span[] {
  const t = tok.trim().replace(/\s+/g, ' ');
  const out: (Span | null)[] = [];
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) {
    out.push(day(+m[1], +m[2], +m[3]));
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t))) {
    const y = yr(m[3]);
    if (ctx.order !== 'DMY') out.push(day(y, +m[1], +m[2])); // US month-first
    if (ctx.order !== 'MDY') out.push(day(y, +m[2], +m[1])); // day-first
  } else if ((m = new RegExp(`^(${MON})\\.?[\\s,./-]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,./-]+(\\d{4})$`, 'i').exec(t))) {
    out.push(day(+m[3], monthOf(m[1]), +m[2]));
  } else if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[\\s./-]*(${MON})\\.?[\\s,./-]*(\\d{2,4})$`, 'i').exec(t))) {
    out.push(day(yr(m[3]), monthOf(m[2]), +m[1]));
  } else if ((m = new RegExp(`^(${MON})\\.?\\s+(\\d{1,2})\\s*[.,]\\s*(\\d{2})$`, 'i').exec(t))) {
    out.push(day(yr(m[3]), monthOf(m[1]), +m[2])); // "May 05. 26"
  } else if ((m = new RegExp(`^(${MON})\\.?[\\s,./-]*(\\d{2,4})$`, 'i').exec(t))) {
    const mo = monthOf(m[1]);
    out.push(month(yr(m[2]), mo)); // "OCT 2028", "Apr-25"
    // "DEC08" is also read as day 8 of December in the notice's own year.
    if (m[2].length === 2 && ctx.contextYear) out.push(day(ctx.contextYear, mo, +m[2]));
  } else if ((m = new RegExp(`^(${MON})\\.?$`, 'i').exec(t)) && ctx.contextYear) {
    out.push(month(ctx.contextYear, monthOf(m[1])));
  } else if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(t))) {
    out.push(month(+m[1], +m[2]));
  } else if ((m = /^(\d{1,2})[-/.](\d{2,4})$/.exec(t))) {
    out.push(month(yr(m[2]), +m[1]));
  } else if (/^\d{8}$/.test(t)) {
    out.push(day(+t.slice(0, 4), +t.slice(4, 6), +t.slice(6, 8))); // YYYYMMDD
    out.push(day(yr(t.slice(4, 8)), +t.slice(0, 2), +t.slice(2, 4))); // MMDDYYYY
    out.push(day(yr(t.slice(4, 8)), +t.slice(2, 4), +t.slice(0, 2))); // DDMMYYYY
  } else if (/^\d{6}$/.test(t)) {
    out.push(month(+t.slice(0, 4), +t.slice(4, 6))); // YYYYMM
    out.push(day(yr(t.slice(4, 6)), +t.slice(0, 2), +t.slice(2, 4))); // MMDDYY
    out.push(day(yr(t.slice(0, 2)), +t.slice(2, 4), +t.slice(4, 6))); // YYMMDD
    out.push(day(yr(t.slice(4, 6)), +t.slice(2, 4), +t.slice(0, 2))); // DDMMYY
  }
  return dedupe(out);
}

const DATE_RX = new RegExp(
  [
    `(?<!\\d)\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?!\\d)`,
    `(?<!\\d)\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}(?!\\d)`,
    `\\b${MON}\\.?[\\s,./-]*\\d{1,2}(?:st|nd|rd|th)?[\\s,./-]+\\d{4}(?!\\d)`,
    `(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?[\\s./-]*${MON}\\.?[\\s,./-]*\\d{2,4}(?!\\d)`,
    `\\b${MON}\\.?\\s+\\d{1,2}\\s*[.,]\\s*\\d{2}(?!\\d)`,
    `\\b${MON}\\.?[\\s,./-]*\\d{2,4}(?!\\d)`,
    `\\b${MON}\\b`,
    `(?<!\\d)\\d{4}[-/.]\\d{1,2}(?!\\d)`,
    `(?<!\\d)\\d{1,2}[-/.]\\d{2,4}(?!\\d)`,
    `(?<!\\d)\\d{8}(?!\\d)`,
    `(?<!\\d)\\d{6}(?!\\d)`,
  ].join('|'),
  'gi',
);

export type FoundDate = { text: string; index: number; spans: Span[] };

/** Every date-looking substring, in order, with all its plausible readings. */
export function findDates(s: string, ctx: DateCtx = {}): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of s.matchAll(DATE_RX)) {
    const spans = dateSpans(m[0], ctx);
    if (spans.length) out.push({ text: m[0], index: m.index ?? 0, spans });
  }
  return out;
}

/** YES when the unit's date sits wholly inside a recalled window. */
function spanTest(windows: Span[], user: Span[]): Tri {
  if (!windows.length || !user.length) return 'UNKNOWN';
  let anyYes = false;
  let allDisjoint = true;
  for (const u of user) {
    for (const w of windows) {
      if (u.lo >= w.lo && u.hi <= w.hi) anyYes = true;
      if (!(u.hi < w.lo || u.lo > w.hi)) allDisjoint = false;
    }
  }
  if (anyYes) return 'YES';
  return allDisjoint ? 'NO' : 'UNKNOWN'; // partial overlap => not decidable
}

// ---------------------------------------------------------------------------
// structural code ordering — "2017-37-FY through 2018-22-FY",
// "1G20MB20001 through 1L17MB20228", "7010.000160 and lower".
//
// ponytail: treats a code as a positional odometer (digit runs compare
// numerically, letter runs lexicographically) and refuses to compare codes whose
// run layouts differ. That is how these ranges are written in practice; a
// mismatch returns UNKNOWN rather than a guess.
// ---------------------------------------------------------------------------

type Part = { t: 'd' | 'a'; v: string };

export function structKey(s: string): Part[] {
  return (s.toUpperCase().match(/\d+|[A-Z]+/g) ?? []).map((v) =>
    /^\d/.test(v) ? { t: 'd' as const, v } : { t: 'a' as const, v },
  );
}

export function structCmp(a: Part[], b: Part[]): number | null {
  if (!a.length || a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].t !== b[i].t) return null;
    let c: number;
    if (a[i].t === 'd') c = Number(a[i].v) - Number(b[i].v);
    else c = a[i].v < b[i].v ? -1 : a[i].v > b[i].v ? 1 : 0;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

function structRangeTest(lo: string | null, hi: string | null, v: string): Tri {
  const k = structKey(v);
  if (!k.length) return 'UNKNOWN';
  const a = lo === null ? 1 : structCmp(k, structKey(lo));
  const b = hi === null ? -1 : structCmp(k, structKey(hi));
  if (a === null || b === null) return 'UNKNOWN';
  return a >= 0 && b <= 0 ? 'YES' : 'NO';
}

// ---------------------------------------------------------------------------
// Julian codes
// ---------------------------------------------------------------------------

type JulianHyp = { fmt: string; domain: 'date' | 'doy'; value: number };

/**
 * Every valid decoding of one Julian token. Field order is inferred, never
 * assumed: "3355" decodes as DDDY (day 335 of 2025) but not as YDDD, because
 * 536 is not a day of the year — which is exactly how the corpus's
 * "Julian Dates 3355 to 1536" resolves.
 */
export function julianHyps(tok: string, ctx: DateCtx = {}): JulianHyp[] {
  const digits = tok.replace(/[^0-9]/g, '');
  const base = ctx.contextYear ?? new Date().getUTCFullYear();
  const out: JulianHyp[] = [];
  const asDate = (fmt: string, y: number, ddd: number) => {
    if (!validYear(y) || ddd < 1 || ddd > 366) return;
    const n = dayNum(y, 1, 1) + ddd - 1;
    if (new Date(n * DAY_MS).getUTCFullYear() !== y) return; // day 366 of a common year
    out.push({ fmt, domain: 'date', value: n });
  };
  const decade = (d: number): number => {
    const y = Math.floor(base / 10) * 10 + d;
    return y > base + 1 ? y - 10 : y;
  };
  if (digits.length === 3) {
    const ddd = +digits;
    if (ddd >= 1 && ddd <= 366) out.push({ fmt: 'DDD', domain: 'doy', value: ddd });
  } else if (digits.length === 4) {
    asDate('YDDD', decade(+digits.slice(0, 1)), +digits.slice(1));
    asDate('DDDY', decade(+digits.slice(3)), +digits.slice(0, 3));
  } else if (digits.length === 5) {
    asDate('YYDDD', yr(digits.slice(0, 2)), +digits.slice(2));
    asDate('DDDYY', yr(digits.slice(3)), +digits.slice(0, 3));
  } else if (digits.length === 7) {
    asDate('YYYYDDD', +digits.slice(0, 4), +digits.slice(4));
  }
  return out;
}

// ---------------------------------------------------------------------------
// label scanning
// ---------------------------------------------------------------------------

type LabelSpec = { re: RegExp; key: KeyKind | 'ignore' };

/**
 * Ordered only for readability — collisions are resolved by "longest match at
 * the earliest index wins", so "Manufactured for" beats "Manufactured" and
 * "Lot Code" beats the generic "Code".
 */
const LABELS: LabelSpec[] = [
  { re: /\b(?:time\s*stamp|distributed\s+by|manufactured\s+for|packed\s+by|sold\s+(?:at|by|exclusively)|imported\s+by|repackaged\s+by)\b/gi, key: 'ignore' },
  { re: /\b(?:dates?\s+of\s+(?:manufacture|production)|date\s+of\s+manufacture|manufactur(?:e|ed|ing)(?:\s+dates?)?|production\s+dates?|produced(?:\s+on)?|packed\s+on(?:\s+dates?)?|pack(?:aging|ed)?\s+dates?|code\s+dates?|\bdom\b)\b/gi, key: 'mfg_date' },
  { re: /\bdate\s*codes?\b/gi, key: 'date_code' },
  { re: /\bjulian(?:\s+(?:dates?|days?|calendar|codes?))?\b/gi, key: 'julian' },
  { re: /(?:\bbest\s*(?:by|before|if\s+used\s+by)(?:\s*\/\s*sell\s*by)?|\bsell\s*(?:by|thru|through)|\buse\s*(?:by|thru|through)|\bused\s+by|\benjoy\s+by|\bfresh\s+thru|\bpull\s+dates?|\bfreeze\s+by|\bbb(?=\s*[:#]))(?:\s+dates?)?(?:\s+codes?)?(?:\s*\(\s*s\s*\))?\b/gi, key: 'best_by' },
  { re: /\bexp(?:\.|iry|iration|ires|ired|ire)?(?:\s+dates?)?(?:\s+codes?)?(?:\s*\(\s*s\s*\))?\b|\bbud\b/gi, key: 'expiry' },
  { re: /\blots?\s*(?:codes?\s*\(\s*s\s*\)|numbers?\s*\(\s*s\s*\)|codes?|numbers?|nos?\.?|#s?|ids?)?\b|\bbatch(?:es)?\s*(?:codes?|numbers?|nos?\.?|#s?)?\b/gi, key: 'lot' },
  { re: /\bserial\s*(?:numbers?|nos?\.?|#s?)?\b|\bs\/n\b/gi, key: 'serial' },
  { re: /\bmodel(?:\s*\/\s*catalog)?\s*(?:numbers?|nos?\.?|#s?|codes?)?\b|\bcatalog(?:ue)?\s*(?:numbers?|nos?\.?|#s?)?\b|\bcat\.?\s*(?:nos?\.?|numbers?|#)\b|\bref\b|\b(?:part|product|item|material|reference)\s*(?:numbers?|nos?\.?|#s?|codes?)\b|\bupn\b|\bsku\b/gi, key: 'model' },
  { re: /\bupc(?:-a)?\s*(?:codes?|numbers?|nos?\.?|#)?\b|\bgtin(?:-\d+)?\s*(?:codes?|numbers?)?\b|\bean\s*(?:codes?|numbers?)?\b/gi, key: 'upc' },
  { re: /\budi(?:\s*-\s*(?:di|pi))?\s*(?:codes?|numbers?)?\b/gi, key: 'udi' },
  { re: /\b(?:software|firmware|fw|sw|app)\s+(?:versions?|revs?|releases?)\s*(?:numbers?)?\b|\bfirmware\b|\bsoftware\b/gi, key: 'software' },
  { re: /\bplant\s*(?:codes?|numbers?|nos?\.?|#)?\b|\bestablishment\s*(?:numbers?|nos?\.?|#)?\b|\best\.?\s*[#:]/gi, key: 'plant' },
  { re: /\bcodes?\s*(?:numbers?)?\b/gi, key: 'lot' },
];

type Segment = { key: KeyKind; label: string; value: string; start: number; end: number };

function scanSegments(text: string): Segment[] {
  type Hit = { index: number; end: number; key: KeyKind | 'ignore'; label: string };
  const hits: Hit[] = [];
  for (const { re, key } of LABELS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      hits.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, key, label: m[0] });
    }
  }
  hits.sort((a, b) => a.index - b.index || b.end - a.end);

  const kept: Hit[] = [];
  let cursor = -1;
  for (const h of hits) {
    if (h.index < cursor) continue; // overlaps a longer label already taken
    // "Lot # 24351 through lot # 25156" repeats the label mid-range. Swallow the
    // second one so the range survives as a single clause.
    const prev = kept[kept.length - 1];
    if (prev && prev.key === h.key && /\b(?:through|thru|to|-|–|—)\s*$/i.test(text.slice(prev.end, h.index))) {
      continue;
    }
    kept.push(h);
    cursor = h.end;
  }

  const segs: Segment[] = [];
  for (let i = 0; i < kept.length; i++) {
    const h = kept[i];
    if (h.key === 'ignore') continue;
    const stop = kept[i + 1]?.index ?? text.length;
    const raw = text.slice(h.end, stop);
    const value = raw.replace(/^[\s:;#=.\-–—]+/, '').trim();
    if (value) segs.push({ key: h.key, label: h.label.trim(), value, start: h.index, end: stop });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// value-shape helpers
// ---------------------------------------------------------------------------

const UNIVERSAL_RX =
  /\ball\s+(?:lots?|lot\s+codes?|lot\s+numbers?|serial\s+numbers?|serials?|batch(?:es)?|units?|codes?|products?|sizes?|models?|versions?|date\s+codes?)\b|\ball\s+unexpired\b|\bno\s+lot\s+numbers?\b|\bno\s+cod(?:e|es|ing)\b|\bnot\s+coded\b|\bnone\b/i;

const CUTOFF_RX =
  /\b(?:up\s+to\s+and\s+including|up\s+to|on\s+or\s+(?:before|prior\s+to|earlier)|prior\s+to|no\s+later\s+than|earlier\s+than|less\s+than|not\s+later\s+than|before|and\s+(?:before|earlier|prior|sooner|lower|below|older|less)|or\s+(?:before|earlier|prior|sooner|lower|below|older|less)|and\s+lower|through(?=\s*$)|and\s+prior)\b/i;

const UPPER_WORDS =
  /\b(?:up\s+to|prior|before|earlier|sooner|lower|below|older|less|no\s+later|not\s+later|preceding)\b/i;

const PREFIX_RX = /\b(?:start(?:ing|s)?|begin(?:ning|s)?)\s+with\b|\bprefix\b/i;
const SUFFIX_RX = /\bend(?:ing|s)?\s+with\b/i;
const RANGE_SEP_RX = /\s(?:through|thru|to|-|–|—)\s|\s(?:through|thru)\b/i;
const RANGE_LEAD_RX = /\b(?:between|from|range)\b/i;

const STOP = new Set([
  'AND', 'OR', 'THE', 'WITH', 'ALL', 'DATE', 'DATES', 'CODE', 'CODES', 'NUMBER',
  'NUMBERS', 'THROUGH', 'THRU', 'FROM', 'BETWEEN', 'TO', 'ARE', 'WAS', 'WERE',
  'FOR', 'PER', 'EACH', 'CASE', 'PACK', 'BOX', 'INCLUDING', 'INCLUDED', 'ALSO',
]);

/**
 * Splits a value region into code tokens. Splits on separators first so a code
 * printed with an internal space ("LZ1 R169") survives whole, then adds the
 * space-separated pieces as extra candidates so either reading matches.
 */
export function codeTokens(v: string): string[] {
  const out: string[] = [];
  const keep = (t: string) => {
    const n = norm(t);
    if (n.length < 3 || !/\d/.test(n) || STOP.has(n)) return;
    if (!out.includes(n)) out.push(n);
  };
  for (const chunk of v.split(/[,;\n]|\s{2,}|\s*\/\s*|\s+and\s+|\s+or\s+/i)) {
    const c = chunk.trim().replace(/^[:#.\-]+|[.,;:]+$/g, '');
    if (!c) continue;
    const words = c.split(/\s+/);
    // "LZ1 R169" is one code printed with a space; "prior to 01APR2027" is not.
    if (words.length === 1 || words.every((w) => /\d/.test(w))) keep(c);
    if (words.length > 1) for (const p of words) keep(p);
  }
  return out;
}

export type AtomicToken = { n: string; raw: string; index: number };

/** Single code-shaped tokens with their offsets, used to pick range endpoints. */
export function atomicTokens(v: string): AtomicToken[] {
  const out: AtomicToken[] = [];
  for (const m of v.matchAll(/[A-Za-z0-9][A-Za-z0-9._\/-]*/g)) {
    const n = norm(m[0]);
    if (n.length < 2 || !/\d/.test(n) || STOP.has(n)) continue;
    out.push({ n: m[0], raw: m[0], index: m.index ?? 0 });
  }
  return out;
}

const QUESTIONS: Record<KeyKind, string> = {
  lot: 'What is the lot or batch code printed on the package?',
  best_by: 'What is the Best By / Use By / Sell By date on the package?',
  expiry: 'What is the expiration date on the package?',
  mfg_date: 'What is the manufacture or packed-on date?',
  julian: 'What is the Julian date code (the 3 to 5 digit production code) on the package?',
  date_code: 'What is the date code on the product?',
  model: 'What is the model, catalog or product number?',
  serial: 'What is the serial number?',
  upc: 'What is the UPC / GTIN barcode number?',
  udi: 'What is the UDI number on the device label?',
  software: 'What software or firmware version is installed?',
  plant: 'What is the plant or establishment code on the package?',
};

const DATE_KEYS: ReadonlySet<KeyKind> = new Set<KeyKind>(['best_by', 'expiry', 'mfg_date']);

// ---------------------------------------------------------------------------
// clause compilation
// ---------------------------------------------------------------------------

function userSpans(v: string, ctx: DateCtx): Span[] {
  const direct = dateSpans(v, ctx);
  if (direct.length) return direct;
  const found = findDates(v, ctx);
  return found.length ? found[0].spans : [];
}

function makeDateClause(
  seg: Segment,
  ctx: DateCtx,
  evidence: string,
  question: string,
): Clause | null {
  const v = seg.value;
  const dates = findDates(v, ctx);
  if (!dates.length) return null;

  // Endpoints written without a year inherit it from the other endpoint:
  // "Between July 20 - August 17, 2026".
  const yearHint = dates.map((d) => new Date(d.spans[0].lo * DAY_MS).getUTCFullYear()).pop();
  const withYear = (d: FoundDate): Span[] =>
    /\d{4}/.test(d.text) || !yearHint ? d.spans : dateSpans(d.text, { ...ctx, contextYear: yearHint });

  let windows: Span[] = [];
  let form: ClauseForm = 'list';
  let cls = 'EXPIRY_DATE';

  const cut = CUTOFF_RX.exec(v);
  const lead = RANGE_LEAD_RX.exec(v);
  const sepIdx = v.search(RANGE_SEP_RX);
  const before = dates.filter((d) => d.index < (sepIdx < 0 ? -1 : sepIdx));
  const after = dates.filter((d) => d.index > (sepIdx < 0 ? Number.MAX_SAFE_INTEGER : sepIdx));

  // "All Best By dates from 11 DEC 2025 and before 8 AUG 2027" carries a cutoff
  // word but is a closed interval: a range lead precedes the first date and the
  // cutoff word sits between the two endpoints.
  const bracketed = Boolean(
    lead && cut && dates.length >= 2 &&
    lead.index < dates[0].index && cut.index > dates[0].index && cut.index < dates[1].index,
  );

  if (sepIdx >= 0 && before.length && after.length && !cut) {
    form = 'range';
    cls = 'DATE_RANGE';
    const lo = withYear(before[before.length - 1]);
    const hi = withYear(after[0]);
    for (const a of lo) for (const b of hi) if (a.lo <= b.hi) windows.push({ lo: a.lo, hi: b.hi });
  } else if (sepIdx >= 0 && !before.length && after.length && !cut) {
    // "All lots with expiry through September, 2023" — a range word with nothing
    // before it is an upper bound, not an equality.
    form = 'cutoff';
    cls = 'OPEN_ENDED_CUTOFF';
    for (const s of withYear(after[0])) windows.push({ lo: NEG, hi: s.hi });
  } else if (RANGE_LEAD_RX.test(v) && dates.length >= 2 && (!cut || bracketed)) {
    form = 'range';
    cls = 'DATE_RANGE';
    const lo = withYear(dates[0]);
    const hi = withYear(dates[1]);
    for (const a of lo) for (const b of hi) if (a.lo <= b.hi) windows.push({ lo: a.lo, hi: b.hi });
  } else if (cut) {
    form = 'cutoff';
    cls = 'OPEN_ENDED_CUTOFF';
    const at = cut.index;
    const bound = dates.find((d) => d.index > at) ?? dates.filter((d) => d.index < at).pop();
    if (!bound) return null;
    const upper = UPPER_WORDS.test(cut[0]);
    for (const s of withYear(bound)) {
      windows.push(upper ? { lo: NEG, hi: s.hi } : { lo: s.lo, hi: POS });
    }
  } else {
    form = 'list';
    cls = seg.key === 'best_by' ? 'BEST_BY' : seg.key === 'mfg_date' ? 'MFG_DATE' : 'EXPIRY_DATE';
    for (const d of dates) windows.push(...d.spans);
  }
  // A range or cutoff reading is a HYPOTHESIS, not a decision. "(s) - 08/01/2025,
  // 08/14/2025, 08/21/2025" is a list whose leading dash reads as a range word,
  // and taking only the range reading cleared units the notice names. So every
  // date the segment states is also carried as its own window, and the windows
  // OR: a genuine range still covers its interior, and a mis-read list still
  // covers each date it lists.
  if (form !== 'list') for (const d of dates) windows.push(...withYear(d));
  if (!windows.length) return null;

  return {
    key: seg.key,
    form,
    cls,
    evidence,
    source: seg.value,
    question,
    test: (value) => (value ? spanTest(windows, userSpans(value, ctx)) : 'UNKNOWN'),
  };
}

function makeJulianClause(
  seg: Segment,
  ctx: DateCtx,
  evidence: string,
  question: string,
): Clause | null {
  const v = seg.value;
  const toks = (v.match(/\b\d{3,7}[A-Z]?\b/gi) ?? []).slice(0, 200);
  if (!toks.length) return null;

  const sepIdx = v.search(RANGE_SEP_RX);
  const isRange =
    (RANGE_LEAD_RX.test(v) || sepIdx >= 0) && toks.length >= 2;
  const cut = CUTOFF_RX.exec(v);

  // Keep only encodings that decode every token in the clause.
  const perTok = toks.map((t) => julianHyps(t, ctx));
  const fmts = new Set<string>(perTok[0]?.map((h) => h.fmt) ?? []);
  for (const hs of perTok) {
    const here = new Set(hs.map((h) => h.fmt));
    for (const f of [...fmts]) if (!here.has(f)) fmts.delete(f);
  }

  type Band = { domain: 'date' | 'doy' | 'num'; lo: number; hi: number };
  const bands: Band[] = [];
  const numeric = toks.map((t) => Number(t.replace(/[^0-9]/g, '')));

  for (const f of fmts) {
    const vals = perTok.map((hs) => hs.find((h) => h.fmt === f)!);
    const dom = vals[0].domain;
    if (isRange) {
      const lo = vals[0].value;
      const hi = vals[vals.length - 1].value;
      if (lo <= hi) bands.push({ domain: dom, lo, hi });
    } else if (cut) {
      const b = vals[0].value;
      bands.push(UPPER_WORDS.test(cut[0]) ? { domain: dom, lo: NEG, hi: b } : { domain: dom, lo: b, hi: POS });
    } else {
      for (const x of vals) bands.push({ domain: dom, lo: x.value, hi: x.value });
    }
  }
  // Plain numeric reading is always kept as an extra hypothesis: it is what a
  // reader who ignores the encoding would conclude, and dropping it could clear
  // a unit that a naive comparison would flag.
  if (isRange && numeric.every(Number.isFinite)) {
    const lo = numeric[0];
    const hi = numeric[numeric.length - 1];
    if (lo <= hi) bands.push({ domain: 'num', lo, hi });
  } else if (!isRange && !cut) {
    for (const n of numeric) if (Number.isFinite(n)) bands.push({ domain: 'num', lo: n, hi: n });
  }
  // Same rule as the date clause: a range reading never replaces the codes the
  // segment literally states, it only adds to them.
  if (isRange) {
    for (const f of fmts) for (const hs of perTok) {
      const h = hs.find((x) => x.fmt === f);
      if (h) bands.push({ domain: h.domain, lo: h.value, hi: h.value });
    }
  }
  if (!bands.length) return null;

  // A Julian code embedded in a longer jet code ("S05-33 25218 20:05") does not
  // decode, and comparing its raw digits against the notice's numbers would
  // manufacture a clear. Only compare numerically when the digit counts agree.
  const tokLens = new Set(toks.map((t) => t.replace(/[^0-9]/g, '').length));

  const test = (value: string | undefined): Tri => {
    if (!value) return 'UNKNOWN';
    const hyps = julianHyps(value, ctx);
    const digits = value.replace(/[^0-9]/g, '');
    const n = Number(digits);
    const results: Tri[] = [];
    for (const b of bands) {
      if (b.domain === 'num') {
        if (Number.isFinite(n) && tokLens.has(digits.length)) {
          results.push(n >= b.lo && n <= b.hi ? 'YES' : 'NO');
        }
        continue;
      }
      const hs = hyps.filter((h) => h.domain === b.domain);
      for (const h of hs) results.push(h.value >= b.lo && h.value <= b.hi ? 'YES' : 'NO');
    }
    return anyOf(results);
  };

  return {
    key: 'julian',
    form: isRange ? 'range' : cut ? 'cutoff' : 'list',
    cls: 'JULIAN',
    evidence,
    source: seg.value,
    question,
    test,
  };
}

function makeCodeClause(
  seg: Segment,
  ctx: DateCtx,
  evidence: string,
  question: string,
  cls: string,
): Clause | null {
  const v = seg.value;

  if (UNIVERSAL_RX.test(v) && !CUTOFF_RX.test(v)) {
    return {
      key: seg.key,
      form: 'universal',
      cls: 'UNIVERSAL_ALL',
      evidence,
      source: seg.value,
      question,
      test: () => 'YES',
    };
  }

  const pre = PREFIX_RX.exec(v);
  const suf = SUFFIX_RX.exec(v);
  const cut = CUTOFF_RX.exec(v);
  const sep = RANGE_SEP_RX.exec(v);
  const atoms = atomicTokens(v);
  const after = (i: number) => atoms.find((t) => t.index >= i) ?? null;
  const before = (i: number) => [...atoms].reverse().find((t) => t.index < i) ?? null;

  // "starting with SO-69006 and ending with SO-72558" is a range, not a prefix.
  if (pre && suf) {
    const lo = after(pre.index + pre[0].length);
    const hi = after(suf.index + suf[0].length);
    if (lo && hi) return codeRange(seg, ctx, evidence, question, 'LOT_RANGE', [[lo.raw, hi.raw]]);
  }
  if (pre) {
    // The prefix is often quoted: date codes beginning with the prefix "A4".
    const rest = v.slice(pre.index + pre[0].length);
    const quoted = /["“”']\s*([A-Za-z0-9][A-Za-z0-9.\-]*)\s*["“”']/.exec(rest)?.[1];
    const p = norm(quoted ?? after(pre.index + pre[0].length)?.raw ?? '');
    if (p) {
      // "...and followed by a five-digit number less than 22249"
      const tailM = /\b(?:less\s+than|below|under)\s+(\d{2,})/i.exec(v);
      const tailMax = tailM ? Number(tailM[1]) : null;
      const literal = listTest(new Set(codeTokens(v)));
      return {
        key: seg.key,
        form: 'prefix',
        cls: 'LOT_PREFIX',
        evidence,
        source: seg.value,
        question,
        test: (value) => {
          if (!value) return 'UNKNOWN';
          const n = norm(value);
          if (!n.startsWith(p)) return literal(value);
          if (tailMax === null) return 'YES';
          const tail = Number(n.slice(p.length).replace(/[^0-9]/g, ''));
          return Number.isFinite(tail) && tail !== 0 ? (tail < tailMax ? 'YES' : 'NO') : 'UNKNOWN';
        },
      };
    }
  }
  if (cut) {
    const at = cut.index;
    const bound = after(at + cut[0].length) ?? before(at);
    if (bound) {
      const upper = UPPER_WORDS.test(cut[0]);
      return codeRange(seg, ctx, evidence, question, 'OPEN_ENDED_CUTOFF', [
        [upper ? null : bound.raw, upper ? bound.raw : null],
      ]);
    }
  }
  if (sep) {
    // "045542 through 045550 and 045552 through 045570" is TWO ranges. Taking
    // only the first separator silently drops the second band and clears units
    // the notice names, so every separator contributes a band and the bands OR.
    const pairs: Array<[string | null, string | null]> = [];
    for (const m of v.matchAll(new RegExp(RANGE_SEP_RX.source, 'gi'))) {
      const at = m.index ?? 0;
      const lo = before(at);
      const hi = after(at + m[0].length);
      if (lo && hi) pairs.push([lo.raw, hi.raw]);
    }
    if (pairs.length) return codeRange(seg, ctx, evidence, question, 'LOT_RANGE', pairs);
  }

  const toks = codeTokens(v);
  if (!toks.length) return null;

  return {
    key: seg.key,
    form: 'list',
    cls,
    evidence,
    source: seg.value,
    question,
    test: listTest(new Set(toks)),
  };
}

/**
 * Set membership for a code list. The unit's value is tried raw AND with a
 * leading field word stripped, because owners read codes off the label as
 * printed ("Lot#894" for the notice's "894"). Extra hypotheses can only turn a
 * NO into a YES, never the reverse.
 */
const LABEL_PREFIX_RX = /^(?:LOT|BATCH|SERIAL|MODEL|CODE|REF|CAT|ITEM|PART|NO|NUM|SN|UPC|GTIN|UDI|EXP|BB)(?=[A-Z0-9])/;

function listTest(set: ReadonlySet<string>): (value: string | undefined) => Tri {
  return (value) => {
    if (!value) return 'UNKNOWN';
    const n = norm(value);
    if (!n) return 'UNKNOWN';
    const cands = [n];
    const stripped = n.replace(LABEL_PREFIX_RX, '');
    if (stripped && stripped !== n) cands.push(stripped);
    for (const c of cands) {
      if (set.has(c)) return 'YES';
      // A partial reading of a smudged code must not clear the unit.
      for (const t of set) if (t.length >= 4 && c.length >= 4 && (t.includes(c) || c.includes(t))) return 'YES';
    }
    return 'NO';
  };
}

/**
 * One or more ranges over codes: structural ordering, plus a calendar reading
 * when both ends parse as dates. Bands OR, so a segment that names two bands
 * ("045542 through 045550 and 045552 through 045570") covers both.
 */
function codeRange(
  seg: Segment,
  ctx: DateCtx,
  evidence: string,
  question: string,
  cls: string,
  pairs: Array<[string | null, string | null]>,
): Clause {
  const bands = pairs.map(([lo, hi]) => {
    const loSpans = lo ? dateSpans(lo, ctx) : [];
    const hiSpans = hi ? dateSpans(hi, ctx) : [];
    const dateOk = (lo === null || loSpans.length > 0) && (hi === null || hiSpans.length > 0);
    const windows: Span[] = [];
    if (dateOk) {
      const los = lo ? loSpans : [{ lo: NEG, hi: NEG }];
      const his = hi ? hiSpans : [{ lo: POS, hi: POS }];
      for (const a of los) for (const b of his) if (a.lo <= b.hi) windows.push({ lo: a.lo, hi: b.hi });
    }
    return { lo, hi, windows };
  });
  const closed = pairs.every(([lo, hi]) => lo && hi);
  // Same rule as the date clause. A stray " - " deep inside a 1,200-character
  // serial list turns the whole list into a range and used to clear serials the
  // notice names outright, so the literal token list rides along as an extra
  // hypothesis and the readings OR.
  const literal = listTest(new Set(codeTokens(seg.value)));
  return {
    key: seg.key,
    form: closed ? 'range' : 'cutoff',
    cls,
    evidence,
    source: seg.value,
    question,
    test: (value) => {
      if (!value) return 'UNKNOWN';
      // Structural ordering and, when both ends read as dates, calendar
      // ordering. Disagreement between readings is UNKNOWN, never a clear.
      const hyps: Tri[] = [];
      for (const b of bands) {
        const st = structRangeTest(b.lo, b.hi, value);
        if (st !== 'UNKNOWN') hyps.push(st);
        if (b.windows.length) {
          const u = userSpans(value, ctx);
          if (u.length) hyps.push(spanTest(b.windows, u));
        }
      }
      hyps.push(literal(value));
      return anyOf(hyps);
    },
  };
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

const MASKED_RX = /(?:^|[^A-Za-z])[A-Za-z0-9]*[xX]{3,}[A-Za-z0-9]*/;
const LOCATION_RX =
  /\b(?:printed|located|found|stamped|etched|embossed|ink[- ]?jetted|imprinted)\s+(?:on|at|in|under|near|along|to)\b[^.]{0,170}\./i;
const CAVEAT_RX = [
  /\bif\b[^.]{0,220}\b(?:not\s+affected|already\s+been\s+inspected|are\s+not\s+included|is\s+not\s+included|not\s+part\s+of\s+this\s+recall)\b[^.]{0,80}\./i,
  /\b(?:are\s+)?not\s+marked\s+with\b[^.]{0,120}\./i,
  /\bonly\b[^.]{0,200}\bare\s+(?:affected|included)\b[^.]{0,60}\./i,
];

const CLS_FOR_KEY: Partial<Record<KeyKind, string>> = {
  lot: 'LOT_LIST',
  serial: 'SERIAL_LIST',
  model: 'MODEL_CATALOG',
  upc: 'UPC_GTIN_EAN',
  udi: 'UDI',
  software: 'SOFTWARE_VERSION',
  plant: 'PLANT_EST',
  date_code: 'DATE_CODE_FORMAT',
};

export function parseCodeInfo(
  text: string,
  opts: { contextYear?: number; truncated?: boolean } = {},
): Parsed {
  const raw = (text ?? '').trim();
  const sourceIncomplete = Boolean(opts.truncated) || MASKED_RX.test(raw);
  const caveats: string[] = [];
  for (const rx of CAVEAT_RX) {
    const m = rx.exec(raw);
    if (m) caveats.push(m[0].trim());
  }
  const locationHint = LOCATION_RX.exec(raw)?.[0]?.trim();

  const order = /\(\s*DD\s*\/\s*MM\s*\/\s*YYYY\s*\)/i.test(raw)
    ? ('DMY' as const)
    : /\(\s*MM\s*\/\s*DD\s*\/\s*YYYY\s*\)/i.test(raw)
      ? ('MDY' as const)
      : undefined;
  const ctx: DateCtx = { contextYear: opts.contextYear, order };

  const segs = scanSegments(raw);
  const clauses: Clause[] = [];

  for (const seg of segs) {
    const evidence = raw.slice(seg.start, Math.min(seg.end, seg.start + 300)).trim();
    let question = QUESTIONS[seg.key];
    if (locationHint && (seg.key === 'julian' || seg.key === 'lot' || seg.key === 'date_code')) {
      question = `${question} (${locationHint})`;
    }

    if (UNIVERSAL_RX.test(seg.value) && !CUTOFF_RX.test(seg.value)) {
      clauses.push({
        key: seg.key, form: 'universal', cls: 'UNIVERSAL_ALL', evidence, source: seg.value, question,
        test: () => 'YES',
      });
      continue;
    }

    let c: Clause | null = null;
    if (seg.key === 'julian') c = makeJulianClause(seg, ctx, evidence, question);
    else if (DATE_KEYS.has(seg.key)) c = makeDateClause(seg, ctx, evidence, question);
    else if (seg.key === 'date_code') {
      c = makeDateClause(seg, ctx, evidence, question) ??
        makeCodeClause(seg, ctx, evidence, question, 'DATE_CODE_FORMAT');
    } else {
      c = makeCodeClause(seg, ctx, evidence, question, CLS_FOR_KEY[seg.key] ?? 'LOT_LIST');
    }
    if (c) clauses.push(c);
  }

  // BARE_CODE_LIST: no labels at all, just tokens. Infer the field from shape.
  if (!clauses.length && raw) {
    const words = raw.split(/\s+/).filter(Boolean);
    const atoms = atomicTokens(raw);
    // Prose ("This recall involves all Boppy Newborn Loungers...") is not a code
    // list. Require code-shaped tokens to dominate before inferring one.
    const dense = words.length > 0 && atoms.length / words.length >= 0.5;
    const toks = dense ? codeTokens(raw) : [];
    const usable = toks.filter((t) => t.length >= 4);
    if (usable.length && !UNIVERSAL_RX.test(raw)) {
      const allBarcode = usable.every((t) => /^\d{8,14}$/.test(t));
      const key: KeyKind = allBarcode ? 'upc' : 'lot';
      clauses.push({
        key,
        form: 'list',
        cls: 'BARE_CODE_LIST',
        evidence: raw.slice(0, 300),
        source: raw,
        question: QUESTIONS[key],
        test: listTest(new Set(usable)),
      });
    }
  }

  return {
    clauses,
    wholeProduct: clauses.length === 0,
    sourceIncomplete,
    caveats,
    locationHint,
  };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

export type Verdict = 'AFFECTED' | 'NOT_AFFECTED' | 'NEED_CODE';

export type ClauseResult = {
  key: KeyKind;
  form: ClauseForm;
  cls: string;
  evidence: string;
  question: string;
  result: Tri;
  given?: string;
};

export type Assessment = {
  verdict: Verdict;
  reason: string;
  wholeProduct: boolean;
  sourceIncomplete: boolean;
  clauses: ClauseResult[];
  /** Deduped questions for the keys that still block a decision. */
  questions: string[];
  missingKeys: KeyKind[];
  caveats: string[];
};

export type NoticeLike = Pick<Notice, 'code_info'> &
  Partial<Pick<Notice, 'code_info_truncated' | 'report_date'>>;

/**
 * Apply a notice's predicates to one unit's codes.
 *
 * Clauses sharing a key are ORed (a notice listing "lot A / made 27 Apr" and
 * "lot B / made 28 Apr" recalls either). Distinct keys are ANDed (a model gate
 * plus a lot list means both must hold).
 *
 * NOT_AFFECTED requires: complete source text, every clause evaluated with a
 * value the user actually supplied, and at least one definitive exclusion.
 */
export function evaluate(notice: NoticeLike, unit: UnitCodes = {}): Assessment {
  const contextYear = notice.report_date ? Number(notice.report_date.slice(0, 4)) : undefined;
  const parsed = parseCodeInfo(notice.code_info ?? '', {
    contextYear,
    truncated: Boolean(notice.code_info_truncated),
  });

  const results: ClauseResult[] = parsed.clauses.map((c) => ({
    key: c.key,
    form: c.form,
    cls: c.cls,
    evidence: c.evidence,
    question: c.question,
    given: unit[c.key],
    result: c.test(unit[c.key]),
  }));

  if (parsed.wholeProduct) {
    return {
      verdict: 'AFFECTED',
      reason:
        'The notice names no code that separates affected units, so every unit of this product is in scope.',
      wholeProduct: true,
      sourceIncomplete: parsed.sourceIncomplete,
      clauses: results,
      questions: [],
      missingKeys: [],
      caveats: parsed.caveats,
    };
  }

  const byKey = new Map<KeyKind, ClauseResult[]>();
  for (const r of results) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }

  const groups = [...byKey.entries()].map(([key, rs]) => ({
    key,
    result: anyOf(rs.map((r) => r.result)),
    rs,
  }));

  const unresolved = groups.filter((g) => g.result === 'UNKNOWN');
  const excluding = groups.filter((g) => g.result === 'NO');
  const missingKeys = unresolved.filter((g) => g.rs.every((r) => !r.given)).map((g) => g.key);
  const questions = [...new Set(unresolved.flatMap((g) => g.rs.map((r) => r.question)))];

  const base = {
    wholeProduct: false,
    sourceIncomplete: parsed.sourceIncomplete,
    clauses: results,
    questions,
    missingKeys,
    caveats: parsed.caveats,
  };

  if (parsed.sourceIncomplete) {
    if (!unresolved.length && !excluding.length) {
      return { ...base, verdict: 'AFFECTED', reason: 'Every code in the notice matches this unit.' };
    }
    return {
      ...base,
      verdict: 'NEED_CODE',
      questions: questions.length ? questions : ['Confirm the code with the recalling firm.'],
      reason:
        'The recall notice as published is truncated or redacted at the source, so no unit can be safely cleared against it.',
    };
  }

  if (!unresolved.length && !excluding.length) {
    return { ...base, verdict: 'AFFECTED', reason: 'Every code the notice names matches this unit.' };
  }
  if (excluding.length && !unresolved.length) {
    const g = excluding[0];
    return {
      ...base,
      verdict: 'NOT_AFFECTED',
      reason: `The ${g.key.replace('_', ' ')} you gave (${g.rs.find((r) => r.given)?.given ?? ''}) is outside the recalled set, and every other code in the notice was checked.`,
    };
  }
  return {
    ...base,
    verdict: 'NEED_CODE',
    reason: excluding.length
      ? 'One code already falls outside the recalled set, but the notice names other codes that were not checked, so this unit cannot be cleared yet.'
      : 'The notice narrows the recall to specific codes that this unit has not supplied.',
  };
}
