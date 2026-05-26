// @vitest-environment jsdom
/**
 * Component tests for `src/client/tabs/ComboConfig.tsx` (task 8.5).
 *
 * Architecture: ComboConfig is a pure presentation component. The
 * parent (`App.tsx`) owns the combos list and threads it down via the
 * `combos` prop. CRUD mutations call `saveCombo`/`deleteCombo` from
 * `src/client/api`, which delegate to `fetch`. After a successful
 * mutation the component fires the optional `onChange` callback so
 * the parent can refetch.
 *
 * Validates:
 *   - Render with seeded combos shows the names.
 *   - Empty combos shows the empty-state copy.
 *   - Delete flow calls fetch DELETE and onChange.
 *   - Save flow posts the spec, clears the form, fires onChange.
 *   - Server 400 surfaces the validator error inline.
 *
 * No PBT — UI form contract.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ComboConfig } from '../src/client/tabs/ComboConfig';
import type { ComboSpec } from '../src/shared/types';

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: unknown;
}

function mockFetch(
  responder: (call: FetchCall) => MockResponse,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      let parsedBody: unknown = undefined;
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      const call = { url, method, body: parsedBody };
      calls.push(call);
      const { status, body } = responder(call);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let confirmRestore: (() => void) | undefined;

function stubConfirm(answer: boolean) {
  const original = window.confirm;
  window.confirm = vi.fn(() => answer);
  confirmRestore = () => {
    window.confirm = original;
  };
}

beforeEach(() => {
  confirmRestore = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (confirmRestore) confirmRestore();
});

const SAMPLE_COMBO_A: ComboSpec = {
  name: 'spam-removal',
  steps: [{ kind: 'REMOVE' }, { kind: 'LOCK' }],
};

const SAMPLE_COMBO_B: ComboSpec = {
  name: 'rule-violation',
  steps: [{ kind: 'APPROVE' }],
};

describe('ComboConfig — list rendering', () => {
  test('renders combo names from props', () => {
    render(<ComboConfig combos={[SAMPLE_COMBO_A, SAMPLE_COMBO_B]} />);
    expect(screen.getByText('spam-removal')).toBeDefined();
    expect(screen.getByText('rule-violation')).toBeDefined();
  });

  test('renders empty-state copy when combos prop is an empty array', () => {
    render(<ComboConfig combos={[]} />);
    expect(
      screen.getByText('No combos yet. Add your first combo to get started.'),
    ).toBeDefined();
  });

  test('renders loading state when combos prop is undefined', () => {
    render(<ComboConfig />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });
});

describe('ComboConfig — delete flow', () => {
  test('confirm + DELETE fetch + onChange', async () => {
    stubConfirm(true);
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      body: { ok: true },
    }));
    const onChange = vi.fn();
    try {
      render(
        <ComboConfig combos={[SAMPLE_COMBO_A]} onChange={onChange} />,
      );
      const deleteBtn = screen.getByRole('button', {
        name: /delete combo spam-removal/i,
      });
      fireEvent.click(deleteBtn);

      await waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      expect(calls[0]?.method).toBe('DELETE');
      expect(calls[0]?.url).toBe('/api/combos/spam-removal');
      await waitFor(() => {
        expect(onChange).toHaveBeenCalledTimes(1);
      });
    } finally {
      restore();
    }
  });

  test('cancel via window.confirm short-circuits delete', () => {
    stubConfirm(false);
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      body: { ok: true },
    }));
    const onChange = vi.fn();
    try {
      render(
        <ComboConfig combos={[SAMPLE_COMBO_A]} onChange={onChange} />,
      );
      const deleteBtn = screen.getByRole('button', {
        name: /delete combo spam-removal/i,
      });
      fireEvent.click(deleteBtn);
      expect(calls).toHaveLength(0);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('ComboConfig — add/save flow', () => {
  test('add combo, fill form, save → POST with spec body, onChange fired, form clears', async () => {
    const expectedSpec: ComboSpec = {
      name: 'cleanup',
      steps: [{ kind: 'REMOVE' }],
    };
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      body: expectedSpec,
    }));
    const onChange = vi.fn();
    try {
      render(<ComboConfig combos={[]} onChange={onChange} />);

      // Toggle the editor open.
      fireEvent.click(screen.getByRole('button', { name: 'Add combo' }));

      // Fill the name field.
      fireEvent.change(screen.getByLabelText('Combo name'), {
        target: { value: 'cleanup' },
      });

      // Default first step is REMOVE — leave it. Click Save.
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toBe('/api/combos');
      expect(calls[0]?.body).toEqual(expectedSpec);

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledTimes(1);
      });

      // Form clears: the editor closes (Add combo button visible again).
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Add combo' }),
        ).toBeDefined();
      });
    } finally {
      restore();
    }
  });

  test('cancel closes the form without firing fetch or onChange', () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      body: {},
    }));
    const onChange = vi.fn();
    try {
      render(<ComboConfig combos={[]} onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: 'Add combo' }));
      fireEvent.change(screen.getByLabelText('Combo name'), {
        target: { value: 'will-not-save' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(calls).toHaveLength(0);
      expect(onChange).not.toHaveBeenCalled();
      // Editor closed; "Add combo" trigger is back.
      expect(screen.getByRole('button', { name: 'Add combo' })).toBeDefined();
    } finally {
      restore();
    }
  });

  test('server returns 400 with validator error → message displayed inline', async () => {
    // Use a quote-free message so the JSON-encoded response body
    // (which contains the message verbatim, with `"` escaped as `\"`)
    // still surfaces the substring we assert on.
    const validatorMessage =
      'Combo must have at least 1 step (validator rejected client payload)';
    const { calls, restore } = mockFetch(() => ({
      status: 400,
      body: { error: validatorMessage },
    }));
    const onChange = vi.fn();
    try {
      render(<ComboConfig combos={[]} onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: 'Add combo' }));
      // Use a name that passes the client-side regex but the server
      // pretends to reject. `cleanup` matches `[a-z0-9-_ ]{1,40}` so
      // the request actually reaches `fetch`.
      fireEvent.change(screen.getByLabelText('Combo name'), {
        target: { value: 'cleanup' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      // Error text from the server is surfaced inline.
      await waitFor(() => {
        const alert = screen.getByTestId('combo-form-error');
        expect(alert.textContent ?? '').toContain(validatorMessage);
      });
      // Form stayed open (editor still mounted) and onChange was NOT
      // fired because the server rejected.
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('client-side regex preflight blocks save before any fetch', () => {
    const { calls, restore } = mockFetch(() => ({
      status: 200,
      body: {},
    }));
    const onChange = vi.fn();
    try {
      render(<ComboConfig combos={[]} onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: 'Add combo' }));
      // Name with an illegal `!` character — fails COMBO_NAME_REGEX.
      fireEvent.change(screen.getByLabelText('Combo name'), {
        target: { value: 'bad!name' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      // Inline error appeared, no fetch fired, no onChange.
      const alert = screen.getByTestId('combo-form-error');
      expect(alert.textContent ?? '').toMatch(/[a-z0-9-_ ]/);
      expect(calls).toHaveLength(0);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
