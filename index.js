import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";

dotenv.config();

const app = express();
import fs from "fs";
const logError = (msg) => {
  try { fs.appendFileSync("server_error.log", new Date().toISOString() + ": " + msg + "\n"); } catch (e) { }
};

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// --- Layout configuration: bounding boxes and table geometry ---
// NOTE: All coordinates are examples and must be fine-tuned against the real PDF.
// PDF coordinate system origin is bottom-left.

const fieldBoxes = {
  receiverName: { x: 80, y: 560, width: 250, height: 14 },
  receiverAddress: { x: 80, y: 530, width: 250, height: 40, lineHeight: 12, maxLines: 3 },
  receiverPhone: { x: 80, y: 505, width: 120, height: 12 },
  receiverEmail: { x: 230, y: 505, width: 200, height: 12 },
  receiverGstin: { x: 80, y: 490, width: 150, height: 12 },

  poNumber: { x: 420, y: 560, width: 140, height: 12 },
  poDate: { x: 420, y: 545, width: 140, height: 12 },
  transportMode: { x: 420, y: 530, width: 140, height: 12 },
  deliveryDate: { x: 420, y: 515, width: 140, height: 12 },
  destination: { x: 420, y: 500, width: 140, height: 12 },
};

// Table geometry
const tableConfig = {
  startX: 40,
  startY: 430,
  rowHeight: 16,
  maxRows: 10,
  columns: {
    sNo: { x: 48, width: 25, align: "center" },
    particulars: { x: 80, width: 200, align: "left" },
    hsn: { x: 290, width: 50, align: "center" },
    dcNo: { x: 345, width: 60, align: "center" },
    rate: { x: 410, width: 70, align: "right" },
    qty: { x: 485, width: 40, align: "center" },
    amount: { x: 530, width: 70, align: "right" },
  },
};

// Totals boxes (right aligned)
const totalsBoxes = {
  total: { x: 530, y: 260, width: 70, height: 12 },
  cgst: { x: 530, y: 244, width: 70, height: 12 },
  sgst: { x: 530, y: 228, width: 70, height: 12 },
  igst: { x: 530, y: 212, width: 70, height: 12 },
  gst: { x: 530, y: 196, width: 70, height: 12 },
  roundedOff: { x: 530, y: 180, width: 70, height: 12 },
  grandTotal: { x: 530, y: 164, width: 70, height: 12 },
};

function clipTextToWidth(text, font, fontSize, maxWidth) {
  if (!text) return "";
  let current = text;
  while (current.length > 0) {
    const w = font.widthOfTextAtSize(current, fontSize);
    if (w <= maxWidth) break;
    current = current.slice(0, -1);
  }
  return current;
}

function drawTextInBox(page, font, text, fontSize, box, align = "left") {
  const clipped = clipTextToWidth(text, font, fontSize, box.width);
  if (!clipped) return;
  const textWidth = font.widthOfTextAtSize(clipped, fontSize);
  let x = box.x;
  if (align === "center") {
    x = box.x + (box.width - textWidth) / 2;
  } else if (align === "right") {
    x = box.x + box.width - textWidth;
  }
  const y = box.y;
  page.drawText(clipped, { x, y, size: fontSize, font });
}

function drawMultilineBox(page, font, text, fontSize, box) {
  if (!text) return;
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= box.width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= box.maxLines) break;
    }
    if (lines.length >= box.maxLines) break;
  }
  if (lines.length < box.maxLines && current) {
    lines.push(current);
  }
  const usedLines = lines.slice(0, box.maxLines);
  usedLines.forEach((line, i) => {
    const y = box.y + box.height - box.lineHeight * (i + 1);
    page.drawText(line, { x: box.x, y, size: fontSize, font });
  });
}

