import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../App';
import { Badge, Button, Card, Input, Sheet } from '../components/ui/primitives';

interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  price_cents: number;
  currency: string;
  stock_qty: number;
  is_active: boolean;
}

const ROLE_ORDER: Record<string, number> = {
  viewer: 0,
  agent: 1,
  manager: 2,
  admin: 3,
};

export function ProductsPage() {
  const { user } = useAuth();
  const canManage = (ROLE_ORDER[user?.role || 'viewer'] ?? 0) >= 2;

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'true' | 'false'>('all');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Product | null>(null);

  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [price, setPrice] = useState('0.00');
  const [currency, setCurrency] = useState('USD');
  const [stockQty, setStockQty] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const list = await apiFetch<Product[]>('/products');
      setProducts(list || []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Error al cargar los productos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch<Product[]>('/products')
      .then((list) => {
        if (!active) return;
        setProducts(list || []);
        setError('');
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message || 'Error al cargar los productos.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set).sort();
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.toLowerCase().includes(q)) {
        return false;
      }
      if (categoryFilter && p.category !== categoryFilter) {
        return false;
      }
      if (activeFilter === 'true' && !p.is_active) return false;
      if (activeFilter === 'false' && p.is_active) return false;
      return true;
    });
  }, [products, search, categoryFilter, activeFilter]);

  function openCreate() {
    setEditing(null);
    setSku('');
    setName('');
    setDescription('');
    setCategory('general');
    setPrice('0.00');
    setCurrency('USD');
    setStockQty('0');
    setIsActive(true);
    setEditorOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setSku(p.sku || '');
    setName(p.name);
    setDescription(p.description || '');
    setCategory(p.category || 'general');
    setPrice((p.price_cents / 100).toFixed(2));
    setCurrency(p.currency || 'USD');
    setStockQty(String(p.stock_qty ?? 0));
    setIsActive(p.is_active);
    setEditorOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        sku: sku.trim(),
        name: name.trim(),
        description: description.trim(),
        category: category.trim() || 'general',
        price_cents: Math.round(Number(price || 0) * 100),
        currency: currency.trim() || 'USD',
        stock_qty: Math.max(0, parseInt(stockQty || '0', 10) || 0),
        is_active: isActive,
      };
      if (editing) {
        await apiFetch(`/products/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setNotice('Producto actualizado.');
      } else {
        await apiFetch('/products', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice('Producto creado.');
      }
      setEditorOpen(false);
      await loadProducts();
    } catch (err: any) {
      setError(err?.message || 'No se pudo guardar el producto.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p: Product) {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/products/${p.id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      setNotice('Producto eliminado.');
      await loadProducts();
    } catch (err: any) {
      setError(err?.message || 'No se pudo eliminar el producto.');
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-[var(--text)]">Catálogo de Productos</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Administra tus productos, precios, categorías y disponibilidad de inventario
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4" /> Nuevo Producto
          </Button>
        )}
      </div>

      {notice && (
        <div className="px-3.5 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-xs text-emerald-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="px-3.5 py-2 rounded-xl border border-red-200 bg-red-50 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o SKU..."
            className="pl-9"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filtrar por categoría"
          className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
        >
          <option value="">Todas las categorías</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        <select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as 'all' | 'true' | 'false')}
          aria-label="Filtrar por estado"
          className="h-10 rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
        >
          <option value="all">Todos los estados</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
      </div>

      {loading ? (
        <Card className="p-8 text-center text-sm text-[var(--text-muted)]">
          Cargando catálogo de productos...
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <Package className="w-8 h-8 text-[var(--text-muted)] mx-auto" />
          <div className="text-sm font-medium text-[var(--text)]">No hay productos para mostrar</div>
          <p className="text-xs text-[var(--text-muted)]">
            {products.length === 0
              ? 'Crea tu primer producto para empezar a cotizar y alimentar tu catálogo.'
              : 'Prueba ajustando los filtros de búsqueda.'}
          </p>
        </Card>
      ) : (
        <>
          {isDesktop && (
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text-muted)]">
                    <th className="py-3 px-4 font-semibold">Producto</th>
                    <th className="py-3 px-4 font-semibold">SKU</th>
                    <th className="py-3 px-4 font-semibold">Categoría</th>
                    <th className="py-3 px-4 font-semibold">Precio</th>
                    <th className="py-3 px-4 font-semibold">Stock</th>
                    <th className="py-3 px-4 font-semibold">Estado</th>
                    {canManage && <th className="py-3 px-4 font-semibold text-right">Acciones</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filtered.map((p) => (
                    <tr key={p.id} className="hover:bg-[var(--surface)]/60">
                      <td className="py-3 px-4">
                        <div className="font-medium text-[var(--text)]">{p.name}</div>
                        {p.description && (
                          <div className="text-xs text-[var(--text-muted)] line-clamp-1">
                            {p.description}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-[var(--text-muted)]">
                        {p.sku || '—'}
                      </td>
                      <td className="py-3 px-4">
                        <Badge tone="neutral">{p.category || 'general'}</Badge>
                      </td>
                      <td className="py-3 px-4 font-medium">
                        {p.currency} {(p.price_cents / 100).toFixed(2)}
                      </td>
                      <td className="py-3 px-4">{p.stock_qty}</td>
                      <td className="py-3 px-4">
                        <Badge tone={p.is_active ? 'success' : 'neutral'}>
                          {p.is_active ? 'Activo' : 'Inactivo'}
                        </Badge>
                      </td>
                      {canManage && (
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(p)}
                              aria-label={`Editar ${p.name}`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmDelete(p)}
                              aria-label={`Eliminar ${p.name}`}
                              className="text-[var(--danger)]"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          )}

          {!isDesktop && (
          <div className="md:hidden space-y-2.5">
            {filtered.map((p) => (
              <Card key={p.id} className="p-3.5 space-y-2 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{p.name}</div>
                    <div className="text-xs text-[var(--text-muted)] font-mono">
                      {p.sku ? `SKU: ${p.sku}` : 'Sin SKU'} · {p.category || 'general'}
                    </div>
                  </div>
                  <Badge tone={p.is_active ? 'success' : 'neutral'}>
                    {p.is_active ? 'Activo' : 'Inactivo'}
                  </Badge>
                </div>
                {p.description && (
                  <p className="text-xs text-[var(--text-muted)] line-clamp-2">{p.description}</p>
                )}
                <div className="flex items-center justify-between pt-1">
                  <div className="text-sm font-bold text-[var(--accent)]">
                    {p.currency} {(p.price_cents / 100).toFixed(2)}{' '}
                    <span className="text-xs font-normal text-[var(--text-muted)]">
                      · Stock: {p.stock_qty}
                    </span>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(p)}
                        className="text-[var(--danger)]"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
          )}
        </>
      )}

      {/* ProductEditor Sheet */}
      <Sheet
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? 'Editar producto' : 'Nuevo producto'}
      >
        <form onSubmit={handleSave} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre *</label>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Plan Empresarial"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">SKU</label>
              <Input
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="CRM-ENT-01"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Descripción</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descripción breve del producto o servicio..."
              className="w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Categoría</label>
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="general"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="product-currency" className="text-xs font-medium">Moneda</label>
              <select
                id="product-currency"
                aria-label="Moneda"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 text-sm"
              >
                <option value="USD">USD</option>
                <option value="BRL">BRL</option>
                <option value="MXN">MXN</option>
                <option value="COP">COP</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Precio</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Stock</label>
              <Input
                type="number"
                min="0"
                required
                value={stockQty}
                onChange={(e) => setStockQty(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-[var(--border-input)]"
            />
            Producto activo en catálogo
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditorOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear producto'}
            </Button>
          </div>
        </form>
      </Sheet>

      {/* Confirmación de eliminación */}
      <Sheet
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Eliminar producto"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-muted)]">
            ¿Seguro que deseas eliminar <strong>{confirmDelete?.name}</strong>? Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => confirmDelete && handleDelete(confirmDelete)}>
              Eliminar
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
