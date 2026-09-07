# code_info taxonomy

Specification for `src/predicates.ts`, derived from the frozen corpus in
`data/recalls.json` (13,480 notices, fetched 2026-09-07). Every pattern class
below was measured over the whole corpus by `data/taxonomy.ts`; every example
string is verbatim from a real notice, with its recall number.

Regenerate the counts:

```
node data/taxonomy.ts              # frequency table + data/taxonomy.json
node data/taxonomy.ts LOT_RANGE    # dump examples for one class
```

## What the field actually is

`code_info` is not structured. It is whatever the recalling firm typed. The
same semantic ("this lot is affected") appears as `Lot: 60609-8`,
`Lots: 24354, 25009, 25046`, `LOT: A6FF4`, `Batch No: ENGOT24`, and as a bare
`B15354, B15356, B15357` with no label at all. Field separators are commas,
semicolons, newlines, and runs of spaces, inconsistently. Notices routinely
carry three or four different key types that must be ANDed.

CPSC has no `code_info` field. Its qualifiers live in the recall `Description`
prose, so the fetcher maps `Description` into `code_info` and the parser treats
it identically. That is why the consumer column is dominated by prose classes.

## Frequency table

13,480 notices. Classes are not mutually exclusive; a notice with a lot list,
an expiry and a UPC counts in all three.

| class | n | share | food / drug / device / consumer |
|---|---:|---:|---|
| LOT_LIST | 6504 | 48.2% | 1646 / 2478 / 2206 / 174 |
| UDI | 3405 | 25.3% | 0 / 0 / 3405 / 0 |
| EXPIRY_DATE | 3001 | 22.3% | 392 / 2418 / 184 / 7 |
| MODEL_CATALOG | 2828 | 21.0% | 249 / 14 / 1597 / 968 |
| SERIAL_LIST | 1455 | 10.8% | 1 / 2 / 1140 / 312 |
| NO_QUALIFIER | 1417 | 10.5% | 405 / 52 / 39 / 921 |
| UNIVERSAL_ALL | 1354 | 10.0% | 395 / 359 / 590 / 10 |
| BEST_BY | 1344 | 10.0% | 1333 / 4 / 0 / 7 |
| UPC_GTIN_EAN | 1320 | 9.8% | 395 / 18 / 620 / 287 |
| MFG_DATE | 630 | 4.7% | 288 / 7 / 118 / 217 |
| DATE_RANGE | 629 | 4.7% | 356 / 4 / 82 / 187 |
| GS1_AI | 420 | 3.1% | 0 / 2 / 418 / 0 |
| OPEN_ENDED_CUTOFF | 380 | 2.8% | 258 / 21 / 40 / 61 |
| BARE_CODE_LIST | 269 | 2.0% | 66 / 7 / 196 / 0 |
| LOT_PREFIX | 159 | 1.2% | 74 / 0 / 9 / 76 |
| SOFTWARE_VERSION | 129 | 1.0% | 0 / 0 / 129 / 0 |
| LOT_RANGE | 125 | 0.9% | 26 / 13 / 7 / 79 |
| MODEL_RANGE | 125 | 0.9% | 0 / 0 / 0 / 125 |
| SERIAL_RANGE | 121 | 0.9% | 0 / 0 / 15 / 106 |
| EMPTY | 98 | 0.7% | 89 / 1 / 8 / 0 |
| PLANT_EST | 60 | 0.4% | 58 / 0 / 1 / 1 |
| NO_CODE_SYSTEM | 58 | 0.4% | 58 / 0 / 0 / 0 |
| JULIAN | 52 | 0.4% | 52 / 0 / 0 / 0 |
| DATE_CODE_FORMAT | 27 | 0.2% | 13 / 0 / 1 / 13 |
| MASKED_CODE | 22 | 0.2% | 1 / 0 / 11 / 10 |

Rolled up by how a notice can be answered:

| bucket | n | share |
|---|---:|---:|
| UNIT_DECIDABLE — two owners of the same product can get different verdicts | 9736 | 72.2% |
| WHOLE_PRODUCT — every unit is in scope, no code needed | 3479 | 25.8% |
| UNDECIDABLE — source text is masked or was capped by the snapshot | 265 | 2.0% |

72% is the number the product rests on. For those notices a title search
cannot answer "is my unit affected", and a predicate can.

## The classes

