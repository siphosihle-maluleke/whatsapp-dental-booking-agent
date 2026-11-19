import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import express from 'express';
import fs from 'fs';
import axios from 'axios';
import OpenAI from 'openai';
import 'dotenv/config';

const openai = new OpenAI({
    baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY
});

const systemPrompt = fs.readFileSync('./config/system_prompt.txt', 'utf8');
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const INTERNAL_WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '27';

const memory = new Map();
const recentMessages = new Map();
let activeSock = null;

// --- INTERNAL N8N OUTBOUND SENDER (PORT 3001) ---
const app = express();
app.use(express.json());

app.post('/send-message', async (req, res) => {
    const { phone, message, secret } = req.body;
    if (!INTERNAL_WEBHOOK_SECRET || secret !== INTERNAL_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!activeSock) {
        return res.status(503).json({ error: 'WhatsApp socket not connected yet' });
    }
    try {
        const cleanPhone = phone.replace(/\D/g, '').replace(/^0/, DEFAULT_COUNTRY_CODE);
        const jid = `${cleanPhone}@s.whatsapp.net`;
        await activeSock.sendMessage(jid, { text: message });
        console.log(`📤 n8n Automated Message sent to ${jid}`);
        res.json({ status: 'sent', jid });
    } catch (err) {
        console.error('❌ Outbound Send Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🔌 Internal n8n sender listening on port ${PORT}`));

const bookingTool = {
    type: "function",
    function: {
        name: "book_onboarding",
        description: "Trigger this to book a discovery or onboarding call.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string" },
                phone: { type: "string" },
                tier: { type: "string", description: "The tier they want, or 'Undecided' if just browsing." },
                start_time: { type: "string", description: "ISO 8601 format (e.g., 2026-11-17T10:00:00Z)" },
                platform: { type: "string", enum: ["Zoom", "WhatsApp"], description: "Preferred meeting method" }
            },
            required: ["name", "phone", "tier", "start_time", "platform"]
        }
    }
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./data/whatsapp_auth');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ["Clinic Assistant AI", "Chrome", "1.0.0"],
    });

    activeSock = sock;

    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'close') connectToWhatsApp();
        if (update.connection === 'open') console.log('✅ WhatsApp Bot LIVE with Outbound Memory Sync & n8n Sender!');
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        if (sender.endsWith('@g.us') || sender === 'status@broadcast') return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // --- LOG OPERATOR MANUAL OUTREACH INTO AI MEMORY ---
        if (msg.key.fromMe) {
            if (!memory.has(sender)) {
                memory.set(sender, [{ role: 'system', content: systemPrompt }]);
            }
            const history = memory.get(sender);
            const lastMsg = history[history.length - 1];
            if (!lastMsg || lastMsg.content !== text) {
                history.push({ role: 'assistant', content: text });
                console.log(`📝 Logged operator outreach to ${sender}`);
            }
            return;
        }

        // --- AUTO-RESPONDER LOOP PROTECTION ---
        const lowerText = text.toLowerCase();
        const autoResponderPhrases = [
            "thank you for contacting",
            "thank you for reaching out",
            "welcome to",
            "out of office",
            "we have received your message",
            "automated response",
            "auto-reply",
            "after hours",
            "operating hours",
            "please reply with",
            "this chat is not monitored",
            "for emergencies",
            "emergency care"
        ];

        const hasMenuNumbers = /1\s*[\.\)\]]\s*[A-Za-z]|1️⃣/.test(text);

        if (autoResponderPhrases.some(phrase => lowerText.includes(phrase)) || hasMenuNumbers) {
            console.log(`🛡️ Loop blocked: Ignored auto-responder from ${sender}`);
            return;
        }

        const now = Date.now();
        if (recentMessages.has(sender) && now - recentMessages.get(sender) < 3000) return;
        recentMessages.set(sender, now);

        console.log(`📩 Received: ${text}`);
        await sock.sendPresenceUpdate('composing', sender);

        if (!memory.has(sender)) {
            memory.set(sender, [{ role: 'system', content: systemPrompt }]);
        }

        let chatHistory = memory.get(sender);
        chatHistory.push({ role: 'user', content: text });

        if (chatHistory.length > 21) {
            chatHistory = [chatHistory[0], ...chatHistory.slice(-20)];
            memory.set(sender, chatHistory);
        }

        try {
            const response = await openai.chat.completions.create({
                model: process.env.LLM_MODEL || "deepseek-chat",
                temperature: 0.4,
                max_tokens: 150,
                messages: chatHistory,
                tools: [bookingTool],
                tool_choice: "auto"
            });

            const aiMessage = response.choices[0].message;
            chatHistory.push(aiMessage);

            await new Promise(resolve => setTimeout(resolve, 2000));

            if (aiMessage.tool_calls) {
                for (const toolCall of aiMessage.tool_calls) {
                    if (toolCall.function.name === 'book_onboarding') {
                        const payload = JSON.parse(toolCall.function.arguments);
                        await axios.post(N8N_WEBHOOK_URL, payload);

                        chatHistory.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: "Webhook sent successfully. Confirm the booking platform and time with the user."
                        });

                        const confirmResponse = await openai.chat.completions.create({
                            model: process.env.LLM_MODEL || "deepseek-chat",
                            temperature: 0.4,
                            max_tokens: 150,
                            messages: chatHistory
                        });

                        const finalReply = confirmResponse.choices[0].message.content;
                        await sock.sendMessage(sender, { text: finalReply });
                        chatHistory.push({ role: 'assistant', content: finalReply });
                    }
                }
            } else if (aiMessage.content) {
                await sock.sendMessage(sender, { text: aiMessage.content });
            }

            await sock.sendPresenceUpdate('paused', sender);

        } catch (error) {
            console.error("❌ LLM API Error:", error.message);
            await sock.sendPresenceUpdate('paused', sender);
        }
    });
}

connectToWhatsApp();