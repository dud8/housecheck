/**
 * src/mcp-server.ts — HouseCheck over MCP, Streamable HTTP.
 *
 * Model Context Protocol, spec revision 2025-11-25, served by
 * @modelcontextprotocol/sdk over the Streamable HTTP transport at POST /mcp.
 * The same process serves the web client from web/ so there is one port, one
 * origin and nothing to configure.
 *
 * Every tool here calls the real engine: src/match.ts resolves a product to
 * candidate notices and src/predicates.ts decides each one. Nothing in this file
 * re-implements matching or re-states a verdict; it only shapes the engine's
 * output for an agent to read aloud and for a browser to render.
 *
 *   node src/mcp-server.ts            # http://127.0.0.1:8765
 *   PORT=9000 node src/mcp-server.ts
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openIndex } from './match.ts';
import type { Result } from './match.ts';
import { evaluate } from './predicates.ts';
import type { UnitCodes, Verdict } from './predicates.ts';
import type { Notice } from '../data/fetch.ts';
import { renderCard, CARD_CSS } from './card.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const PORT = Number(process.env.PORT ?? 8765);

// The frozen snapshot is read once and indexed in memory. No network at runtime.
const index = openIndex();
const byRecall = new Map<string, Notice>();
for (const n of index.notices) if (n.recall_number) byRecall.set(n.recall_number.toUpperCase(), n);

// ---------------------------------------------------------------------------
// input schema shared by the two deciding tools
// ---------------------------------------------------------------------------

const CODE_FIELDS = {
  lot: z.string().optional().describe('Lot, batch or code number printed on the unit, e.g. "P-1950", "B21334".'),
  julian: z.string().optional().describe('Julian date code: the 3 to 5 digit production code, e.g. "173" or "25173".'),
  best_by: z.string().optional().describe('Best By / Use By / Sell By date as printed, e.g. "2026-08-01" or "AUG 01 2026".'),
  expiry: z.string().optional().describe('Expiration date as printed, e.g. "06/2028".'),
  mfg_date: z.string().optional().describe('Manufacture, production or packed-on date as printed.'),
  date_code: z.string().optional().describe('Any other date code stamped on the unit, e.g. "2018-14-FY".'),
  model: z.string().optional().describe('Model, catalogue, item or reference number.'),
  serial: z.string().optional().describe('Serial number of the individual unit.'),
  udi: z.string().optional().describe('Unique Device Identifier or GTIN printed on a medical device label.'),
  software: z.string().optional().describe('Software or firmware version, for devices recalled by version.'),
  plant: z.string().optional().describe('Plant, establishment or licence number, e.g. "P-1950", "EST 34".'),
} as const;

const UPC_FIELD = z
  .string()
  .optional()
  .describe('Barcode digits from the package: UPC-12, EAN-13 or GTIN-14, spaces and dashes are fine.');

const DOMAIN_FIELD = z
  .enum(['food', 'drug', 'device', 'consumer'])
  .optional()
  .describe('Restrict to one category of recall. Leave unset to search all four.');

type CodeArgs = Partial<Record<keyof typeof CODE_FIELDS | 'upc', string>>;

const unitFrom = (a: CodeArgs): UnitCodes => {
  const u: Record<string, string> = {};
  for (const k of [...Object.keys(CODE_FIELDS), 'upc'] as const) {
    const v = a[k as keyof CodeArgs];
    if (v && String(v).trim()) u[k] = String(v).trim();
  }
  return u as UnitCodes;
};

// ---------------------------------------------------------------------------
// shaping the engine's output
// ---------------------------------------------------------------------------

const flat = (s: string, n = 200): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const SAYS: Record<Verdict, string> = {
  AFFECTED: 'AFFECTED',
  NOT_AFFECTED: 'NOT AFFECTED',
  NEED_CODE: 'NEED A CODE',
};

/** A one-notice verdict as prose an assistant can read out without editing it. */
function speak(r: Result): string {
  const a = r.assessment;
  const lines = [
    `${SAYS[a.verdict]} — ${r.notice.recall_number || 'unnumbered notice'} (${r.notice.domain}, ${r.notice.status || 'status not stated'}${r.notice.classification ? `, ${r.notice.classification}` : ''})`,
    flat(r.notice.product_description, 220),
    r.notice.firm ? `Recalled by ${r.notice.firm}.` : '',
    a.reason,
  ];
  if (a.clauses.length) {
    lines.push('What the notice requires:');
    for (const c of a.clauses) {
      lines.push(
        `  - ${c.key}: ${c.given ? `you gave "${c.given}"` : 'not supplied'} -> ${c.result === 'YES' ? 'in the recalled set' : c.result === 'NO' ? 'outside the recalled set' : 'undecided'}   [notice says: "${flat(c.evidence, 120)}"]`,
      );
    }
  }
  for (const q of a.questions) lines.push(`Ask the owner: ${q}`);
  for (const c of a.caveats) lines.push(`Caveat: ${flat(c, 220)}`);
  if (r.reason) lines.push(`Reason for recall, verbatim: "${flat(r.reason, 300)}"`);
  if (a.verdict !== 'NOT_AFFECTED') {
    lines.push(
      r.remedy
        ? `Remedy, verbatim from the issuing agency: "${flat(r.remedy, 400)}"`
        : 'This record carries no remedy text; send the owner to the primary source notice.',
    );
  }
  lines.push(`Source: ${r.notice.url}`);
  return lines.filter(Boolean).join('\n');
}

