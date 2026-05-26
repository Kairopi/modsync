import { Hono } from 'hono';

export const triggers = new Hono();

// POST /internal/trigger/app-install — full implementation in task 9.1
triggers.post('/app-install', (c) => c.json({ ok: true }));

// POST /internal/trigger/post-delete — full implementation in task 9.1
triggers.post('/post-delete', (c) => c.json({ ok: true }));

// POST /internal/trigger/comment-delete — full implementation in task 9.1
triggers.post('/comment-delete', (c) => c.json({ ok: true }));
