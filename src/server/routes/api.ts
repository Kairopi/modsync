import { Hono } from 'hono';

export const api = new Hono();

// GET /api/feed — full implementation in task 7.2
api.get('/feed', (c) => c.json({ ok: true }));

// GET /api/metrics — full implementation in task 5.2
api.get('/metrics', (c) => c.json({ ok: true }));

// GET /api/combos — full implementation in task 8.4
api.get('/combos', (c) => c.json({ ok: true }));

// POST /api/combos — full implementation in task 8.4
api.post('/combos', (c) => c.json({ ok: true }));

// DELETE /api/combos/:name — full implementation in task 8.4
api.delete('/combos/:name', (c) => c.json({ ok: true }));

// GET /api/claims — full implementation later (consumed by client realtime resync)
api.get('/claims', (c) => c.json({ ok: true }));

// POST /api/dev/seed — full implementation in task 10.x
api.post('/dev/seed', (c) => c.json({ ok: true }));
