
## 14:30 — HouseCheck matcher gate FIXED (commit 344e3bd, pushed)
Defect: every nonsense query returned NEED_CODE against unrelated recalls
because the FTS5/fuzzy fallback returned top-N regardless of score; the
no-match path (mcp-server.ts:156, "That is not a clearance") was unreachable.
Measured why a score cutoff cannot work: top bm25 for nonsense = 9.7..14.4,
but the CORRECT notices for the query "eggs" score 8.23. Any rank cutoff loose
enough to keep real short queries keeps the junk.
Gate chosen: a notice must contain at least half of the query's identifying
words (FTS tokens minus bare numbers and 1-2 char fragments), never fewer than
two: `need = min(n, max(2, ceil(n/2)))`. Nonsense caps at 33% coverage; real
queries run 50-100% (the existing fuzzy-misspelling test sits at 3/6). The
floor of two stopped "Ford F-150 tailgate" matching a donor-milk recall on
"ford". Applied inside search()'s take(), the single choke point, so CLI,
check_recall and search_product all inherit it; exact-barcode hits bypass it.
Before/after: 4 nonsense queries -> no_match:true, 0 results, line-156 text
verbatim. Good queries unchanged except Yamaha dropped one row (23773) that
shared only "yamaha" — correct. Tests 55 -> **61**, all pass. README, file map,
VIDEO.md counts updated. predicates.ts untouched.