// Generate PDF from scratch matching SRI CHAKRI TRADERS format
async function generateProformaInvoice(payload) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 10;
  const smallFontSize = 8;
  const headerFontSize = 20;

  // Green header band
  const headerHeight = 120;
  const greenColor = rgb(0.2, 0.6, 0.3); // Green color
  const yellowColor = rgb(1, 1, 0.2); // Yellow color for text
  const whiteColor = rgb(1, 1, 1); // White color
  const logoBox = {
    x: 20,
    y: height - headerHeight + 15,
    width: 90,
    height: 90,
  };

  async function drawLogoIfPresent() {
    if (!payload.logoDataUrl) return;
    const match = String(payload.logoDataUrl).match(
      /^data:image\/(png|jpeg|jpg);base64,(.+)$/i
    );
    if (!match) return;
    const [, ext, b64] = match;
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    let img;
    if (ext.toLowerCase() === "png") {
      img = await pdfDoc.embedPng(bytes);
    } else {
      img = await pdfDoc.embedJpg(bytes);
    }
    const { width: iw, height: ih } = img.scaleToFit(logoBox.width, logoBox.height);
    const dx = logoBox.x + (logoBox.width - iw) / 2;
    const dy = logoBox.y + (logoBox.height - ih) / 2;
    page.drawImage(img, { x: dx, y: dy, width: iw, height: ih });
  }

  page.drawRectangle({
    x: 0,
    y: height - headerHeight,
    width: width,
    height: headerHeight,
    color: greenColor,
  });

  // Logo area (left side of green band)
  page.drawRectangle({
    x: logoBox.x,
    y: logoBox.y,
    width: logoBox.width,
    height: logoBox.height,
    borderColor: yellowColor,
    borderWidth: 2,
    color: rgb(0.9, 0.9, 0.9),
  });
  await drawLogoIfPresent();

  // Text block to the right of the logo (like reference heading)
  const textLeft = logoBox.x + logoBox.width + 20;
  const textMaxWidth = width - textLeft - 20;
  let currentY = height - 50;

  const companyName = "SRI CHAKRI TRADERS";
  page.drawText(companyName, {
    x: textLeft,
    y: currentY,
    size: headerFontSize,
    font: boldFont,
    color: yellowColor,
  });

  // Address
  currentY -= 24;
  const address = "222, C1, P.K.M.R. Nagar, Dharapuram Road, Tirupur-641 604";
  page.drawText(address, {
    x: textLeft,
    y: currentY,
    size: fontSize,
    font: font,
    color: yellowColor,
    maxWidth: textMaxWidth,
  });

  // Mobile
  currentY -= 18;
  const mobile = "Mobile no: 8072202136, 9976951369";
  page.drawText(mobile, {
    x: textLeft,
    y: currentY,
    size: fontSize,
    font: font,
    color: yellowColor,
  });

  // Email
  currentY -= 18;
  const email = "srichakritraderstup@gmail.com";
  page.drawText(email, {
    x: textLeft,
    y: currentY,
    size: fontSize,
    font: font,
    color: yellowColor,
  });

  // GST Number on right side of green band
  const gstText = "GST No.: 33DMSPD3047K1ZV";
  page.drawText(gstText, {
    x: width - 30 - font.widthOfTextAtSize(gstText, fontSize),
    y: height - 50,
    size: fontSize,
    font: font,
    color: yellowColor,
  });

  // PERFORMA INVOICE box in green band
  const invoiceBoxY = height - headerHeight + 10;
  const invoiceBoxHeight = 25;
  page.drawRectangle({
    x: width - 150,
    y: invoiceBoxY,
    width: 130,
    height: invoiceBoxHeight,
    borderColor: whiteColor,
    borderWidth: 1.5,
    color: greenColor,
  });
  page.drawText("PERFORMA INVOICE", {
    x: width - 145,
    y: invoiceBoxY + 7,
    size: fontSize,
    font: boldFont,
    color: whiteColor,
  });

  currentY = height - headerHeight - 20;

  // Horizontal line separator
  page.drawLine({
    start: { x: 0, y: currentY },
    end: { x: width, y: currentY },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  currentY -= 25;

  // To section - left aligned
  const receiverName = payload.receiverName || "";
  page.drawText("To. M/s.", { x: 50, y: currentY, size: fontSize, font: font });
  page.drawText(receiverName, { x: 120, y: currentY, size: fontSize, font: font });

  // Right side - Order By
  const orderBy = payload.orderBy || "VOLTA FASHIONS";
  page.drawText(`Order By: ${orderBy}`, { x: 350, y: currentY, size: fontSize, font: font });

  currentY -= 20;
  // Mobile numbers on same line
  const phone = payload.receiverPhone || "";
  page.drawText(`Mobile no: ${phone}`, { x: 350, y: currentY, size: fontSize, font: font });
  page.drawText(`Mobile no: ${phone}`, { x: 480, y: currentY, size: fontSize, font: font });

  currentY -= 20;
  // PI Date and Date on same line
  let piDate = payload.piDate || payload.poDate || new Date().toISOString().split('T')[0];
  // Convert YYYY-MM-DD to DD.MM.YYYY format
  if (piDate.includes('-')) {
    const [year, month, day] = piDate.split('-');
    piDate = `${day}.${month}.${year}`;
  }
  page.drawText(`PI.Dt:${piDate}`, { x: 350, y: currentY, size: fontSize, font: font });
  page.drawText(`Date: ${piDate}`, { x: 480, y: currentY, size: fontSize, font: font });

  currentY -= 25;

  // Table with borders
  const tableStartX = 30;
  const tableEndX = width - 30;
  const tableWidth = tableEndX - tableStartX;
  const colWidths = { sNo: 40, particulars: 180, hsn: 80, dcNo: 70, rate: 80, qty: 70, amount: 65 };
  const totalColWidth = Object.values(colWidths).reduce((a, b) => a + b, 0);
  const colWidthsAdjusted = {};
  Object.keys(colWidths).forEach((key, idx) => {
    colWidthsAdjusted[key] = (colWidths[key] / totalColWidth) * tableWidth;
  });

  // Table border
  const tableTopY = currentY + 15;
  const tableHeaderHeight = 20;

  // Table headers with borders
  const headers = ["S.No.", "Particulars", "HSN CODE", "D.C. No.", "Rate Rs.", "Quantity", "Amount"];
  let headerX = tableStartX;

  // Draw table border
  page.drawRectangle({
    x: tableStartX,
    y: tableTopY - tableHeaderHeight,
    width: tableWidth,
    height: tableHeaderHeight,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });

  // Draw vertical lines for columns
  let colX = tableStartX;
  Object.values(colWidthsAdjusted).forEach((colWidth, idx) => {
    if (idx > 0 && idx < Object.keys(colWidthsAdjusted).length) {
      page.drawLine({
        start: { x: colX, y: tableTopY },
        end: { x: colX, y: tableTopY - tableHeaderHeight },
        thickness: 0.5,
        color: rgb(0, 0, 0),
      });
    }
    colX += colWidth;
  });

  // Header text
  headerX = tableStartX;
  headers.forEach((header, idx) => {
    const colWidth = Object.values(colWidthsAdjusted)[idx];
    if (idx === 0) {
      page.drawText(header, { x: headerX + 5, y: tableTopY - 12, size: smallFontSize, font: boldFont });
    } else if (idx === 4 || idx === 6) {
      const textWidth = boldFont.widthOfTextAtSize(header, smallFontSize);
      page.drawText(header, { x: headerX + colWidth - textWidth - 5, y: tableTopY - 12, size: smallFontSize, font: boldFont });
    } else {
      page.drawText(header, { x: headerX + 5, y: tableTopY - 12, size: smallFontSize, font: boldFont });
    }
    headerX += colWidth;
  });

  currentY = tableTopY - tableHeaderHeight - 5;

  // Table rows with borders
  const items = Array.isArray(payload.items) ? payload.items : [];
  let total = 0;
  const rowHeight = 20;
  const maxRows = 12;

  items.slice(0, maxRows).forEach((item, index) => {
    if (currentY < 280) return; // Stop if too low

    const rate = Number(item.rate) || 0;
    const qty = Number(item.quantity) || 0;
    const amount = rate * qty;
    total += amount;

    // Draw row border
    page.drawRectangle({
      x: tableStartX,
      y: currentY - rowHeight,
      width: tableWidth,
      height: rowHeight,
      borderColor: rgb(0, 0, 0),
      borderWidth: 0.5,
    });

    // Draw vertical lines
    let colX = tableStartX;
    Object.values(colWidthsAdjusted).forEach((colWidth, idx) => {
      if (idx > 0 && idx < Object.keys(colWidthsAdjusted).length) {
        page.drawLine({
          start: { x: colX, y: currentY },
          end: { x: colX, y: currentY - rowHeight },
          thickness: 0.5,
          color: rgb(0, 0, 0),
        });
      }
      colX += colWidth;
    });

    let rowX = tableStartX;
    const rowData = [
      String(index + 1),
      item.particulars || "",
      item.hsn || "",
      item.dcNo || "",
      rate > 0 ? rate.toFixed(2) : "",
      qty > 0 ? qty.toString() : "",
      amount > 0 ? amount.toFixed(2) : "",
    ];

    rowData.forEach((data, idx) => {
      const colWidth = Object.values(colWidthsAdjusted)[idx];
      if (idx === 0) {
        const textWidth = font.widthOfTextAtSize(data, smallFontSize);
        page.drawText(data, { x: rowX + colWidth / 2 - textWidth / 2, y: currentY - 12, size: smallFontSize, font: font });
      } else if (idx === 4 || idx === 6) {
        const textWidth = font.widthOfTextAtSize(data, smallFontSize);
        page.drawText(data, { x: rowX + colWidth - textWidth - 5, y: currentY - 12, size: smallFontSize, font: font });
      } else if (idx === 5) {
        const textWidth = font.widthOfTextAtSize(data, smallFontSize);
        page.drawText(data, { x: rowX + colWidth / 2 - textWidth / 2, y: currentY - 12, size: smallFontSize, font: font });
      } else {
        page.drawText(data, { x: rowX + 5, y: currentY - 12, size: smallFontSize, font: font });
      }
      rowX += colWidth;
    });

    currentY -= rowHeight;
  });

  // Draw empty rows if needed
  const emptyRows = maxRows - items.length;
  for (let i = 0; i < emptyRows && currentY > 280; i++) {
    page.drawRectangle({
      x: tableStartX,
      y: currentY - rowHeight,
      width: tableWidth,
      height: rowHeight,
      borderColor: rgb(0, 0, 0),
      borderWidth: 0.5,
    });

    let colX = tableStartX;
    Object.values(colWidthsAdjusted).forEach((colWidth, idx) => {
      if (idx > 0 && idx < Object.keys(colWidthsAdjusted).length) {
        page.drawLine({
          start: { x: colX, y: currentY },
          end: { x: colX, y: currentY - rowHeight },
          thickness: 0.5,
          color: rgb(0, 0, 0),
        });
      }
      colX += colWidth;
    });

    currentY -= rowHeight;
  }

  currentY -= 20;

  // Totals section with borders - right side
  const totalsStartX = width - 200;
  const totalsWidth = 170;
  const totalsStartY = currentY + 10;
  const totalsRowHeight = 18;
  const numTotalsRows = 7;
  const totalsHeight = numTotalsRows * totalsRowHeight;

  const cgstRate = Number(payload.cgstRate ?? 0);
  const sgstRate = Number(payload.sgstRate ?? 0);
  const igstRate = Number(payload.igstRate ?? 0);

  const cgst = (total * cgstRate) / 100;
  const sgst = (total * sgstRate) / 100;
  const igst = (total * igstRate) / 100;
  const gst = cgst + sgst + igst;
  const gross = total + gst;
  const roundedGrand = Math.round(gross);
  const roundedOff = roundedGrand - gross;

  const igstLabel = igstRate > 0 ? `IGST ${igstRate}%` : "IGST 12%";

  // Draw totals table border
  page.drawRectangle({
    x: totalsStartX,
    y: totalsStartY - totalsHeight,
    width: totalsWidth,
    height: totalsHeight,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });

  // Rupees field on left side
  const rupeesFieldX = 30;
  const rupeesFieldY = totalsStartY - 60;
  const rupeesFieldWidth = 150;
  const rupeesFieldHeight = 80;
  page.drawRectangle({
    x: rupeesFieldX,
    y: rupeesFieldY - rupeesFieldHeight,
    width: rupeesFieldWidth,
    height: rupeesFieldHeight,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawText("Rupees", { x: rupeesFieldX + 5, y: rupeesFieldY - 15, size: smallFontSize, font: boldFont });

  let totalsY = totalsStartY - 15;
  const labelX = totalsStartX + 5;
  const valueX = totalsStartX + totalsWidth - 10;

  // TOTAL
  page.drawText("TOTAL", { x: labelX, y: totalsY, size: smallFontSize, font: font });
  const totalWidth = font.widthOfTextAtSize(total.toFixed(2), smallFontSize);
  page.drawText(total.toFixed(2), { x: valueX - totalWidth, y: totalsY, size: smallFontSize, font: font });
  totalsY -= totalsRowHeight;

  // GST
  page.drawText("GST", { x: labelX, y: totalsY, size: smallFontSize, font: font });
  totalsY -= totalsRowHeight;

  // CGST
  page.drawText("CGST", { x: labelX, y: totalsY, size: smallFontSize, font: font });
  if (cgst > 0) {
    const cgstWidth = font.widthOfTextAtSize(cgst.toFixed(2), smallFontSize);
    page.drawText(cgst.toFixed(2), { x: valueX - cgstWidth, y: totalsY, size: smallFontSize, font: font });
  }
  totalsY -= totalsRowHeight;

  // SGST
  page.drawText("SGST", { x: labelX, y: totalsY, size: smallFontSize, font: font });
  if (sgst > 0) {
    const sgstWidth = font.widthOfTextAtSize(sgst.toFixed(2), smallFontSize);
    page.drawText(sgst.toFixed(2), { x: valueX - sgstWidth, y: totalsY, size: smallFontSize, font: font });
  }
  totalsY -= totalsRowHeight;

  // IGST
  page.drawText(igstLabel, { x: labelX, y: totalsY, size: smallFontSize, font: font });
  if (igst > 0) {
    const igstWidth = font.widthOfTextAtSize(igst.toFixed(2), smallFontSize);
    page.drawText(igst.toFixed(2), { x: valueX - igstWidth, y: totalsY, size: smallFontSize, font: font });
  }
  totalsY -= totalsRowHeight;

  // Rounded Off
  page.drawText("Rounded Off", { x: labelX, y: totalsY, size: smallFontSize, font: font });
  const roundedWidth = font.widthOfTextAtSize(roundedOff.toFixed(2), smallFontSize);
  page.drawText(roundedOff.toFixed(2), { x: valueX - roundedWidth, y: totalsY, size: smallFontSize, font: font });
  totalsY -= totalsRowHeight;

  // GRAND TOTAL
  page.drawText("GRAND TOTAL", { x: labelX, y: totalsY, size: fontSize, font: boldFont });
  const grandWidth = boldFont.widthOfTextAtSize(roundedGrand.toFixed(2), fontSize);
  page.drawText(roundedGrand.toFixed(2), { x: valueX - grandWidth, y: totalsY, size: fontSize, font: boldFont });

  currentY = totalsStartY - totalsHeight - 20;

  // Footer terms - left side
  const footerY = currentY;
  const terms = [
    "• Payments are to be made by A/C Payee's cheque or DD payable at Tirupur",
    "• Claims of any nature whatsoever will lapse unless raised in writing within 5 days from the date of invoice",
    "• Interest will be charged @ 24% from the date of Invoice.",
    "• Subject to Tirupur Jurisdiction.",
  ];

  let footerYPos = footerY;
  terms.forEach((term) => {
    page.drawText(term, { x: 50, y: footerYPos, size: smallFontSize, font: font });
    footerYPos -= 15;
  });

  // Signature - right side
  page.drawText("For SRI CHAKRI TRADERS,", { x: width - 200, y: footerY, size: smallFontSize, font: font });
  page.drawText("T.J. DURGA", { x: width - 200, y: footerY - 15, size: smallFontSize, font: font });
  page.drawText("Authorised Signatory", { x: width - 200, y: footerY - 30, size: smallFontSize, font: font });

  // Pink footer band
  const pinkColor = rgb(1, 0.75, 0.8); // Pink color
  const magentaColor = rgb(0.8, 0, 0.5); // Magenta color for text
  const footerHeight = 50;

  page.drawRectangle({
    x: 0,
    y: 0,
    width: width,
    height: footerHeight,
    color: pinkColor,
  });

  // Additional note in pink footer
  const noteY = 35;
  page.drawText("FOR YOUR KIND ATTENTION:", { x: 30, y: noteY, size: smallFontSize, font: boldFont, color: magentaColor });
  page.drawText("payment must be within 30 days from the despatch day.( Pay by cheque)", { x: 30, y: noteY - 15, size: smallFontSize, font: font, color: magentaColor });
  page.drawText("AFTER RECEIVING THE PI , PLEASE SEND POST DATED CHEQUE", { x: 30, y: noteY - 30, size: smallFontSize, font: font, color: magentaColor });

  return await pdfDoc.save();
}

// New endpoint: Generate PDF from scratch and download
app.post("/api/generate-pdf", async (req, res) => {
  try {
    const payload = req.body;

    const requiredFields = [
      "receiverName",
      "receiverPhone",
      "items",
    ];

    for (const f of requiredFields) {
      if (payload[f] === undefined || payload[f] === null || payload[f] === "") {
        return res.status(400).json({ error: `Missing required field: ${f}` });
      }
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "At least one line item is required" });
    }

    // Validate items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rate = Number(item.rate);
      const qty = Number(item.quantity);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ error: `Invalid rate at row ${i + 1}` });
      }
      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ error: `Invalid quantity at row ${i + 1}` });
      }
    }

    const pdfBytes = await generateProformaInvoice(payload);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="proforma-invoice-${payload.poNumber || Date.now()}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    const message = (err && err.message) || "Failed to generate PDF";
    res.status(500).json({ error: message });
  }
});

