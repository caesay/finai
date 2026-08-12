import type {
  Automation,
  AutomationInput,
  AutomationKind,
  RuleCondition,
  RuleField,
  RuleOperator,
} from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  listCategories,
  updateAutomation,
} from '../api/finance.js';
import { AutomationRunDialog } from '../components/AutomationRunDialog.js';
import { PageHeader } from '../components/Shell.js';
import { LoadingLine, Spinner } from '../components/Spinner.js';
import { formatDateTime } from '../lib/money.js';

const FIELDS: RuleField[] = ['description', 'notes', 'amountMinor'];
const OPERATORS: RuleOperator[] = ['contains', 'equals', 'regex', 'gt', 'lt'];

/**
 * Automations react to a transaction being created or imported. They run in
 * order and the first one that changes the transaction wins, so put the
 * cheap deterministic rules above the AI ones.
 */
export function AutomationsPage() {
  const queryClient = useQueryClient();
  const [isAdding, setAdding] = useState(false);
  const [running, setRunning] = useState<Automation | null>(null);

  const automations = useQuery({ queryKey: ['automations'], queryFn: listAutomations });
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['automations'] });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateAutomation(id, { enabled }),
    onSuccess: invalidate,
  });

  const reorder = useMutation({
    mutationFn: ({ id, sortOrder }: { id: string; sortOrder: number }) =>
      updateAutomation(id, { sortOrder }),
    onSuccess: invalidate,
  });

  const remove = useMutation({ mutationFn: deleteAutomation, onSuccess: invalidate });

  const items = automations.data ?? [];

  return (
    <>
      <PageHeader
        title="Automations"
        description="Triggered when a transaction is created or imported. First match wins."
        actions={
          <button type="button" className="button" onClick={() => setAdding((open) => !open)}>
            {isAdding ? 'cancel' : 'new automation'}
          </button>
        }
      />

      {isAdding && (
        <AutomationForm
          categories={categories.data ?? []}
          onDone={async () => {
            setAdding(false);
            await invalidate();
          }}
        />
      )}

      {automations.isError && <p className="error">{automations.error.message}</p>}
      {automations.isPending && <LoadingLine>Loading automations…</LoadingLine>}
      {items.length === 0 && !automations.isPending && (
        <p className="dim">
          No automations yet. Rules are free to run; AI automations cost a turn.
        </p>
      )}

      <ul className="card-list">
        {items.map((automation, index) => (
          <li key={automation.id} className="card">
            <div className="card__main">
              <span className="card__title">
                {automation.name}
                <span className={`chip chip--${automation.kind}`}>{automation.kind}</span>
                {!automation.enabled && <span className="chip chip--off">disabled</span>}
              </span>

              <span className="dim">{describe(automation, categories.data ?? [])}</span>

              <span className="label">
                order {automation.sortOrder}
                {automation.lastRunAt ? ` · last ran ${formatDateTime(automation.lastRunAt)}` : ''}
              </span>
            </div>

            <div className="card__actions">
              {/* Automations normally only see transactions as they arrive;
                  this is the way to apply one to what is already here. */}
              <button type="button" className="button" onClick={() => setRunning(automation)}>
                run on existing
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={index === 0}
                onClick={() => {
                  const previous = items[index - 1];
                  if (previous) {
                    reorder.mutate({ id: automation.id, sortOrder: previous.sortOrder - 1 });
                  }
                }}
              >
                up
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={index === items.length - 1}
                onClick={() => {
                  const next = items[index + 1];
                  if (next) reorder.mutate({ id: automation.id, sortOrder: next.sortOrder + 1 });
                }}
              >
                down
              </button>
              <button
                type="button"
                className="button"
                disabled={toggle.isPending && toggle.variables.id === automation.id}
                onClick={() => toggle.mutate({ id: automation.id, enabled: !automation.enabled })}
              >
                {toggle.isPending && toggle.variables.id === automation.id && (
                  <Spinner label="Saving this automation" />
                )}
                {automation.enabled ? 'disable' : 'enable'}
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={remove.isPending && remove.variables === automation.id}
                onClick={() => {
                  if (confirm(`Delete automation "${automation.name}"?`))
                    remove.mutate(automation.id);
                }}
              >
                {remove.isPending && remove.variables === automation.id && (
                  <Spinner label="Deleting this automation" />
                )}
                delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {running && <AutomationRunDialog automation={running} onClose={() => setRunning(null)} />}
    </>
  );
}

function describe(automation: Automation, categories: { id: string; name: string }[]): string {
  if (automation.kind === 'ai') {
    return automation.ai?.prompt ?? 'No prompt set';
  }

  const target = categories.find((category) => category.id === automation.action.categoryId);
  const conditions = (automation.rule?.conditions ?? [])
    .map((condition) => `${condition.field} ${condition.operator} "${condition.value}"`)
    .join(' and ');

  return `${conditions || 'no conditions'} → ${target?.name ?? 'missing category'}`;
}

function AutomationForm({
  categories,
  onDone,
}: {
  categories: { id: string; name: string }[];
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AutomationKind>('rule');
  const [prompt, setPrompt] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [conditions, setConditions] = useState<RuleCondition[]>([
    { field: 'description', operator: 'contains', value: '' },
  ]);

  const create = useMutation({
    mutationFn: (input: AutomationInput) => createAutomation(input),
    onSuccess: onDone,
  });

  function submit() {
    if (kind === 'rule') {
      create.mutate({
        name,
        kind,
        rule: { conditions },
        action: { type: 'set_category', categoryId },
      });
    } else {
      create.mutate({ name, kind, ai: { prompt }, action: { type: 'set_category' } });
    }
  }

  return (
    <form
      className="panel section form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="form__row">
        <label className="field">
          <span className="label">name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>

        <label className="field field--narrow">
          <span className="label">type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as AutomationKind)}>
            <option value="rule">rule</option>
            <option value="ai">ai</option>
          </select>
        </label>
      </div>

      {kind === 'rule' ? (
        <>
          {conditions.map((condition, index) => (
            <div className="form__row" key={index}>
              <label className="field field--narrow">
                <span className="label">field</span>
                <select
                  value={condition.field}
                  onChange={(event) =>
                    setConditions(
                      replaceAt(conditions, index, {
                        ...condition,
                        field: event.target.value as RuleField,
                      }),
                    )
                  }
                >
                  {FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field field--narrow">
                <span className="label">operator</span>
                <select
                  value={condition.operator}
                  onChange={(event) =>
                    setConditions(
                      replaceAt(conditions, index, {
                        ...condition,
                        operator: event.target.value as RuleOperator,
                      }),
                    )
                  }
                >
                  {OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="label">
                  {condition.operator === 'gt' || condition.operator === 'lt'
                    ? 'amount in minor units'
                    : 'value'}
                </span>
                <input
                  value={condition.value}
                  onChange={(event) =>
                    setConditions(
                      replaceAt(conditions, index, { ...condition, value: event.target.value }),
                    )
                  }
                  required
                />
              </label>

              {conditions.length > 1 && (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setConditions(conditions.filter((_item, at) => at !== index))}
                >
                  remove
                </button>
              )}
            </div>
          ))}

          <div className="form__row">
            <button
              type="button"
              className="button button--ghost"
              onClick={() =>
                setConditions([
                  ...conditions,
                  { field: 'description', operator: 'contains', value: '' },
                ])
              }
            >
              add condition
            </button>

            <label className="field">
              <span className="label">apply category</span>
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                required
              >
                <option value="">choose…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : (
        <label className="field">
          <span className="label">instruction for the assistant</span>
          <textarea
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Anything from a supermarket or corner shop should be Groceries."
            required
          />
          <span className="dim form__hint">
            The assistant picks from the existing categories, one turn per transaction.
          </span>
        </label>
      )}

      <div className="form__actions">
        <button type="submit" className="button" disabled={create.isPending}>
          {create.isPending && <Spinner label="Saving the automation" />}
          {create.isPending ? 'saving' : 'save'}
        </button>
        {create.isError && <span className="error">{create.error.message}</span>}
      </div>
    </form>
  );
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  const next = [...items];
  next[index] = value;
  return next;
}
