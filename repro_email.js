import { TransactionalEmailsApi, SendSmtpEmail } from "@getbrevo/brevo";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const log = (msg) => {
    fs.appendFileSync("repro_result.txt", msg + "\n");
    console.log(msg);
}

const run = async () => {
    log("Starting Brevo test...");
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
        log("No API key found in .env");
        return;
    }

    log("API Key found (length): " + apiKey.length);

    const apiInstance = new TransactionalEmailsApi();
    apiInstance.authentications['apiKey'].apiKey = apiKey;

    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.subject = "Test Email from Debug Script";
    sendSmtpEmail.htmlContent = "<html><body><h1>This is a test email</h1><p>Checking if Brevo works.</p></body></html>";
    sendSmtpEmail.sender = { name: "Debug Script", email: process.env.SENDER_EMAIL || "test@example.com" };
    sendSmtpEmail.to = [{ email: "kavinkharthik2506@gmail.com" }];

    try {
        log("Sending email...");
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        log('API called successfully. Returned data: ' + JSON.stringify(data));
    } catch (error) {
        log('Error sending email: ' + (error.body ? JSON.stringify(error.body) : error));
    }
};

run();
