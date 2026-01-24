import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
import qrcode from "qrcode";
import mongoose from "mongoose";
import { Invoice } from "./models/Invoice.js";

dotenv.config();

const app = express();
import fs from "fs";
const logError = (msg) => {
  try { fs.appendFileSync("server_error.log", new Date().toISOString() + ": " + msg + "\n"); } catch (e) { }
};

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Connect to MongoDB
const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.warn("⚠️ MONGO_URI not found in .env file. Database connection skipped.");
      return;
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
};
connectDB();

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
  rowHeight: 18,
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

// Helper for currency conversion
function numberToWords(n) {
  if (n < 0) return "Minus " + numberToWords(-n);
  if (n === 0) return "Zero";

  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function inWords(num) {
    if ((num = num.toString()).length > 9) return "overflow";
    const n = ('000000000' + num).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return "";
    let str = "";
    str += (n[1] != 0) ? (a[Number(n[1])] || b[n[1][0]] + ' ' + a[n[1][1]]) + ' Crore ' : '';
    str += (n[2] != 0) ? (a[Number(n[2])] || b[n[2][0]] + ' ' + a[n[2][1]]) + ' Lakh ' : '';
    str += (n[3] != 0) ? (a[Number(n[3])] || b[n[3][0]] + ' ' + a[n[3][1]]) + ' Thousand ' : '';
    str += (n[4] != 0) ? (a[Number(n[4])] || b[n[4][0]] + ' ' + a[n[4][1]]) + ' Hundred ' : '';
    str += (n[5] != 0) ? ((str != '') ? '' : '') + (a[Number(n[5])] || b[n[5][0]] + ' ' + a[n[5][1]]) : '';
    return str;
  }

  return inWords(n) + " Rupees Only";
}


