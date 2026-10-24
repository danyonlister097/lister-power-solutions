// Matches Sherriff Electrical invoice line items as pdf-parse actually
// extracts them. Structurally the same fields as a CNW invoice (see
// cnwParser.js) but laid out differently: the product code+description sits
// alone on its own line, then the ordered/supplied/backOrdered/unit/price/
// gst/total numbers all run together with no separator on the next line.
// Real extracted example (verified against 12 real "Invoice: NNNNNN" emails
// sent by plainland@sherriff.com.au, captured 2026-10-24):
//   1CLI900/25/25WESOLID DUCT PVC MINI 25X25MM 4MTR WHITE
//   1.001.000.00EA25.95002.6025.95
//   -> lineNo=1, code+desc="CLI900/25/25WE"+"SOLID DUCT PVC MINI 25X25MM 4MTR WHITE",
//      ordered=1.00, supplied=1.00, backOrdered=0.00, unit=EA,
//      then "25.95002.6025.95" is disc price + gst + line total, all run
//      together with no separator.
//
// Unlike CNW's price column, Sherriff's disc price prints with a variable
// number of decimals - sometimes 2 (729.9500 is really "729.95" + "00"
// padding), sometimes genuinely 4 and non-zero (a per-metre cable price like
// "1.9999"), and sometimes with no padding at all ("1,199.9502"). There's no
// single fixed-width rule that splits "discPrice+gst+lineTotal" correctly
// for every line - e.g. "1.999920.00199.99" could syntactically be sliced
// several different ways, and plain greedy/lazy regex backtracking picks
// whichever split it finds first, not whichever one is actually right.
// splitTrailingAmounts below instead tries every syntactically valid 3-way
// split and keeps the one where lineTotal ~= discPrice x qty (gst ~= 10% of
// lineTotal as a tiebreaker) - verified against every line item on all 12
// real sample invoices (quantities from 1 to 200, amounts from $0.69 lines
// up to a $3,500 freight line), every single one resolves correctly.
const NUM2 = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}'; // 2-decimal amount, optional thousands comma
// Unit is letters-only ([A-Z]{1,4}, e.g. "EA", "MTR") rather than CNW's
// [A-Z][A-Z0-9]{0,5} - here the unit sits directly against the following
// digits with no newline between them, so an alphanumeric-unit class would
// (and initially did, while this was being built) greedily swallow a leading
// digit off the price that follows, throwing every later field off by one
// character.
const LINE_RE = new RegExp(
  '^(\\d{1,4})(\\D[^\\r\\n]*?)\\r?\\n' +
  '(' + NUM2 + ')(' + NUM2 + ')(' + NUM2 + ')([A-Z]{1,4})' +
  '(.+?)\\r?$',
  'gm'
);

const AMOUNT_RE = /^\d{1,3}(?:,\d{3})*\.\d+$/; // any number of decimals - candidate disc price
const NUM2_ONLY_RE = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;

// Only ever seen as an invoice so far - no real credit-note sample to build
// a line-item pattern from (unlike CNW, whose credit layout is confirmed
// different from its invoice layout). Requiring this literal header, not
// just "Invoice: NNNN" appearing anywhere, means an actual Sherriff credit
// note - whatever its real layout turns out to be - won't get misread as an
// invoice (which would increase stock instead of decreasing it); it falls
// through to invoiceNumber === null and is left unread, same as any other
// unrecognised document.
const TAX_INVOICE_RE = /TAX INVOICE/;
const INVOICE_NUMBER_RE = /Invoice:\s*(\d+)/;

function num(str) {
  return Number(str.replace(/,/g, ''));
}

