const pdfParse = require('pdf-parse');

// Matches CNW invoice line items. Example:
// 1 CLI9020TCM20GY MD CORRUGATED CONDUIT PVC GREY 20MM 20M 1.00 1.00 0.00 EA 22.7800 2.28 22.78
// Groups: lineNo, productCode, description, ordered, supplied, backOrdered, unit, discPrice, gst, lineTotal
const LINE_RE = /^(\d+)\s+([A-Z][A-Z0-9]+)\s+(.+?)\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s+([A-Z]+)\s+(\d+\.\d+)\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s*$/gm;

const INVOICE_NUMBER_RE = /Invoice:\s*(\d+)/;

async function parseCnwInvoice(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  const text = data.text;

  const invoiceMatch = text.match(INVOICE_NUMBER_RE);
  const invoiceNumber = invoiceMatch ? invoiceMatch[1] : null;

  const lineItems = [];
  let match;
  LINE_RE.lastIndex = 0;
  while ((match = LINE_RE.exec(text)) !== null) {
    lineItems.push({
      lineNo: Number(match[1]),
      productCode: match[2],
      description: match[3].trim(),
      ordered: Number(match[4]),
      supplied: Number(match[5]),
      backOrdered: Number(match[6]),
      unit: match[7],
      unitCost: Number(match[8]),
      gst: Number(match[9]),
      lineTotal: Number(match[10]),
    });
  }

  return { invoiceNumber, lineItems, rawText: text };
}

module.exports = { parseCnwInvoice };