// Generate PDF from scratch matching SRI CHAKRI TRADERS format
async function generateProformaInvoice(payload) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const fontSize = 10;
  const smallFontSize = 8;
  const headerFontSize = 20;

  // Add a professional border around the entire document
  page.drawRectangle({
    x: 10,
    y: 10,
    width: width - 20,
    height: height - 10 - 50, // Leave space for footer
    borderColor: rgb(0.5, 0.5, 0.5),
    borderWidth: 1,
  });

  // Professional Premium Corporate Theme
  const headerHeight = 130;
  const blueColor = rgb(0, 0.2, 0.4); // Deep Navy Blue (#003366)
  const lightBlueColor = rgb(0.95, 0.96, 0.98); // Very light blue/gray
  const whiteColor = rgb(1, 1, 1);
  const darkBlueColor = rgb(0, 0.1, 0.2); // Almost black
  const logoBox = {
    x: 30,
    y: height - headerHeight + 25,
    width: 80,
    height: 80,
  };

  async function drawQrCodeIfPresent() {
    let qrBytes;
    let qrExt = 'png';

    const logDebug = (msg) => {
      try { fs.appendFileSync("qr_debug.log", new Date().toISOString() + ": " + msg + "\n"); } catch (e) { }
    };

    logDebug("Starting drawQrCodeIfPresent");

    // Check for custom QR code image first
    try {
      const assetPath = "assets/qrcode.png";
      if (fs.existsSync(assetPath)) {
        qrBytes = fs.readFileSync(assetPath);
        qrExt = 'png';
        logDebug("Using custom QR code from assets/qrcode.png");
      }
    } catch (e) {
      console.error("Failed to load custom QR code", e);
      logDebug("Exception loading custom QR: " + e.message);
    }

    if (!qrBytes && payload.qrCodeDataUrl) {
      logDebug("Payload has qrCodeDataUrl");
      const match = String(payload.qrCodeDataUrl).match(
        /^data:image\/(png|jpeg|jpg);base64,(.+)$/i
      );
      if (match) {
        qrExt = match[1];
        qrBytes = Uint8Array.from(Buffer.from(match[2], "base64"));
        logDebug("Parsed QR code from payload");
      } else {
        logDebug("Failed to parse qrCodeDataUrl pattern");
      }
    } else if (!qrBytes) {
      logDebug("Payload does NOT have qrCodeDataUrl");
    }

    // Generate QR code if no custom image
    if (!qrBytes) {
      try {
        const total = payload.items ? payload.items.reduce((sum, item) => sum + (parseFloat(item.rate || '0') * parseFloat(item.quantity || '0')), 0) : 0;
        const upiData = `upi://pay?pa=merchant@upi&pn=SRI CHAKRI TRADERS&am=${total.toFixed(2)}&cu=INR&tn=Invoice ${payload.poNumber || ''}`;
        const qrDataUrl = await qrcode.toDataURL(upiData, { type: 'image/png', errorCorrectionLevel: 'M' });
        const match = qrDataUrl.match(/^data:image\/png;base64,(.+)$/);
        if (match) {
          qrBytes = Uint8Array.from(Buffer.from(match[1], "base64"));
          qrExt = 'png';
          logDebug("Generated UPI QR code for payment");
        }
      } catch (e) {
        console.error("Failed to generate QR code", e);
        logDebug("Exception generating QR: " + e.message);
      }
    }

    if (!qrBytes) {
      console.log("No QR bytes to draw.");
      logDebug("No QR bytes found. Aborting.");
      return;
    }

    try {
      let img;
      if (qrExt.toLowerCase() === "png") {
        img = await pdfDoc.embedPng(qrBytes);
      } else {
        img = await pdfDoc.embedJpg(qrBytes);
      }

      // Position QR code near signature (bottom right area)
      const qrBoxSize = 120;
      const qrX = width - 200 - qrBoxSize - 20; // Left of signature
      // Align bottom of QR with bottom of signature text approx
      const qrY = 70; // Just above pink footer

      const { width: iw, height: ih } = img.scaleToFit(qrBoxSize, qrBoxSize);
      page.drawImage(img, { x: qrX, y: qrY, width: iw, height: ih });
      logDebug("Drew QR code image");

      page.drawText("Scan & Pay", {
        x: qrX + (iw / 2) - 25,
        y: qrY - 10,
        size: 8,
        font: boldFont,
        color: rgb(0, 0, 0)
      });
      logDebug("Drew Scan & Pay text");

    } catch (e) {
      console.error("Error drawing QR code:", e);
      logDebug("Error drawing QR code: " + e.message);
    }
  }

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

  // Header Band
  page.drawRectangle({
    x: 0,
    y: height - headerHeight,
    width: width,
    height: headerHeight,
    color: blueColor,
  });

  // Logo Container (White Box)
  page.drawRectangle({
    x: logoBox.x - 5,
    y: logoBox.y - 5,
    width: logoBox.width + 10,
    height: logoBox.height + 10,
    color: whiteColor,
  });
  await drawLogoIfPresent();

  // Company Name
  const textLeft = logoBox.x + logoBox.width + 30;
  const companyName = "SRI CHAKRI TRADERS";
  page.drawText(companyName, {
    x: textLeft,
    y: height - 50,
    size: 24, // Larger and bolder
    font: boldFont,
    color: whiteColor,
  });

  // Address Details (Lighter text for hierarchy)
  let addrY = height - 75;
  const addrColor = rgb(0.9, 0.9, 0.9);

  const address = "222, C1, P.K.M.R. Nagar, Dharapuram Road, Tirupur-641 604";
  page.drawText(address, { x: textLeft, y: addrY, size: 9, font: font, color: addrColor });

  addrY -= 14;
  const mobile = "Mobile no: 8072202136, 9976951369";
  page.drawText(mobile, { x: textLeft, y: addrY, size: 9, font: font, color: addrColor });

  addrY -= 14;
  const email = "srichakritraderstup@gmail.com";
  page.drawText(email, { x: textLeft, y: addrY, size: 9, font: font, color: addrColor });

  // GST (Top Right)
  const gstText = "GST No.: 33DMSPD3047K1ZV";
  page.drawText(gstText, {
    x: width - 30 - boldFont.widthOfTextAtSize(gstText, 10),
    y: height - 30,
    size: 10,
    font: boldFont,
    color: whiteColor,
  });

  // "PROFORMA INVOICE" Badge
  const invoiceBoxY = height - headerHeight + 15;
  const invoiceBoxHeight = 25;
  const titleText = "PROFORMA INVOICE";
  const titleWidth = boldFont.widthOfTextAtSize(titleText, 12);

  page.drawRectangle({
    x: width - 160,
    y: invoiceBoxY,
    width: 140,
    height: invoiceBoxHeight,
    borderColor: whiteColor,
    borderWidth: 1,
    color: blueColor, // Transparent/Blue
  });
  page.drawText(titleText, {
    x: width - 160 + (140 - titleWidth) / 2,
    y: invoiceBoxY + 7,
    size: 12,
    font: boldFont,
    color: whiteColor,
  });

  currentY = height - headerHeight - 40;

  // Left Column: Receiver
  page.drawText("Bill To:", { x: 40, y: currentY, size: 10, font: boldFont, color: blueColor });
  currentY -= 15;
  page.drawText(payload.receiverName || "", { x: 40, y: currentY, size: 11, font: boldFont });
  currentY -= 15;
  // Multiline address
  const addrBox = { x: 40, y: currentY - 35, width: 250, height: 40, lineHeight: 12, maxLines: 3 };
  drawMultilineBox(page, font, payload.receiverAddress || "", 9, addrBox);

  // Right Column: Invoice Details
  const rightColX = 350;
  let infoY = height - headerHeight - 40;

  let piDate = payload.piDate || payload.poDate || new Date().toISOString().split('T')[0];
  if (piDate.includes('-')) {
    const [year, month, day] = piDate.split('-');
    piDate = `${day}.${month}.${year}`;
  }

  const drawLabelVal = (label, val, y) => {
    page.drawText(label, { x: rightColX, y: y, size: 9, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(val, { x: rightColX + 80, y: y, size: 9, font: font });
  };

  drawLabelVal("PO No:", payload.poNumber || "-", infoY);
  infoY -= 18;
  drawLabelVal("Date:", piDate, infoY);
  infoY -= 18;
  drawLabelVal("Order By:", payload.orderBy || "VOLTA FASHIONS", infoY);
  infoY -= 18;
  drawLabelVal("Transport:", payload.transportMode || "-", infoY);
  infoY -= 18;
  drawLabelVal("Destination:", payload.destination || "-", infoY);

  currentY = infoY - 30; // Gap before table

  // TABLE
  const tableStartX = 30;
  const tableEndX = width - 30;
  const tableWidth = tableEndX - tableStartX;
  const colWidths = { sNo: 35, particulars: 200, hsn: 60, dcNo: 60, rate: 65, qty: 50, amount: 70 };
  const totalColWidth = Object.values(colWidths).reduce((a, b) => a + b, 0);
  const colWidthsAdjusted = {};
  Object.keys(colWidths).forEach((key) => {
    colWidthsAdjusted[key] = (colWidths[key] / totalColWidth) * tableWidth;
  });

  const tableHeaderHeight = 25;

  // Header Background - Navy
  page.drawRectangle({
    x: tableStartX,
    y: currentY - tableHeaderHeight,
    width: tableWidth,
    height: tableHeaderHeight,
    color: blueColor,
  });

  // Header Text
  let headerX = tableStartX;
  headers.forEach((header, idx) => {
    const colWidth = Object.values(colWidthsAdjusted)[idx];
    const align = (idx === 4 || idx === 6) ? "right" : (idx === 0 ? "center" : "left");

    const textW = boldFont.widthOfTextAtSize(header, 9);
    let tx = headerX + 5;
    if (align === "center") tx = headerX + (colWidth - textW) / 2;
    if (align === "right") tx = headerX + colWidth - textW - 5;

    page.drawText(header, { x: tx, y: currentY - 17, size: 9, font: boldFont, color: whiteColor });
    headerX += colWidth;
  });

  currentY -= tableHeaderHeight;

  // Rows logic
  const items = Array.isArray(payload.items) ? payload.items : [];
  let total = 0;
  const rowH = 22;

  // Loop 12 rows
  for (let i = 0; i < 12; i++) {
    if (currentY < 100) break;

    const item = items[i] || {};
    const isAlt = i % 2 !== 0; // Alternating

    if (isAlt) {
      page.drawRectangle({
        x: tableStartX,
        y: currentY - rowH,
        width: tableWidth,
        height: rowH,
        color: lightBlueColor
      });
    }

    if (items[i]) {
      const rate = Number(item.rate) || 0;
      const qty = Number(item.quantity) || 0;
      const amount = rate * qty;
      total += amount;

      const rowData = [
        String(i + 1),
        item.particulars || "",
        item.hsn || "",
        item.dcNo || "",
        rate > 0 ? rate.toFixed(2) : "",
        qty > 0 ? qty.toString() : "",
        amount > 0 ? amount.toFixed(2) : "",
      ];

      let cx = tableStartX;
      rowData.forEach((txt, idx) => {
        const cw = Object.values(colWidthsAdjusted)[idx];
        const align = (idx === 4 || idx === 6) ? "right" : (idx === 0 || idx === 5 ? "center" : "left");

        const tw = font.widthOfTextAtSize(txt, 9);
        let tx = cx + 5;
        if (align === "center") tx = cx + (cw - tw) / 2;
        if (align === "right") tx = cx + cw - tw - 5;

        const textColor = rgb(0.2, 0.2, 0.2);
        const clipped = clipTextToWidth(txt, font, 9, cw - 8);
        page.drawText(clipped || "", { x: tx, y: currentY - 15, size: 9, font: font, color: textColor });
        cx += cw;
      });
    }

    // Bottom border for row
    page.drawLine({
      start: { x: tableStartX, y: currentY - rowH },
      end: { x: tableEndX, y: currentY - rowH },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85)
    });

    currentY -= rowH;
  }

  // Outer Border for Table Body
  const tableBodyHeight = 12 * rowH;
  page.drawRectangle({
    x: tableStartX,
    y: currentY,
    width: tableWidth,
    height: tableBodyHeight,
    borderColor: blueColor,
    borderWidth: 1,
  });

  // Vertical lines (light)
  let vx = tableStartX;
  Object.values(colWidthsAdjusted).forEach((cw, k) => {
    if (k > 0) {
      page.drawLine({
        start: { x: vx, y: currentY + tableBodyHeight },
        end: { x: vx, y: currentY },
        thickness: 0.5,
        color: rgb(0.9, 0.9, 0.9)
      });
    }
    vx += cw;
  });

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
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
  });

  // Decorative header for Rupees box
  page.drawRectangle({
    x: rupeesFieldX,
    y: rupeesFieldY - 25,
    width: rupeesFieldWidth,
    height: 25,
    color: rgb(0.9, 0.9, 0.9), // Slightly darker gray for header
  });

  const rupeesLabel = "Amount Chargeable (in words):";
  page.drawText(rupeesLabel, { x: rupeesFieldX + 5, y: rupeesFieldY - 17, size: smallFontSize, font: boldFont });

  const rupeesText = numberToWords(roundedGrand);

  // Use italic font if available, else standard font
  const wordFont = (typeof italicFont !== 'undefined') ? italicFont : font;

  drawMultilineBox(page, wordFont, rupeesText, smallFontSize, {
    x: rupeesFieldX + 5,
    y: rupeesFieldY - 80, // Bottom of the box area
    width: rupeesFieldWidth - 10,
    height: 50, // Available height in the white part
    lineHeight: 12,
    maxLines: 4
  });


  // Footer terms - left side
  // Increase spacing from current Y to footer terms
  // currentY was calculated earlier, but let's reset it relative to the lowest element (Rupees box or Totals)

  const rupeesBoxBottomY = rupeesFieldY - rupeesFieldHeight;
  const totalsBoxBottomY = totalsStartY - totalsHeight;
  const lowestBoxY = Math.min(rupeesBoxBottomY, totalsBoxBottomY);

  const calculatedFooterY = lowestBoxY - 30; // 30px gap

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
  const footerY = calculatedFooterY;
  const terms = [
    "• Payments are to be made by A/C Payee's cheque or DD payable at Tirupur",
    "• Claims of any nature whatsoever will lapse unless raised in writing",
    "  within 5 days from the date of invoice",
    "• Interest will be charged @ 24% from the date of Invoice.",
    "• Subject to Tirupur Jurisdiction.",
  ];

  // Header for terms
  page.drawText("Terms & Conditions:", {
    x: 50,
    y: footerY + 15, // Slightly above the terms
    size: smallFontSize + 1,
    font: boldFont,
    underline: true
  });

  let footerYPos = footerY;
  const footerTermsWidth = width - 250; // Wrap before hitting the signature block (approx 200px from right)

  terms.forEach((term) => {
    // Manually wrap text
    const words = term.split(" ");
    let line = "";
    const lines = [];
    for (const w of words) {
      const testLine = line + w + " ";
      const metrics = font.widthOfTextAtSize(testLine, smallFontSize);
      if (metrics > footerTermsWidth && line !== "") {
        lines.push(line);
        line = w + " ";
      } else {
        line = testLine;
      }
    }
    lines.push(line);

    lines.forEach((l) => {
      page.drawText(l.trim(), { x: 50, y: footerYPos, size: smallFontSize, font: font });
      footerYPos -= 12; // Line height
    });
    footerYPos -= 3; // Extra space between terms
  });

  // Signature - right side
  page.drawText("For SRI CHAKRI TRADERS,", { x: width - 200, y: footerY, size: smallFontSize, font: font });
  page.drawText("T.J. DURGA", { x: width - 200, y: footerY - 15, size: smallFontSize, font: font });
  page.drawText("Authorised Signatory", { x: width - 200, y: footerY - 30, size: smallFontSize, font: font });

  // Draw QR Code
  await drawQrCodeIfPresent();

  // Professional Navy Footer Band
  const footerHeight = 50;

  page.drawRectangle({
    x: 0,
    y: 0,
    width: width,
    height: footerHeight,
    color: blueColor, // Use the Navy color
  });

  // Note Text - White
  const noteY = 35;
  page.drawText("FOR YOUR KIND ATTENTION:", { x: 30, y: noteY, size: smallFontSize, font: boldFont, color: whiteColor });
  page.drawText("payment must be within 30 days from the despatch day.( Pay by cheque)", { x: 30, y: noteY - 15, size: smallFontSize, font: font, color: whiteColor });
  page.drawText("AFTER RECEIVING THE PI , PLEASE SEND POST DATED CHEQUE", { x: 30, y: noteY - 30, size: smallFontSize, font: font, color: whiteColor });

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

    // Save to MongoDB
    try {
      if (mongoose.connection.readyState === 1) {
        const invoice = new Invoice(payload);
        await invoice.save();
        console.log("Invoice saved to MongoDB:", invoice._id);
      }
    } catch (dbError) {
      console.error("Failed to save invoice to MongoDB:", dbError);
    }

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

    // Save to MongoDB
    try {
      if (mongoose.connection.readyState === 1) {
        const invoice = new Invoice(payload);
        await invoice.save();
        console.log("Invoice saved to MongoDB:", invoice._id);
      }
    } catch (dbError) {
      console.error("Failed to save invoice to MongoDB:", dbError);
    }

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