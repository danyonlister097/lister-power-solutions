// Matches CNW invoice line items as pdf-parse actually extracts them: the
// PDF's table columns sit close enough together that no space survives
// between the product code, description, and quantity columns. Most items
// wrap across three physical text lines; big-ticket items (discPrice into
// four figures) instead stay on one line with a comma thousands separator.
// Real extracted examples:
//   1CBL1.5TEFFLAT TWIN & EARTH 1.5MM100.00100.000.00MTR
//   1.1617
//   11.62116.17
//   -> lineNo=1, code+desc="CBL1.5TEF"+"FLAT TWIN & EARTH 1.5MM", ordered=100.00,
//      supplied=100.00, backOrdered=0.00, unit=MTR, discPrice=1.1617, gst=11.62,
//      lineTotal=116.17
//   1VLTSTICKVS-12.00HMKINSUL TELESCOPIC STICK KIT V3 12.0 MTR1.001.000.00EA1,158.690115.871,158.69
//   -> same shape, but discPrice/gst/lineTotal all land on the item's first
//      line with no separating newline, and a stray zero-padding digit sits
//      between discPrice and gst.
// The optional (?:\r?\n)? and 0* below absorb those variations so one
// pattern covers both. Groups: lineNo, codeAndDescription, ordered, supplied,
// backOrdered, unit, discPrice, gst, lineTotal
const NUM2 = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}'; // 2-decimal amount, optional thousands comma
const NUMV = '\\d{1,3}(?:,\\d{3})*\\.\\d+'; // variable-decimal amount (unit disc price), optional thousands comma
const LINE_RE = new RegExp(
  '^(\\d{1,4})(\\D.*?)(' + NUM2 + ')(' + NUM2 + ')(' + NUM2 + ')([A-Z][A-Z0-9]{0,5})' +
  '(?:\\r?\\n)?(' + NUMV + ')(?:\\r?\\n)?0*(' + NUM2 + ')(' + NUM2 + ')\\r?$',
  'gm'
);

const INVOICE_NUMBER_RE = /Invoice:\s*(\d+)/;
const CREDIT_NUMBER_RE = /Credit:\s*(\d+)/;

// Credit note line items have a different layout to invoices:
//   {code+desc}\n{negative qty}\n{unit price}\n{negative gst}{negative total}
// e.g. CDT9025MDMD CONDUIT PVC RIGID 25MM GREY 4MTR\n-3.00\n6.2900\n-1.89-18.87
const CREDIT_LINE_RE = /^([A-Z][^\n]+)\n(-\d+\.\d+)\n(\d[\d,]*\.\d+)\n(-\d+\.\d{2})(-\d+\.\d{2})/gm;

function num(str) {
  return Number(str.replace(/,/g, ''));
}

// The product code and description run together with no separator (e.g.
// "CBL1.5TEFFLAT TWIN & EARTH 1.5MM"), and there's no punctuation rule that
// reliably tells them apart. Match against known supplier codes first -
// prefer the longest known code that prefixes the blob. For unknown codes,
// fall back to a heuristic: CNW codes always end with uppercase letters, so
// if the remainder starts with a digit (e.g. "2.5KW ...") the split point
// is the last letter before that digit.
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
  const m = blob.match(/^([A-Z][A-Z0-9.\-]*[A-Z])(\d)/);
  if (m && blob.slice(m[1].length).includes(' ')) {
    return { productCode: m[1], description: blob.slice(m[1].length).trim() };
  }
  return { productCode: blob.trim(), description: '' };
}

async function parseCnwDocument(pdfBuffer, knownCodes = []) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(pdfBuffer);
  const text = data.text;

  if (CREDIT_NUMBER_RE.test(text)) {
    const invoiceNumber = (text.match(CREDIT_NUMBER_RE) || [])[1] || null;
    const lineItems = [];
    let match;
    CREDIT_LINE_RE.lastIndex = 0;
    while ((match = CREDIT_LINE_RE.exec(text)) !== null) {
      const { productCode, description } = splitCodeAndDescription(match[1].trim(), knownCodes);
      lineItems.push({
        lineNo: lineItems.length + 1,
        productCode,
        description,
        supplied: Math.abs(num(match[2])),
        unit: 'each',
        unitCost: num(match[3]),
        gst: Math.abs(num(match[4])),
        lineTotal: Math.abs(num(match[5])),
      });
    }
    return { type: 'credit', invoiceNumber, lineItems, rawText: text };
  }

  const invoiceNumber = (text.match(INVOICE_NUMBER_RE) || [])[1] || null;
  const lineItems = [];
  let match;
  LINE_RE.lastIndex = 0;
  while ((match = LINE_RE.exec(text)) !== null) {
    const { productCode, description } = splitCodeAndDescription(match[2], knownCodes);
    lineItems.push({
      lineNo: Number(match[1]),
      productCode,
      description,
      ordered: num(match[3]),
      supplied: num(match[4]),
      backOrdered: num(match[5]),
      unit: match[6],
      unitCost: num(match[7]),
      gst: num(match[8]),
      lineTotal: num(match[9]),
    });
  }
  return { type: 'invoice', invoiceNumber, lineItems, rawText: text };
}

module.exports = { parseCnwDocument };
