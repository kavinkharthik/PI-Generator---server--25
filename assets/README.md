# Proforma Invoice Generator - SRI CHAKRI TRADERS

This application generates Proforma Invoices matching the SRI CHAKRI TRADERS format and can send them via email.

## Features

- Generate Proforma Invoice PDFs from scratch matching the SRI CHAKRI TRADERS format
- Send invoices directly via email
- Download PDFs locally
- Professional invoice layout with company branding

## Setup

### 1. Install Dependencies

**Server:**
```bash
cd server
npm install
```

**Client:**
```bash
cd client
npm install
```

### 2. Configure Email Settings

Create a `.env` file in the `server` directory with your email configuration:

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
PORT=4000
```

**For Gmail users:**
- You may need to use an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password
- Enable "Less secure app access" or use 2-factor authentication with an app password

**For other email providers:**
- Outlook: `smtp-mail.outlook.com`, port `587`
- Yahoo: `smtp.mail.yahoo.com`, port `587`
- Custom SMTP: Use your provider's SMTP settings

### 3. Start the Application

**Terminal 1 - Start Server:**
```bash
cd server
npm run dev
```

**Terminal 2 - Start Client:**
```bash
cd client
npm run dev
```

The application will be available at `http://localhost:5173` (or the port shown in the terminal).

## Usage

1. Fill in the invoice details:
   - Receiver information (Name, Address, Phone, Email, GSTIN)
   - Order details (Order By, PO/PI Number, Date, etc.)
   - Line items (Particulars, HSN Code, D.C. No., Rate, Quantity)
   - Tax rates (CGST, SGST, IGST)
   - Email recipient and message

2. Click **"Generate & Email PDF"** to:
   - Generate the Proforma Invoice PDF
   - Send it via email to the specified recipient

3. Or click **"Download PDF"** to save the invoice locally

## Invoice Format

The generated invoice includes:
- Company header with SRI CHAKRI TRADERS branding
- Recipient and order details
- Itemized table with 10 rows
- Tax calculations (CGST, SGST, IGST)
- Terms and conditions
- Payment notice in footer

## Notes

- Make sure the server is running before using the email functionality
- Email configuration must be set in the `.env` file for email sending to work
- The PDF generation works even without email configuration (for download only)



