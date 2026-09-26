// "Pollo Ahumado (1 lb)" -> "pollo-ahumado-1-lb". Spanish names carry
// accents and ñ, so decompose and drop the combining marks first.
const MAX_SLUG_LENGTH = 100;
// Leaves room for a "-NN" suffix when a name collides.
const BASE_LENGTH = MAX_SLUG_LENGTH - 4;

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'product';
}
