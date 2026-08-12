import type { Category } from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { createCategory, deleteCategory, listCategories, updateCategory } from '../api/finance.js';
import { PageHeader } from '../components/Shell.js';

/** Categories are entirely manual: add, rename, recolour, delete. */
export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#22d3ee');

  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['categories'] });
    await queryClient.invalidateQueries({ queryKey: ['transactions'] });
  };

  const create = useMutation({
    mutationFn: createCategory,
    onSuccess: async () => {
      setName('');
      await invalidate();
    },
  });

  const remove = useMutation({ mutationFn: deleteCategory, onSuccess: invalidate });

  return (
    <>
      <PageHeader
        title="Categories"
        description="Deleting a category leaves its transactions uncategorized rather than removing them."
      />

      <form
        className="panel section form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate({ name, color });
        }}
      >
        <div className="form__row">
          <label className="field">
            <span className="label">new category</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>

          <label className="field field--narrow">
            <span className="label">colour</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="color-input"
            />
          </label>

          <button type="submit" className="button" disabled={create.isPending}>
            add
          </button>
        </div>

        {create.isError && <span className="error">{create.error.message}</span>}
      </form>

      {categories.isError && <p className="error">{categories.error.message}</p>}

      <ul className="card-list">
        {categories.data?.map((category) => (
          <CategoryRow
            key={category.id}
            category={category}
            onDelete={() => remove.mutate(category.id)}
            onSaved={invalidate}
          />
        ))}
      </ul>

      {remove.isError && <p className="error">{remove.error.message}</p>}
    </>
  );
}

function CategoryRow({
  category,
  onDelete,
  onSaved,
}: {
  category: Category;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);

  const save = useMutation({
    mutationFn: () => updateCategory(category.id, { name, color }),
    onSuccess: onSaved,
  });

  const dirty = name !== category.name || color !== category.color;

  return (
    <li className="card card--row">
      <span className="swatch" style={{ background: color }} aria-hidden />

      <input
        className="card__input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label={`Name for ${category.name}`}
      />

      <input
        type="color"
        className="color-input"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        aria-label={`Colour for ${category.name}`}
      />

      <div className="card__actions">
        <button
          type="button"
          className="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          save
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            if (confirm(`Delete category "${category.name}"?`)) onDelete();
          }}
        >
          delete
        </button>
      </div>
    </li>
  );
}
