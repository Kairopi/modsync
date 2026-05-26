/**
 * ComboConfig tab — task 8.5.
 *
 * Architecture (matches tasks 6.4 / 7.3):
 *   - Pure presentation. The parent (`App.tsx`) owns the combos list
 *     and threads it down via the `combos` prop.
 *   - CRUD mutations call `saveCombo` / `deleteCombo` from
 *     `src/client/api`. After a successful mutation the component fires
 *     the optional `onChange` callback so the parent can refetch.
 *
 * Form behavior:
 *   - "Add combo" toggles a step-editor form below the list.
 *   - Name input validates client-side against `COMBO_NAME_REGEX`.
 *   - Steps render as a list; "Add step" appends a fresh step. Per-step
 *     fields render based on the chosen `StepKind`:
 *       BAN     — days (0-999) + reason
 *       MODNOTE — text (≤1000 chars) + optional label dropdown
 *       REMOVE / LOCK / APPROVE — no fields
 *   - "Save" calls `saveCombo`. On success: clear form + fire `onChange`.
 *     On 400: display the validator's message inline.
 *   - "Cancel" closes the form without saving.
 *
 * Delete flow:
 *   - Each list row has a delete button. Confirms via `window.confirm`,
 *     then calls `deleteCombo(name)` and fires `onChange`.
 *
 * Client-side validation mirrors the server's rules
 * (`src/server/combos.ts`) but the server is the authority. The client
 * surfaces server-returned errors verbatim.
 */
import { useState } from 'react';
import { deleteCombo, saveCombo } from '../api';
import {
  COMBO_NAME_REGEX,
  type ComboSpec,
  type ComboStep,
  type StepKind,
} from '../types';

const STEP_KINDS: readonly StepKind[] = [
  'REMOVE',
  'LOCK',
  'APPROVE',
  'BAN',
  'MODNOTE',
] as const;

const MODNOTE_LABELS = [
  'ABUSE_WARNING',
  'SPAM_WARNING',
  'HELPFUL_USER',
  'OTHER',
] as const;
type ModNoteLabel = (typeof MODNOTE_LABELS)[number];

const MIN_STEPS = 1;
const MAX_STEPS = 10;
const MAX_MODNOTE_TEXT_LEN = 1000;
const MIN_BAN_DAYS = 0;
const MAX_BAN_DAYS = 999;

/**
 * Form-time step draft. Holds every possible field as a string (or
 * empty) so unrelated kinds don't lose their values when the user
 * toggles the kind dropdown back and forth. We only project the
 * relevant fields into a `ComboStep` at save time.
 */
interface StepDraft {
  kind: StepKind;
  /** BAN.days, captured as text so the input mirrors what the user typed. */
  days: string;
  /** BAN.reason. */
  reason: string;
  /** MODNOTE.text. */
  text: string;
  /** MODNOTE.label, empty string means "no label". */
  label: string;
}

function makeBlankStep(): StepDraft {
  return { kind: 'REMOVE', days: '', reason: '', text: '', label: '' };
}

export interface ComboConfigProps {
  /**
   * Parent-owned combos list. `undefined` means the parent's initial
   * fetch is still in-flight; render a loading state.
   */
  combos?: ComboSpec[];
  /**
   * Called after a successful save or delete so the parent can refetch.
   * No-op by default.
   */
  onChange?: () => void;
}

const EMPTY_COPY = 'No combos yet. Add your first combo to get started.';

/**
 * Project a draft step into a `ComboStep`. Returns `null` if the draft
 * is structurally invalid for its kind (caller surfaces a client-side
 * error). The server re-validates regardless.
 */
function projectStep(draft: StepDraft): ComboStep | { error: string } {
  switch (draft.kind) {
    case 'REMOVE':
      return { kind: 'REMOVE' };
    case 'LOCK':
      return { kind: 'LOCK' };
    case 'APPROVE':
      return { kind: 'APPROVE' };
    case 'BAN': {
      const days = Number.parseInt(draft.days, 10);
      if (!Number.isFinite(days) || !Number.isInteger(days)) {
        return { error: 'BAN: days must be an integer' };
      }
      if (days < MIN_BAN_DAYS || days > MAX_BAN_DAYS) {
        return {
          error: `BAN: days must be in [${MIN_BAN_DAYS}, ${MAX_BAN_DAYS}]`,
        };
      }
      return { kind: 'BAN', days, reason: draft.reason };
    }
    case 'MODNOTE': {
      if (draft.text.length > MAX_MODNOTE_TEXT_LEN) {
        return {
          error: `MODNOTE: text exceeds ${MAX_MODNOTE_TEXT_LEN} chars`,
        };
      }
      // `exactOptionalPropertyTypes: true` — only attach `label` when
      // the user picked one.
      if (draft.label === '') {
        return { kind: 'MODNOTE', text: draft.text };
      }
      return {
        kind: 'MODNOTE',
        text: draft.text,
        label: draft.label as ModNoteLabel,
      };
    }
    default:
      return { error: `Unknown step kind: ${String(draft.kind)}` };
  }
}