// New endpoint: Generate PDF from scratch and email
app.post("/api/generate-and-email-pdf", async (req, res) => {
  try {
    const payload = req.body;

    const requiredFields = [
      "receiverName",
      "receiverPhone",
      "items",
      "toEmail",
    ];

    for (const f of requiredFields) {
      if (payload[f] === undefined || payload[f] === null || payload[f] === "") {
        return res.status(400).json({ error: `Missing required field: ${f}` });
      }
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "At least one line item is required" });
    }

    // Validate items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rate = Number(item.rate);
      const qty = Number(item.quantity);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ error: `Invalid rate at row ${i + 1}` });
      }
      if (!Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ error: `Invalid quantity at row ${i + 1}` });
      }
    }

    const pdfBytes = await generateProformaInvoice(payload);

    // Email configuration validation
    if (!process.env.BREVO_API_KEY) {
      return res.status(500).json({
        error: "Brevo API Key configuration not set. Please configure BREVO_API_KEY in .env file"
      });
    }

    const senderEmail = process.env.SENDER_EMAIL || "srichakritraderstup@gmail.com";
    const subject = payload.emailSubject || `Proforma Invoice: ${payload.poNumber || "PI"}`;
    const body = payload.emailBody || `Please find attached the Proforma Invoice for PO #${payload.poNumber || "PI"}.`;

    const apiInstance = new TransactionalEmailsApi();
    apiInstance.authentications['apiKey'].apiKey = process.env.BREVO_API_KEY;

    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = `<html><body><p>${body.replace(/\n/g, "<br>")}</p></body></html>`;
    sendSmtpEmail.sender = { name: "Sri Chakri Traders", email: senderEmail };
    sendSmtpEmail.to = [{ email: payload.toEmail }];
    sendSmtpEmail.textContent = body;
    sendSmtpEmail.attachment = [
      {
        content: Buffer.from(pdfBytes).toString("base64"),
        name: `proforma-invoice-${payload.poNumber || Date.now()}.pdf`
      }
    ];

    try {
      const reqLog = `Sending email from ${senderEmail} to ${payload.toEmail}`;
      console.log(reqLog);
      try { fs.appendFileSync("server_debug.log", new Date().toISOString() + " REQUEST: " + reqLog + "\n"); } catch (e) { }

      const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log('Brevo SDK Success. Returned data: ' + JSON.stringify(data));
      try { fs.appendFileSync("server_debug.log", new Date().toISOString() + " SUCCESS: " + JSON.stringify(data) + "\n"); } catch (e) { }
      res.json({ ok: true, message: "PDF generated and emailed successfully via Brevo SDK" });
    } catch (error) {
      console.error('Brevo SDK Error:', error.body || error);
      logError('Brevo SDK Error: ' + JSON.stringify(error.body || error));
      res.status(500).json({ error: error.body ? JSON.stringify(error.body) : error.message });
    }
  } catch (err) {
    console.error(err);
    const message = (err && err.message) || "Failed to generate or email PDF";
    res.status(500).json({ error: message });
  }
});