// Tries every syntactically valid way to carve `tail` into
// (discPrice)(gst)(lineTotal) concatenated with no separators, and returns
// whichever carving is arithmetically consistent with the known quantity
// (lineTotal ~= discPrice x supplied, gst ~= 10% of lineTotal). Falls back
// to null if nothing both parses and adds up - callers should treat that
// line as unparseable rather than guess.
function splitTrailingAmounts(tail, supplied) {
  let best = null;
  for (let i = 1; i < tail.length; i++) {
    const discStr = tail.slice(0, i);
    if (!AMOUNT_RE.test(discStr)) continue;
    const rest = tail.slice(i);
    for (let j = 1; j < rest.length; j++) {
      const gstStr = rest.slice(0, j);
      const totalStr = rest.slice(j);
      if (!NUM2_ONLY_RE.test(gstStr) || !NUM2_ONLY_RE.test(totalStr)) continue;
      const discPrice = num(discStr);
      const gst = num(gstStr);
      const lineTotal = num(totalStr);
      const totalErr = supplied > 0 ? Math.abs(discPrice * supplied - lineTotal) : (discPrice === 0 ? 0 : Infinity);
      const gstErr = Math.abs(lineTotal * 0.1 - gst);
      const score = totalErr * 1000 + gstErr; // total-correctness dominates the choice
      if (!best || score < best.score) best = { discPrice, gst, lineTotal, score, totalErr, gstErr };
    }
  }
  if (!best || best.totalErr > 0.02 || best.gstErr > 0.02) return null;
  return { discPrice: best.discPrice, gst: best.gst, lineTotal: best.lineTotal };
}

// Same approach as cnwParser's splitCodeAndDescription: prefer the longest
// already-known code that prefixes the blob. Sherriff codes can contain "/"
// (e.g. "CLI900/25/25WE", "PANCS/CU-RZ50AKR") so there's no safe fallback
// split point for a code this function has never seen before - unlike CNW's
// codes, Sherriff's don't reliably end right before a digit (an aircon code
// like "PANCS/CU-RZ50AKR" ends in letters, immediately followed by the word
// "AIR..."). That's fine in practice: a code only needs a first-time guess
// once - after it's auto-added to inventory, every future invoice matches it
// exactly via knownCodes, same bootstrapping CNW already relies on.
function splitCodeAndDescription(blob, knownCodes) {
  let best = '';
  for (const code of knownCodes) {
    if (code.length > best.length && blob.startsWith(code)) {
      best = code;
    }
  }
  if (best) {
    return { productCode: best, description: blob.slice(best.length).trim() };
  }
  return { productCode: blob.trim(), description: '' };
}

async function parseSherriffDocument(pdfBuffer, knownCodes = []) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(pdfBuffer);
  const text = data.text;

  if (!TAX_INVOICE_RE.test(text)) {
    // Not a recognised Sherriff invoice - could be a credit note (format
    // unknown), statement, quote, or something else entirely. Left for the
    // caller to skip/leave unread, exactly like a CNW document with no
    // invoiceNumber.
    return { type: null, invoiceNumber: null, lineItems: [], rawText: text };
  }

  const invoiceNumber = (text.match(INVOICE_NUMBER_RE) || [])[1] || null;
  const lineItems = [];
  let match;
  LINE_RE.lastIndex = 0;
  while ((match = LINE_RE.exec(text)) !== null) {
    const { productCode, description } = splitCodeAndDescription(match[2].trim(), knownCodes);
    const ordered = num(match[3]);
    const supplied = num(match[4]);
    const backOrdered = num(match[5]);
    const unit = match[6];
    const amounts = splitTrailingAmounts(match[7], supplied);
    if (!amounts) {
      // Couldn't find an arithmetically consistent split (e.g. a stray
      // multi-page header line or something unanticipated matched the
      // broad pattern) - skip this one line rather than record a made-up
      // cost or quantity for it.
      continue;
    }
    lineItems.push({
      lineNo: Number(match[1]),
      productCode,
      description,
      ordered,
      supplied,
      backOrdered,
      unit,
      unitCost: amounts.discPrice,
      gst: amounts.gst,
      lineTotal: amounts.lineTotal,
    });
  }
  return { type: 'invoice', invoiceNumber, lineItems, rawText: text };
}

module.exports = { parseSherriffDocument };
