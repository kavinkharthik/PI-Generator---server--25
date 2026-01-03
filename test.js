import fetch from 'node-fetch';
import fs from 'fs';

const payload = {
  receiverName: "Test Receiver",
  receiverPhone: "1234567890",
  poNumber: "PO12345",
  items: [
    {
      particulars: "Test Item",
      hsn: "1234",
      dcNo: "DC001",
      rate: "100.00",
      quantity: "2"
    }
  ]
};

fetch('http://localhost:4000/api/generate-pdf', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
})
.then(res => res.arrayBuffer())
.then(buffer => {
  fs.writeFileSync('test.pdf', Buffer.from(buffer));
  console.log('PDF saved as test.pdf');
})
.catch(err => console.error(err));