// Old endpoint: Generate PDF from template and email (kept for backward compatibility)
app.post(
  "/api/generate-and-email",
  upload.single("template"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Template PDF is required" });
      }

      const payload = JSON.parse(req.body.payload || "{}");

      const requiredFields = [
        "receiverName",
        "receiverAddress",
        "receiverPhone",
        "receiverEmail",
        "receiverGstin",
        "poNumber",
        "poDate",
        "transportMode",
        "deliveryDate",
        "destination",
        "items",
        "toEmail",
      ];

      for (const f of requiredFields) {
        if (payload[f] === undefined || payload[f] === null || payload[f] === "") {
          return res.status(400).json({ error: `Missing required field: ${f}` });
        }
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) {
        return res.status(400).json({ error: "At least one line item is required" });
      }

      const parsedItems = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rate = Number(item.rate);
        const qty = Number(item.quantity);
        if (!Number.isFinite(rate) || rate < 0) {
          return res.status(400).json({ error: `Invalid rate at row ${i + 1}` });
        }
        if (!Number.isFinite(qty) || qty < 0) {
          return res.status(400).json({ error: `Invalid quantity at row ${i + 1}` });
        }
        const amount = rate * qty;
        parsedItems.push({ ...item, rate, quantity: qty, amount });
      }

      if (parsedItems.length > tableConfig.maxRows) {
        parsedItems.length = tableConfig.maxRows;
      }

      const pdfDoc = await PDFDocument.load(req.file.buffer);
      const pages = pdfDoc.getPages();
      const page = pages[0];
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontSize = 9;

      // Receiver and header fields
      drawTextInBox(page, font, payload.receiverName, fontSize, fieldBoxes.receiverName, "left");
      drawMultilineBox(page, font, payload.receiverAddress, fontSize, fieldBoxes.receiverAddress);
      drawTextInBox(page, font, payload.receiverPhone, fontSize, fieldBoxes.receiverPhone, "left");
      drawTextInBox(page, font, payload.receiverEmail, fontSize, fieldBoxes.receiverEmail, "left");
      drawTextInBox(page, font, payload.receiverGstin, fontSize, fieldBoxes.receiverGstin, "left");

      drawTextInBox(page, font, payload.poNumber, fontSize, fieldBoxes.poNumber, "left");
      drawTextInBox(page, font, payload.poDate, fontSize, fieldBoxes.poDate, "left");
      drawTextInBox(page, font, payload.transportMode, fontSize, fieldBoxes.transportMode, "left");
      drawTextInBox(page, font, payload.deliveryDate, fontSize, fieldBoxes.deliveryDate, "left");
      drawTextInBox(page, font, payload.destination, fontSize, fieldBoxes.destination, "left");

      // Table rows
      let total = 0;
      parsedItems.forEach((item, index) => {
        const rowY = tableConfig.startY - tableConfig.rowHeight * index;
        const rowBaseBox = (col) => ({
          x: col.x,
          y: rowY,
          width: col.width,
          height: tableConfig.rowHeight,
        });

        const rowNo = index + 1;
        drawTextInBox(
          page,
          font,
          String(rowNo),
          fontSize,
          rowBaseBox(tableConfig.columns.sNo),
          "center"
        );
        drawTextInBox(
          page,
          font,
          item.particulars || "",
          fontSize,
          rowBaseBox(tableConfig.columns.particulars),
          "left"
        );
        drawTextInBox(
          page,
          font,
          item.hsn || "",
          fontSize,
          rowBaseBox(tableConfig.columns.hsn),
          "center"
        );
        drawTextInBox(
          page,
          font,
          item.dcNo || "",
          fontSize,
          rowBaseBox(tableConfig.columns.dcNo),
          "center"
        );
        drawTextInBox(
          page,
          font,
          item.rate.toFixed(2),
          fontSize,
          rowBaseBox(tableConfig.columns.rate),
          "right"
        );
        drawTextInBox(
          page,
          font,
          item.quantity.toString(),
          fontSize,
          rowBaseBox(tableConfig.columns.qty),
          "center"
        );
        drawTextInBox(
          page,
          font,
          item.amount.toFixed(2),
          fontSize,
          rowBaseBox(tableConfig.columns.amount),
          "right"
        );

        total += item.amount;
      });

      // Taxes
      const cgstRate = Number(payload.cgstRate ?? 0);
      const sgstRate = Number(payload.sgstRate ?? 0);
      const igstRate = Number(payload.igstRate ?? 0);

      const cgst = (total * cgstRate) / 100;
      const sgst = (total * sgstRate) / 100;
      const igst = (total * igstRate) / 100;
      const gst = cgst + sgst + igst;

      const gross = total + gst;
      const roundedGrand = Math.round(gross);
      const roundedOff = roundedGrand - gross;

      const fmt = (v) => v.toFixed(2);

      drawTextInBox(page, font, fmt(total), fontSize, totalsBoxes.total, "right");
      drawTextInBox(page, font, fmt(cgst), fontSize, totalsBoxes.cgst, "right");
      drawTextInBox(page, font, fmt(sgst), fontSize, totalsBoxes.sgst, "right");
      drawTextInBox(page, font, fmt(igst), fontSize, totalsBoxes.igst, "right");
      drawTextInBox(page, font, fmt(gst), fontSize, totalsBoxes.gst, "right");
      drawTextInBox(page, font, fmt(roundedOff), fontSize, totalsBoxes.roundedOff, "right");
      drawTextInBox(page, font, fmt(roundedGrand), fontSize, totalsBoxes.grandTotal, "right");

      const pdfBytes = await pdfDoc.save();

      // Email configuration validation
      if (!process.env.BREVO_API_KEY) {
        return res.status(500).json({
          error: "Brevo API Key configuration not set. Please configure BREVO_API_KEY in .env file"
        });
      }

      const senderEmail = process.env.SENDER_EMAIL || "srichakritraderstup@gmail.com";

      const apiInstance = new TransactionalEmailsApi();
      apiInstance.authentications['apiKey'].apiKey = process.env.BREVO_API_KEY;

      const sendSmtpEmail = new SendSmtpEmail();
      sendSmtpEmail.subject = `Invoice/Challan: ${payload.poNumber}`;
      sendSmtpEmail.htmlContent = `<html><body><p>Please find attached the document for PO #${payload.poNumber}.</p></body></html>`;
      sendSmtpEmail.sender = { name: "Sri Chakri Traders", email: senderEmail };
      sendSmtpEmail.to = [{ email: payload.toEmail }];
      sendSmtpEmail.textContent = `Please find attached the document for PO #${payload.poNumber}.`;
      sendSmtpEmail.attachment = [
        {
          content: Buffer.from(pdfBytes).toString("base64"),
          name: `invoice-${payload.poNumber}.pdf`
        }
      ];

      try {
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Brevo SDK Success. Returned data: ' + JSON.stringify(data));
        res.json({ ok: true });
      } catch (error) {
        console.error('Brevo SDK Error:', error.body || error);
        res.status(500).json({ error: error.body ? JSON.stringify(error.body) : error.message });
      }
    } catch (err) {
      console.error(err);
      const message =
        (err && err.message) || "Failed to generate or email PDF";
      res.status(500).json({ error: message });
    }
  }
);

const PORT = process.env.PORT || 4000;

// Check email configuration on startup
// Check email configuration on startup
if (!process.env.BREVO_API_KEY) {
  console.warn("⚠️  Brevo API configuration not set. Email functionality will not work.");
  console.warn("   Please create a .env file with BREVO_API_KEY");
} else {
  console.log("✓ Brevo API configuration found");
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});