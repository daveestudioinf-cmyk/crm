import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

export interface QuickTemplate {
  id: string;
  shortcut: string;
  title: string;
  category: string;
  body: string;
}

const VARIABLE_CHIPS = [
  { label: 'Nombre contacto', token: '{{contact.name}}' },
  { label: 'Teléfono contacto', token: '{{contact.phone}}' },
  { label: 'Nombre agente', token: '{{agent.name}}' },
  { label: 'Organización', token: '{{org.name}}' },
];

const DEFAULT_CATEGORIES = ['general', 'saludo', 'ventas', 'soporte', 'seguimiento'];

function CategoryFilter({
  categories,
  selected,
  onSelect,
}: {
  categories: string[];
  selected: string;
  onSelect: (cat: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filtrar por categoría">
      <button
        type="button"
        onClick={() => onSelect('')}
        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
          selected === ''
            ? 'bg-[var(--accent)] text-[var(--on-accent)]'
            : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]'
        }`}
      >
        Todas
      </button>
      {categories.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => onSelect(cat)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize transition-colors cursor-pointer ${
            selected === cat
              ? 'bg-[var(--accent)] text-[var(--on-accent)]'
              : 'bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]'
          }`}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}

function TemplateList({
  templates,
  onEdit,
  onDelete,
}: {
  templates: QuickTemplate[];
  onEdit: (t: QuickTemplate) => void;
  onDelete: (t: QuickTemplate) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {templates.map((t) => (
        <Card key={t.id} className="p-4 flex flex-col justify-between gap-3 min-w-0">
          <div className="space-y-2 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono text-xs font-semibold text-[var(--accent)]">
                    /{t.shortcut.replace(/^\/+/, '')}
                  </span>
                  <Badge tone="neutral" className="capitalize">
                    {t.category || 'general'}
                  </Badge>
                </div>
                <h2 className="text-sm font-semibold text-[var(--text)] truncate mt-1">
                  {t.title || t.shortcut}
                </h2>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onEdit(t)}
                  aria-label={`Editar plantilla ${t.shortcut}`}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] cursor-pointer"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(t)}
                  aria-label={`Eliminar plantilla ${t.shortcut}`}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-red-50 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap break-words line-clamp-4">
              {t.body}
            </p>
          </div>
        </Card>
      ))}
    </div>
  );
}

function TemplateEditorDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: QuickTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [shortcut, setShortcut] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setShortcut(editing.shortcut.replace(/^\/+/, ''));
      setTitle(editing.title || '');
      setCategory(editing.category || 'general');
      setBody(editing.body || '');
    } else {
      setShortcut('');
      setTitle('');
      setCategory('general');
      setBody('');
    }
    setError('');
  }, [open, editing]);

  function insertVariable(token: string) {
    const el = textareaRef.current;
    if (!el) {
      setBody((prev) => (prev ? `${prev} ${token}` : token));
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cleanShortcut = shortcut.trim().replace(/^\/+/, '');
    if (!cleanShortcut || !body.trim()) {
      setError('El atajo y el contenido son obligatorios.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        shortcut: cleanShortcut,
        title: title.trim() || cleanShortcut,
        category: category.trim() || 'general',
        body: body.trim(),
      };
      if (editing) {
        await apiFetch(`/templates/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/templates', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar la plantilla.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Editar plantilla rápida' : 'Nueva plantilla rápida'}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="px-3 py-2 rounded-xl text-xs bg-red-50 border border-red-200 text-[var(--danger)]">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="tpl-shortcut" className="text-xs font-medium">
              Atajo (sin /)
            </label>
            <Input
              id="tpl-shortcut"
              required
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="bienvenida"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="tpl-category" className="text-xs font-medium">
              Categoría
            </label>
            <Input
              id="tpl-category"
              list="tpl-categories-list"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="general"
            />
            <datalist id="tpl-categories-list">
              {DEFAULT_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="tpl-title" className="text-xs font-medium">
            Título descriptivo
          </label>
          <Input
            id="tpl-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Saludo inicial de ventas"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="tpl-body" className="text-xs font-medium">
              Mensaje
            </label>
            <span className="text-[11px] text-[var(--text-muted)]">Variables disponibles:</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {VARIABLE_CHIPS.map((v) => (
              <button
                key={v.token}
                type="button"
                onClick={() => insertVariable(v.token)}
                className="px-2 py-1 rounded-full text-[11px] font-mono bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] cursor-pointer"
              >
                {v.token}
              </button>
            ))}
          </div>
          <textarea
            id="tpl-body"
            ref={textareaRef}
            required
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Hola {{contact.name}}, gracias por escribirnos..."
            className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear plantilla'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<QuickTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<QuickTemplate | null>(null);
  const [deleting, setDeleting] = useState<QuickTemplate | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<QuickTemplate[]>('/templates');
      setTemplates(data || []);
    } catch (err: any) {
      setError(err.message || 'No se pudieron cargar las plantillas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORIES);
    for (const t of templates) {
      if (t.category) set.add(t.category);
    }
    return Array.from(set);
  }, [templates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (category && (t.category || 'general') !== category) return false;
      if (!q) return true;
      return (
        t.shortcut.toLowerCase().includes(q) ||
        (t.title || '').toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q)
      );
    });
  }, [templates, category, search]);

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await apiFetch(`/templates/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err: any) {
      setError(err.message || 'No se pudo eliminar la plantilla.');
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Plantillas y Respuestas Rápidas</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Usa <code className="font-mono">/atajo</code> en la Bandeja para responder al instante.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="w-4 h-4" /> Nueva plantilla
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-3 text-[var(--text-muted)]" />
          <Input
            className="pl-9"
            placeholder="Buscar por atajo, título o texto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <CategoryFilter categories={categories} selected={category} onSelect={setCategory} />
      </div>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[var(--danger)]">{error}</span>
          <Button size="sm" variant="secondary" onClick={load}>
            <RefreshCw className="w-3.5 h-3.5" /> Reintentar
          </Button>
        </Card>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-4 h-32 animate-pulse bg-[var(--surface)]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <FileText className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <div className="text-sm font-semibold">
              {templates.length === 0 ? 'Aún no tienes plantillas' : 'Sin resultados para este filtro'}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {templates.length === 0
                ? 'Crea respuestas rápidas con variables como {{contact.name}} para agilizar tu Bandeja.'
                : 'Prueba con otro término de búsqueda o selecciona todas las categorías.'}
            </p>
          </div>
          {templates.length === 0 && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              <Plus className="w-4 h-4" /> Crear primera plantilla
            </Button>
          )}
        </Card>
      ) : (
        <TemplateList
          templates={filtered}
          onEdit={(t) => {
            setEditing(t);
            setEditorOpen(true);
          }}
          onDelete={(t) => setDeleting(t)}
        />
      )}

      <TemplateEditorDialog
        open={editorOpen}
        editing={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={load}
      />

      <Sheet
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Eliminar plantilla"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar la plantilla{' '}
            <strong className="font-mono text-[var(--text)]">
              /{deleting?.shortcut.replace(/^\/+/, '')}
            </strong>
            ? Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button variant="danger" disabled={deleteBusy} onClick={confirmDelete}>
              {deleteBusy ? 'Eliminando...' : 'Eliminar'}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