### LOT_LIST — 6504 (48.2%)
Set membership over enumerated codes. The dominant shape in every FDA domain.

- `H-1225-2026` — `Lot: 60609-8 EXP: 06/08/28`
- `D-0116-2025`-adjacent drug shape — `Lot #: 22142448, 22142449, 22142450, Exp 5/2024; 22143845, Exp 7/2024.`
- `H-1224-2026` — `Lot Code: LZ1 R169 Expiration Date (s): 06/30/2028`

Note the drug shape: lots and expiries interleave, and one expiry governs the
run of lots before it. Splitting naively on commas loses that binding.
Labels seen: `Lot`, `Lots`, `Lot #`, `Lot #s`, `Lot No`, `Lot Code(s)`,
`Batch`, `Batch No`, `Batch Numbers`, `Lot/Serial Number`.

### UDI — 3405 (25.3%), GS1_AI — 420 (3.1%)
Device identity. Sometimes plain digits, sometimes GS1 application identifiers
that embed the expiry and the lot:

- `Z-2930-2026` — `Product Code: 60-1060. Shelfbox UDI-DI: 30389701011975; Pouch UDI-DI: 00389701011974; UDI-PI: (17)280501(10)0001441871. Lot Number: 0001441871.`
- `Z-2933-2026` — `UDI: (01)20888937027451/ Lots: 24J1202Z, 25D2302Z, 25A0202Z, 25E1502Z, 25B2802Z, 25L0802Z`

`(01)` is the GTIN, `(17)` a YYMMDD expiry, `(10)` the lot, `(21)` the serial.
Parsing the AIs gives a second, independent key for free.

### EXPIRY_DATE — 3001 (22.3%)
Formats observed, all in the same corpus: `Exp 10/2025`, `Exp. Date 12/31/2023`,
`Exp Date: 2027/08`, `exp 31-08-25`, `Exp. Date March 2024`, `Exp Apr-25`,
`Expiry: 4/30/2026`, `BUD 12/13/2024`, `EXP: OCT 2028`, `Expiration: NOV/05/2026`.
Day-first and month-first both appear; `13/01/2026` is explicitly flagged
`(DD/MM/YYYY)` in `H-0582-2025`. An unresolvable ambiguity is a NEED_CODE, not
a coin flip.

### MODEL_CATALOG — 2828 (21.0%)
Gate applied before any unit-level test. Labels: `Model No.`, `Model Number`,
`Catalog Number`, `Cat. No.`, `REF`, `Part number`, `Product Number`,
`Item No.`, `UPN`, `SKU`, `Material REF`.

- `Z-2855-2026` — `Model/Catalog Number: FGD000100. UDI: 01072900175781181125120221NI2544-0300673 Software Version: FW Version 4.1.2.0, App version 7.28.0.11  GTIN: 7290017578118.  Serial Number: NI2544-0300673.`

### SERIAL_LIST — 1455 (10.8%), SERIAL_RANGE — 121 (0.9%)
Per-unit identity, mostly devices and CPSC vehicles. Ranges are usually
half-open and per-model:

- `Z-2938-2026` — `UDI-DI 04050147013797/  Serial Numbers:  All serial numbers up to 11608268 Software Version: 1.0.3`
- device, `and lower` idiom — `Affected Serial Numbers: 7010.000160 and lower, 7012.000356 and lower, 7013.000256 and lower, 7014.000152 and lower`
- CPSC — `manufactured from July 20, 2021 through December 17, 2022, and have serial numbers 1G20MB20001 through 1L17MB20228`

Mixed alpha-numeric serials do not order lexicographically. Where the ordering
cannot be established, return NEED_CODE.

### NO_QUALIFIER — 1417 (10.5%)
Nothing in the text discriminates units. 921 of these are CPSC, where it
genuinely means the whole product line:

- CPSC — `This recall involves all Boppy Newborn Loungers. The loungers were sold in a variety of colors and fashions...`

For FDA the same absence is weaker evidence, so the safe verdict is AFFECTED
with the notice text shown, never NOT_AFFECTED.

### UNIVERSAL_ALL — 1354 (10.0%), NO_CODE_SYSTEM — 58 (0.4%)
The firm says so explicitly. Constant-true predicate.

- `H-0780-2026` — `No lot numbers provided. Recall includes all product.`
- `H-0637-2026` — `All product in distribution as of 2/27/2026`
- `H-0173-2026` — `No codes applied, but customers receive a copy of the order sheet with the production date listed.`
- device — `EAN: 7340221700642; SKU: A-FOB; UDI-DI: None; Lot/Serial Number: All Lots;`

