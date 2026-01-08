import express from 'express';
import { getInstanceByApiKey } from './config.js';
import { hasActiveSession, sendMessage } from './whatsapp.js';

function requireAuth(config) {
    return (req, res, next) => {
        const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'] || req.headers['X-Api-Key'];

        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
            return res.status(401).json({ error: 'Missing API key' });
        }

        const instance = getInstanceByApiKey(config, apiKey.trim());

        if (!instance) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        req.instance = instance;
        next();
    };
}

function randomSleep(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function processBulkMessages(phoneNumber, groupedMessages) {
    for (const [to, messages] of Object.entries(groupedMessages)) {
        const combinedMessage = messages.join('\n\n');
        
        try {
            await sendMessage(phoneNumber, to, combinedMessage);
        } catch (error) {
            console.error(`[${phoneNumber}] Bulk send to ${to} failed: ${error.message}`);
        }
        
        await randomSleep(10, 750);
    }
}

export function createApi(config) {
    const app = express();

    app.use(express.json());

    app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    app.post('/send', requireAuth(config), async (req, res) => {
        const { to, message } = req.body;

        if (!to || typeof to !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid "to" field' });
        }

        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid "message" field' });
        }

        const phoneRegex = /^\+\d{10,15}$/;
        if (!phoneRegex.test(to)) {
            return res.status(400).json({ error: 'Invalid phone number format for "to"' });
        }

        if (!hasActiveSession(req.instance.phone_number)) {
            return res.status(503).json({ error: 'WhatsApp session not connected' });
        }

        try {
            await sendMessage(req.instance.phone_number, to, message);

            res.json({
                status: 'sent',
                to,
            });
        } catch (error) {
            console.error(`[${req.instance.phone_number}] Send failed: ${error.message}`);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    app.post('/send/bulk', requireAuth(config), async (req, res) => {
        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing or invalid "messages" array' });
        }

        if (messages.length === 0) {
            return res.status(400).json({ error: 'Messages array cannot be empty' });
        }

        if (messages.length > 1000) {
            return res.status(400).json({ error: 'Maximum 1000 messages per request' });
        }

        const phoneRegex = /^\+\d{10,15}$/;
        const groupedMessages = {};
        const errors = [];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            if (!msg || typeof msg !== 'object') {
                errors.push({ index: i, error: 'Invalid message object' });
                continue;
            }

            if (!msg.to || typeof msg.to !== 'string') {
                errors.push({ index: i, error: 'Missing or invalid "to" field' });
                continue;
            }

            if (!msg.message || typeof msg.message !== 'string') {
                errors.push({ index: i, error: 'Missing or invalid "message" field' });
                continue;
            }

            if (!phoneRegex.test(msg.to)) {
                errors.push({ index: i, error: 'Invalid phone number format' });
                continue;
            }

            if (!groupedMessages[msg.to]) {
                groupedMessages[msg.to] = [];
            }
            groupedMessages[msg.to].push(msg.message);
        }

        if (errors.length > 0 && Object.keys(groupedMessages).length === 0) {
            return res.status(400).json({ error: 'All messages invalid', details: errors });
        }

        if (!hasActiveSession(req.instance.phone_number)) {
            return res.status(503).json({ error: 'WhatsApp session not connected' });
        }

        const recipientCount = Object.keys(groupedMessages).length;
        const messageCount = Object.values(groupedMessages).reduce((sum, arr) => sum + arr.length, 0);

        processBulkMessages(req.instance.phone_number, groupedMessages);

        res.json({
            status: 'scheduled',
            recipients: recipientCount,
            messages: messageCount,
            errors: errors.length > 0 ? errors : undefined,
        });
    });

    app.use((req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    return app;
}
