
import mongoose from "mongoose";

const InvoiceSchema = new mongoose.Schema({
    receiverName: { type: String, default: "" },
    receiverAddress: { type: String, default: "" },
    receiverPhone: { type: String, default: "" },
    receiverEmail: { type: String, default: "" },
    receiverGstin: { type: String, default: "" },

    poNumber: { type: String, default: "" },
    poDate: { type: String, default: "" }, // Format: YYYY-MM-DD usually, but keeping string to match form
    transportMode: { type: String, default: "" },
    deliveryDate: { type: String, default: "" },
    destination: { type: String, default: "" },

    items: [
        {
            particulars: { type: String, default: "" },
            hsn: { type: String, default: "" },
            dcNo: { type: String, default: "" },
            rate: { type: Number, default: 0 },
            quantity: { type: Number, default: 0 }
        }
    ],

    cgstRate: { type: Number, default: 0 },
    sgstRate: { type: Number, default: 0 },
    igstRate: { type: Number, default: 0 },

    toEmail: { type: String, default: "" },
    emailSubject: { type: String, default: "" },
    emailBody: { type: String, default: "" },

    // Storing the logo might take up space, but user asked for "all details"
    logoDataUrl: { type: String, default: null },

    createdAt: { type: Date, default: Date.now }
});

export const Invoice = mongoose.model("Invoice", InvoiceSchema);