Watch for the combined form `All Lot Codes including and prior to 01APR2027`
(`H-0685-2026`): that is a cutoff, not a universal, and treating it as
universal is safe while treating it as universal-false is not.

### BEST_BY — 1344 (10.0%)
The only code most grocery shoppers can actually read off a package. Highest
demo value.

- `H-1222-2026` — `LOT: A6FF4, Best By: 11/2028`
- `H-1152-2026` — `24 count case with BEST IF USED BY DATES up to and including March 15, 2028 12 count package BEST IF USED BY DATES up to and including October 7, 2027`
- `H-1179-2026` — `Best By  codes range: 063026 through 093026`

Synonyms in the corpus: `Best By`, `Best Before`, `BEST IF USED BY`, `BB:`,
`Use By`, `Sell By`, `Sell Thru`, `Fresh Thru`, `Enjoy By`, `Pull date`,
`USE THRU DATES`.

### UPC_GTIN_EAN — 1320 (9.8%)
Product identity, not unit identity. Narrows candidates; never decides alone.
Appears spaced (`UPC: 8 904288 626025`), zero-padded to 12 or 14 digits, or
wrapped in a GS1 AI.

### MFG_DATE — 630 (4.7%), DATE_RANGE — 629 (4.7%), OPEN_ENDED_CUTOFF — 380 (2.8%)
Date arithmetic, the second-largest decidable family after lot lists.

- `H-1138-2026` — `Lot Code(s): 26J000059877-01  Dates of Manufacture: 04/27/2026  Lot Code(s): 26J000059877-02  Dates of Manufacture: 04/28/2026`
- `H-1071-2026` — `Product was labeled with a Packed On date of May 05. 26 or before.`
- food — `All Best By Dates Between:11/18/24 to 10/25/25 Plant Code: 24-65`
- CPSC — `Only bed rails  manufactured before December 15, 2025 are included in this recall. The manufacture date in YYYY-MM-DD format and model number are printed on the product packaging.`

Cutoff idioms: `and before`, `or before`, `and prior`, `or earlier`,
`and sooner`, `and lower`, `prior to`, `on or before`,
`up to and including`, `all dates through`.

### BARE_CODE_LIST — 269 (2.0%)
Unlabelled tokens. Field type has to be inferred from shape.

- `H-1228-2026` — `B15354, B15356, B15357, B15360, B15361, B15363`
- `H-1166-2026` — `710594511867,710594511850, 710594511560, 827912008456, 8279120084732, ...` (12-digit UPCs, one of them 13 digits — a typo in the source)

The typo matters: a strict length check would silently drop a real UPC. Compare
on normalised digits and keep unmatched tokens visible rather than discarding them.

### LOT_PREFIX — 159 (1.2%)
`startsWith`, sometimes with a numeric tail bound.

- `H-0309-2026` — `lot codes starting with SO-69006 and ending with SO-72558`
- `F-0206-2025` — `All Batch Codes starting with 2C and within shelf-life. Best By Dates: OCT 01 2024 to OCT 11 2025`
- CPSC — `date codes beginning with the prefix "A4" and followed by a five-digit number less than 22249`

### LOT_RANGE — 125 (0.9%), MODEL_RANGE — 125 (0.9%)
Ordered ranges over codes rather than dates.

- `H-0287-2025` — `Lot # 24351 through lot # 25156 (Julian calendar)`
- `H-0326-2026` — `Product Code: 21495 Best By Date: 09-22-2024 through 06-03-2028`
- CPSC — `Only drills with date codes 2017-37-FY through 2018-22-FY are affected. If the drill is marked with an "X" after the date code it has already been inspected and is not.`

The last one carries an exclusion clause inside the range. Ranges are not always
purely numeric and are not always inclusive of everything between the endpoints.

### SOFTWARE_VERSION — 129 (1.0%)
Devices, ordered compare on a dotted version.

- `Z-2913-2026` — `...Software version Numbers: 2.5.0, 2.5.0.1, 2.5.0.2, and 2.5.1`
- device — `UDI-DI: 00380740137410. GTIN: 06952999490048. Software versions 3.6.1 and lower.`
- `Z-0936-2026` — `Model Number: M204441; UDI-DI: 00840861102433; All serial numbers produced with a software version prior to 4.82.4;`

