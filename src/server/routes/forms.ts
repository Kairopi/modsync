import { Hono } from 'hono';

export const forms = new Hono();

// POST /internal/form/soft-warning-submit — full implementation in task 4.2b
forms.post('/soft-warning-submit', (c) => c.json({ ok: true }));

// POST /internal/form/combo-picker-submit — full implementation in task 8.3b
forms.post('/combo-picker-submit', (c) => c.json({ ok: true }));

// POST /internal/form/combo-editor-submit — full implementation in task 8.5
forms.post('/combo-editor-submit', (c) => c.json({ ok: true }));
