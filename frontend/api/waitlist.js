export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { email } = req.body || {};

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email required.' });
    }
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
        return res.status(400).json({ error: 'Invalid email address.' });
    }

    const DISPOSABLE = new Set([
        'mailinator.com','guerrillamail.com','tempmail.com','yopmail.com',
        'throwam.com','trashmail.com','trashmail.io','maildrop.cc','spam4.me',
        'temp-mail.org','dispostable.com','sharklasers.com','grr.la',
    ]);
    if (DISPOSABLE.has(normalized.split('@')[1])) {
        return res.status(400).json({ error: 'Disposable emails not allowed.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Server config error.' });
    }

    const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
    };

    // Duplicate kontrolü
    const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/waitlist?email=eq.${encodeURIComponent(normalized)}&select=id`,
        { headers }
    );
    const existing = await checkRes.json();
    if (existing.length > 0) {
        const countRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?select=count`, { headers });
        const countData = await countRes.json();
        const total = parseInt(countData[0]?.count || 0);
        return res.status(409).json({ error: 'Email already registered.', position: total });
    }

    // Kaydet
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ email: normalized, ip }),
    });

    if (!insertRes.ok) {
        const err = await insertRes.text();
        console.error('Supabase insert error:', err);
        return res.status(500).json({ error: 'Failed to save.' });
    }

    // Toplam sayı (insert sonrası)
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?select=count`, { headers });
    const countData = await countRes.json();
    const total = parseInt(countData[0]?.count || 1);

    return res.status(200).json({ success: true, position: total });
}
