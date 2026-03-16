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

    const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
    const GITHUB_REPO   = process.env.GITHUB_REPO;
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
    const FILE_PATH     = 'waitlist.json';

    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        return res.status(500).json({ error: 'Server config error.' });
    }

    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const headers = {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'OXO-Waitlist',
    };

    let currentEmails = [];
    let fileSha = null;
    try {
        const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers });
        if (getRes.ok) {
            const fileData = await getRes.json();
            fileSha = fileData.sha;
            const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
            currentEmails = JSON.parse(decoded);
        }
    } catch {}

    const exists = currentEmails.find(e => e.email === normalized);
    if (exists) {
        return res.status(409).json({ error: 'Email already registered.', position: currentEmails.indexOf(exists) + 1 });
    }

    currentEmails.push({ email: normalized, joinedAt: new Date().toISOString() });

    const body = {
        message: `waitlist: ${normalized}`,
        content: Buffer.from(JSON.stringify(currentEmails, null, 2)).toString('base64'),
        branch: GITHUB_BRANCH,
    };
    if (fileSha) body.sha = fileSha;

    const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
    });

    if (!putRes.ok) {
        console.error('GitHub write error:', await putRes.json());
        return res.status(500).json({ error: 'Failed to save.' });
    }

    return res.status(200).json({ success: true, position: currentEmails.length });
}