### PLANT_EST — 60 (0.4%)
Plant or establishment stamp. Discriminates otherwise identical packages.

- `H-0305-2026` — `Code Date: DEC08  Plant Code: PLT19-145  Timestamp: 17:51 to 21:23`
- food — `Plant Number: P-6562 or CA-5330; Carton UPC: 041512039638; ...`

Note the timestamp window in the first one: same date, same plant, and only
part of the shift is affected.

### JULIAN — 52 (0.4%)
Small class, disproportionate value: it is the clearest case of text a search
box cannot answer.

- `H-1230-2026` / `H-1229-2026` — `Code information is printed on the left or right sides of the carton.   Codes P-1950 or 0840962 with a Julian Date between 157 and 184 and a Best By/Sell By date Between July 20 - August 17, 2026`
- `H-0180-2026` — `Lot code which is julian date format (YYDDD) 25254 Best by date is 03/10/2026`
- `H-0381-2025` — `Best By 4/28 25104S  Code Explained: Best By: April 2028. Lot Number: 25104S Represents date of production:  YYDDD[S] YY 25 = 2025 Julian day = 104 [S] = 1 digit alpha suffix`
- food — `519501  L = Lot LA = Laurel, MD 5 = Last digit of calendar year 195 = Julian date of production 01 = Line number #1`
- food — `Julian Dates 3355 to 1536 (mfg. dates: 12/01/2025 to 06/02/2026)`

The last one is `DDDY`, not `YDDD`: 3355 is day 335 of 2025 (01 Dec 2025) and
1536 is day 153 of 2026 (02 Jun 2026), which the notice confirms in its own
parenthetical. A plain numeric compare inverts the range — 3355 > 1536 — so the
code has to be decoded to a real date before comparing, and the field order has
to be inferred rather than assumed.

Encodings seen: `YYDDD` (`25254`), `YYDDD` plus alpha suffix (`25104S`),
`YY DDD` split (`24 303`), `DDDY` (`3355`), bare `DDD` (`Julian date 134, 135`),
and embedded in a longer jet code (`S05-33 25218 20:05`, documented in the notice itself as
plant / year / Julian / fill time).

### DATE_CODE_FORMAT — 27 (0.2%)
The notice states the layout. Free parser spec when present: `YYDDD`,
`YYYYMM`, `MMDDYY`, `DD/MM/YYYY`, `MM-YYYY`, `DD.MM.YYYY`, `HF MMDDYY`.

- CPSC — `children's Grow 'N Stow Folding Learning Tower with model number LP01711 and date codes, in YYYYMM format, from 202409 to 202501`

### MASKED_CODE — 22 (0.2%), EMPTY — 98 (0.7%)
Not decidable. Must never produce NOT_AFFECTED.

- `Z-2182-2025` — `Lots: 2007xxxxx to 2012xxxxx (July-2020 to Dec-2020)`
- `Z-2179-2026` — `UDI 00885825003876, Lot Numbers:  xxxxx`
- `H-0073-2026` — `Case Code: Jan 10 26 xxxx(military time) ET 1 Primary Package code: (first line) Jan 10 26 CT127 (second line) XXXX (military time) ET071452`

## Consequences for the matcher

1. **Conjunction is the default.** A notice with a model gate and a lot list
   means model AND lot. Any parsed clause that fails to evaluate makes the whole
   notice NEED_CODE, not NOT_AFFECTED.
2. **A clear requires a positive parse.** NOT_AFFECTED is only legal when every
   clause parsed, the user supplied the key each clause needs, and at least one
   clause definitively excludes the unit. Absence of evidence is NEED_CODE.
3. **NEED_CODE must name the key.** The class tells you the question: LOT_LIST
   asks for the lot code, BEST_BY asks for the best-by date, JULIAN asks for the
   printed code and where on the package it is (the notices often say: "printed
   on the left or right sides of the carton").
4. **243 notices have truncated code_info** (source text over 20,000 characters,
   capped by the snapshot; see `code_info_truncated` in each record). Those are
   permanently UNDECIDABLE by construction and must route to NEED_CODE with the
   source link.
5. **Duplicate notice text is normal.** One recall event spans many recall
   numbers with identical `code_info` (`H-1229-2026` and `H-1230-2026` are the
   same text). Deduplicate on text when presenting, not when matching.