/** Trimmed for an agent: enough to reason with, not the whole notice. */
const wire = (r: Result) => ({
  recall_number: r.notice.recall_number,
  verdict: r.assessment.verdict,
  reason: r.assessment.reason,
  product: r.notice.product_description,
  firm: r.notice.firm,
  domain: r.notice.domain,
  status: r.notice.status,
  classification: r.notice.classification,
  report_date: r.notice.report_date,
  code_info: r.codeInfo,
  code_info_truncated: r.notice.code_info_truncated ?? null,
  recall_reason_verbatim: r.reason,
  remedy_verbatim: r.remedy,
  source_url: r.source,
  matched_by: r.why,
  same_event: r.duplicates,
  questions: r.assessment.questions,
  missing_codes: r.assessment.missingKeys,
  caveats: r.assessment.caveats,
  clauses: r.assessment.clauses.map((c) => ({
    code: c.key,
    given: c.given ?? null,
    result: c.result,
    notice_says: c.evidence,
  })),
});

const NOTHING =
  'No recall notice in the frozen snapshot matches that product. That is not a clearance: the snapshot covers a fixed window of FDA and CPSC notices, so try a different brand or product wording, or a barcode.';

/** Wrap a bare notice as a Result so one code path renders every card. */
const asResult = (notice: Notice, unit: UnitCodes): Result => ({
  notice,
  score: 1000,
  why: 'upc',
  duplicates: [],
  assessment: evaluate(notice, unit),
  source: notice.url,
  codeInfo: notice.code_info,
  reason: notice.reason,
  remedy: notice.remedy,
});