export function ComboConfig({ combos, onChange }: ComboConfigProps = {}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<StepDraft[]>([makeBlankStep()]);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  if (combos === undefined) {
    return <div>Loading…</div>;
  }

  function resetForm() {
    setEditing(false);
    setName('');
    setDrafts([makeBlankStep()]);
    setFormError(undefined);
    setSaving(false);
  }

  async function handleDelete(comboName: string) {
    // eslint-disable-next-line no-undef
    const ok = window.confirm(`Delete combo "${comboName}"?`);
    if (!ok) return;
    try {
      await deleteCombo(comboName);
      onChange?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(`Delete failed: ${msg}`);
    }
  }

  function setDraftField<K extends keyof StepDraft>(
    index: number,
    key: K,
    value: StepDraft[K],
  ) {
    setDrafts((prev) => {
      const next = prev.slice();
      const cur = next[index];
      if (!cur) return prev;
      next[index] = { ...cur, [key]: value };
      return next;
    });
  }

  function addStep() {
    setDrafts((prev) => {
      if (prev.length >= MAX_STEPS) return prev;
      return [...prev, makeBlankStep()];
    });
  }

  function removeStep(index: number) {
    setDrafts((prev) => {
      if (prev.length <= MIN_STEPS) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }

  async function handleSave() {
    setFormError(undefined);

    // Client-side preflight — the server is still the authority.
    if (!COMBO_NAME_REGEX.test(name)) {
      setFormError(
        'Name must be 1-40 chars from [a-z0-9-_ ] (case-insensitive)',
      );
      return;
    }
    if (drafts.length < MIN_STEPS || drafts.length > MAX_STEPS) {
      setFormError(`Combo must have ${MIN_STEPS}-${MAX_STEPS} steps`);
      return;
    }

    const steps: ComboStep[] = [];
    for (const draft of drafts) {
      const result = projectStep(draft);
      if ('error' in result) {
        setFormError(result.error);
        return;
      }
      steps.push(result);
    }

    const spec: ComboSpec = { name, steps };

    setSaving(true);
    try {
      await saveCombo(spec);
      resetForm();
      onChange?.();
    } catch (err) {
      // Server error message comes through `request<T>` in api.ts as
      // `Error("POST /api/combos failed: 400 — { \"error\": \"...\" }")`.
      // Surface it verbatim — the user can see the validator's reason.
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const isEmpty = combos.length === 0;

  return (
    <div>
      {isEmpty ? (
        <p data-testid="combos-empty">{EMPTY_COPY}</p>
      ) : (
        <ul aria-label="Combos">
          {combos.map((combo) => (
            <li key={combo.name} data-testid={`combo-row-${combo.name}`}>
              <span>{combo.name}</span>
              <button
                type="button"
                onClick={() => {
                  void handleDelete(combo.name);
                }}
                aria-label={`Delete combo ${combo.name}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {!editing ? (
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setFormError(undefined);
          }}
        >
          Add combo
        </button>
      ) : (
        <div role="group" aria-label="Combo editor">
          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Combo name"
            />
          </label>

          <ol aria-label="Steps">
            {drafts.map((draft, index) => (
              <li key={index}>
                <label>
                  Kind
                  <select
                    value={draft.kind}
                    onChange={(e) =>
                      setDraftField(index, 'kind', e.target.value as StepKind)
                    }
                    aria-label={`Step ${index + 1} kind`}
                  >
                    {STEP_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>

                {draft.kind === 'BAN' ? (
                  <>
                    <label>
                      Days
                      <input
                        type="number"
                        min={MIN_BAN_DAYS}
                        max={MAX_BAN_DAYS}
                        value={draft.days}
                        onChange={(e) =>
                          setDraftField(index, 'days', e.target.value)
                        }
                        aria-label={`Step ${index + 1} BAN days`}
                      />
                    </label>
                    <label>
                      Reason
                      <input
                        type="text"
                        value={draft.reason}
                        onChange={(e) =>
                          setDraftField(index, 'reason', e.target.value)
                        }
                        aria-label={`Step ${index + 1} BAN reason`}
                      />
                    </label>
                  </>
                ) : null}

                {draft.kind === 'MODNOTE' ? (
                  <>
                    <label>
                      Text
                      <textarea
                        maxLength={MAX_MODNOTE_TEXT_LEN}
                        value={draft.text}
                        onChange={(e) =>
                          setDraftField(index, 'text', e.target.value)
                        }
                        aria-label={`Step ${index + 1} MODNOTE text`}
                      />
                    </label>
                    <label>
                      Label
                      <select
                        value={draft.label}
                        onChange={(e) =>
                          setDraftField(index, 'label', e.target.value)
                        }
                        aria-label={`Step ${index + 1} MODNOTE label`}
                      >
                        <option value="">(none)</option>
                        {MODNOTE_LABELS.map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}

                {drafts.length > MIN_STEPS ? (
                  <button
                    type="button"
                    onClick={() => removeStep(index)}
                    aria-label={`Remove step ${index + 1}`}
                  >
                    Remove step
                  </button>
                ) : null}
              </li>
            ))}
          </ol>

          {drafts.length < MAX_STEPS ? (
            <button type="button" onClick={addStep}>
              Add step
            </button>
          ) : null}

          {formError !== undefined ? (
            <div role="alert" data-testid="combo-form-error">
              {formError}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={saving}
          >
            Save
          </button>
          <button type="button" onClick={resetForm} disabled={saving}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
