import { describe, expect, it } from 'vitest';
import { slugify } from './catalog.slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Pollo Ahumado')).toBe('pollo-ahumado');
  });

  it('strips Spanish accents and ñ', () => {
    expect(slugify('Frijoles Negros — Café Ñame')).toBe('frijoles-negros-cafe-name');
  });

  it('collapses punctuation and trims the ends', () => {
    expect(slugify('  (1 lb) Arroz!! ')).toBe('1-lb-arroz');
  });

  it('falls back when nothing usable is left', () => {
    expect(slugify('¡¡¡')).toBe('product');
  });

  it('stays within the column length, leaving room for a suffix', () => {
    const slug = slugify('a'.repeat(300));
    expect(slug.length).toBeLessThanOrEqual(96);
  });
});
