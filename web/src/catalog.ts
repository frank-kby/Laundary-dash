import { useEffect, useState } from 'react';
import { get } from './api';
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
