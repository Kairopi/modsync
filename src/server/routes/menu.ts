import { Hono } from 'hono';

export const menu = new Hono();

// POST /internal/menu/claim — full implementation in task 4.2
menu.post('/claim', (c) => c.json({ ok: true }));

// POST /internal/menu/combo-picker — full implementation in task 8.3a
menu.post('/combo-picker', (c) => c.json({ ok: true }));