const reply = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'housecheck', version: '1.0.0' },
    {
      instructions:
        'HouseCheck decides whether a SPECIFIC unit is affected by a product recall, not just whether the product was recalled. Recall notices restrict themselves to lot codes, Julian dates, best-by windows, model ranges and serial runs; HouseCheck parses that text into a predicate and tests the codes printed on the owner\'s unit against it. Call check_recall first. When it returns NEED_CODE, ask the owner exactly the question it hands back, then call check_recall again with that code filled in. Never tell an owner a unit is safe unless a verdict says NOT_AFFECTED.',
    },
  );

  server.registerTool(
    'check_recall',
    {
      title: 'Check whether this unit is recalled',
      description:
        'THE MAIN TOOL. Decide whether one specific unit is affected by a recall. Give the product (brand and description, or the barcode) plus whatever codes are printed on the package. Returns one of three verdicts per matching notice: AFFECTED, NOT_AFFECTED, or NEED_CODE together with the exact question to ask the owner. NEED_CODE means the notice restricts itself to codes the owner has not given yet — ask the returned question and call this tool again with the answer. A unit is never reported as safe on a guess.',
      inputSchema: {
        product: z
          .string()
          .optional()
          .describe('What the item is, in the owner\'s words: brand, product name, what the label says. e.g. "Kroger grade A large eggs".'),
        upc: UPC_FIELD,
        ...CODE_FIELDS,
        domain: DOMAIN_FIELD,
        limit: z.number().int().min(1).max(10).optional().describe('How many notices to decide. Default 3.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const unit = unitFrom(args);
      const results = index.check(
        { text: args.product, upc: args.upc, domain: args.domain, limit: args.limit ?? 3 },
        unit,
      );
      if (!results.length) return reply(NOTHING, { verdict: null, results: [], cards: [] });
      return reply(results.map(speak).join('\n\n'), {
        verdict: results[0].assessment.verdict,
        questions: results[0].assessment.questions,
        missing_codes: results[0].assessment.missingKeys,
        results: results.map(wire),
        cards: results.map(renderCard),
      });
    },
  );

  server.registerTool(
    'search_product',
    {
      title: 'Find recall notices for a product',
      description:
        'Find which recall notices could be about a product, without deciding any unit. Use this when the owner is browsing ("has anything been recalled for this brand?") or when you need a recall number to pass to explain_verdict or get_remedy. It answers "was this PRODUCT recalled" — for "is MY unit affected", use check_recall.',
      inputSchema: {
        query: z.string().optional().describe('Brand, product name or label text.'),
        upc: UPC_FIELD,
        domain: DOMAIN_FIELD,
        limit: z.number().int().min(1).max(25).optional().describe('How many notices to return. Default 8.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const found = index.search({ text: args.query, upc: args.upc, domain: args.domain, limit: args.limit ?? 8 });
      if (!found.length) return reply(NOTHING, { matches: [] });
      const matches = found.map((c) => ({
        recall_number: c.notice.recall_number,
        product: c.notice.product_description,
        firm: c.notice.firm,
        domain: c.notice.domain,
        status: c.notice.status,
        classification: c.notice.classification,
        report_date: c.notice.report_date,
        code_info: c.notice.code_info,
        restricts_by_code: Boolean(evaluate(c.notice).clauses.length),
        source_url: c.notice.url,
        matched_by: c.why,
        same_event: c.duplicates,
      }));
      const text = matches
        .map(
          (m) =>
            `${m.recall_number} (${m.domain}, ${m.status || 'status not stated'}) — ${flat(m.product, 160)} — ${m.firm}\n  ${m.restricts_by_code ? 'Restricted to specific codes; call check_recall to decide a unit.' : 'No code narrows this recall: every unit of the product is in scope.'}`,
        )
        .join('\n');
      return reply(`${found.length} notice(s) could be about that product:\n${text}`, { matches });
    },
  );

  server.registerTool(
    'explain_verdict',
    {
      title: 'Explain one verdict clause by clause',
      description:
        'Show the working for a single recall notice: every rule parsed out of the notice\'s code text, the value the owner supplied for it, and whether that value falls inside or outside the recalled set. Use when the owner asks why, disagrees with a verdict, or wants to see the notice\'s own wording. Pass the same codes you gave check_recall.',
      inputSchema: {
        recall_number: z.string().describe('Recall number from check_recall or search_product, e.g. "H-1230-2026".'),
        upc: UPC_FIELD,
        ...CODE_FIELDS,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const notice = byRecall.get(args.recall_number.trim().toUpperCase());
      if (!notice) return reply(`No notice numbered ${args.recall_number} is in the frozen snapshot.`, { found: false });
      const r = asResult(notice, unitFrom(args));
      const a = r.assessment;
      const head = a.wholeProduct
        ? 'This notice names no code that separates affected units, so the whole product is in scope and there is nothing to test.'
        : `The notice was parsed into ${a.clauses.length} rule(s). Rules for the same code are alternatives; different codes must all hold.`;
      return reply(`${head}\n\n${speak(r)}`, { found: true, ...wire(r), card: renderCard(r) });
    },
  );

  server.registerTool(
    'get_remedy',
    {
      title: 'What the owner should do about a recall',
      description:
        'Return the issuing agency\'s own instructions for a recall, word for word, plus the reason and a link to the primary source. Use once a unit is AFFECTED. Read the remedy out verbatim and do not add safety or medical advice of your own. openFDA enforcement records carry no remedy field, so for FDA notices this returns the reason and the source link only.',
      inputSchema: {
        recall_number: z.string().describe('Recall number, e.g. "H-1230-2026" or a CPSC recall number.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const notice = byRecall.get(args.recall_number.trim().toUpperCase());
      if (!notice) return reply(`No notice numbered ${args.recall_number} is in the frozen snapshot.`, { found: false });
      const text = [
        `${notice.recall_number} — ${flat(notice.product_description, 220)}`,
        notice.firm ? `Recalled by ${notice.firm}.` : '',
        notice.reason ? `Reason, verbatim: "${notice.reason.replace(/\s+/g, ' ').trim()}"` : '',
        notice.remedy
          ? `Remedy, verbatim: "${notice.remedy.replace(/\s+/g, ' ').trim()}"`
          : 'This record carries no remedy text. Send the owner to the primary source notice below rather than improvising instructions.',
        `Source: ${notice.url}`,
      ];
      return reply(text.filter(Boolean).join('\n'), {
        found: true,
        recall_number: notice.recall_number,
        firm: notice.firm,
        product: notice.product_description,
        recall_reason_verbatim: notice.reason,
        remedy_verbatim: notice.remedy,
        has_remedy: Boolean(notice.remedy),
        source_url: notice.url,
      });
    },
  );

  server.registerTool(
    'list_recent_recalls',
    {
      title: 'Recent recall notices',
      description:
        'List the most recent recall notices in the snapshot, newest first, optionally filtered by category, status or hazard class. Use for "what has been recalled lately" or to give the owner something to check against. This lists products, it does not decide units.',
      inputSchema: {
        domain: DOMAIN_FIELD,
        status: z
          .enum(['Ongoing', 'Completed', 'Terminated'])
          .optional()
          .describe('Ongoing means the recall is still live. Default is no filter.'),
        classification: z
          .enum(['Class I', 'Class II', 'Class III'])
          .optional()
          .describe('Class I is the most serious hazard: reasonable probability of serious harm or death.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many to list. Default 10.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const rows = index.notices
        .filter(
          (n) =>
            (!args.domain || n.domain === args.domain) &&
            (!args.status || n.status === args.status) &&
            (!args.classification || n.classification === args.classification),
        )
        .sort((a, b) => b.report_date.localeCompare(a.report_date))
        .slice(0, args.limit ?? 10)
        .map((n) => ({
          recall_number: n.recall_number,
          report_date: n.report_date,
          domain: n.domain,
          status: n.status,
          classification: n.classification,
          firm: n.firm,
          product: n.product_description,
          recall_reason_verbatim: n.reason,
          restricts_by_code: Boolean(evaluate(n).clauses.length),
          source_url: n.url,
        }));
      if (!rows.length) return reply('No notice in the frozen snapshot matches those filters.', { recalls: [] });
      const text = rows
        .map(
          (r) =>
            `${r.report_date}  ${r.recall_number}  ${r.classification || ''} — ${flat(r.product, 140)} (${r.firm}) — ${flat(r.recall_reason_verbatim, 120)}`,
        )
        .join('\n');
      return reply(`${rows.length} notice(s), newest first:\n${text}`, { recalls: rows });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Same-origin by construction; the header only helps someone running the
  // client from a file:// page or another port while trying the server out.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version, accept');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream to resume, and no session to end.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      return void res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless; use POST /mcp.' }, id: null }),
      );
    }
    // A fresh server and transport per request keeps request ids from colliding
    // between concurrent callers. The corpus index is shared and built once.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildServer();
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null }));
    }
    return;
  }

  if (url.pathname === '/card.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    return void res.end(CARD_CSS);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(WEB, rel);
    if (!file.startsWith(WEB)) return void res.writeHead(403).end('forbidden');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return void res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  }

  res.writeHead(404).end();
});

http.listen(PORT, '127.0.0.1', () => {
  console.log(`HouseCheck  ${index.notices.length.toLocaleString()} frozen recall notices indexed`);
  console.log(`  client    http://127.0.0.1:${PORT}/`);
  console.log(`  MCP       POST http://127.0.0.1:${PORT}/mcp   (Streamable HTTP, spec 2025-11-25)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    http.close();
    index.close();
    process.exit(0);
  });
}
