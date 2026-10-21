import { useEffect, useState } from 'react';
import { get } from './api';
import { useAuth } from './auth';
import { useI18n } from './i18n';
import type { Area, Category, Service } from './types';

export interface Catalog { services: Service[]; categories: Category[]; areas: Area[] }
let cache: Promise<Catalog> | null = null;

export function loadCatalog(force = false): Promise<Catalog> {
  if (!cache || force) {
    cache = Promise.all([get<{ items: Service[]; categories: Category[] }>('/services'), get<{ items: Area[] }>('/service-areas')])
      .then(([s, a]) => ({ services: s.items, categories: s.categories, areas: a.items }))
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

export function useCatalog() {
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    setError(null);
    loadCatalog().then(setData, setError);
  };
  useEffect(load, []);
  return { catalog: data, error, reload: load };
}

/** Picks the right language for bilingual records. */
export function useLocalName() {
  const { lang } = useI18n();
  return (x: { nameEn: string; nameRw: string }) => (lang === 'rw' ? x.nameRw : x.nameEn);
}

/** Unit price for a service + category, honouring per-category overrides (display only — server is authoritative). */
export const unitPriceFor = (s: Service, categoryId?: string) => s.categoryPrices.find((p) => p.categoryId === categoryId)?.unitPrice ?? s.unitPrice;

/**
 * Categories relevant to the signed-in customer:
 * - business accounts see business stock types (linens, uniforms…) first, then everything else (rentals need all);
 * - personal accounts see personal types, filtered by their gender preference when set;
 * - guests see all personal types.
 */
export function useVisibleCategories(): Category[] {
  const { catalog } = useCatalog();
  const { user } = useAuth();
  const all = catalog?.categories ?? [];
  if (user?.accountType === 'BUSINESS') return [...all.filter((c) => c.segment === 'BUSINESS'), ...all.filter((c) => c.segment !== 'BUSINESS')];
  return all.filter((c) => c.segment === 'PERSONAL' && (c.gender === 'ANY' || !user?.gender || c.gender === user.gender));
}
