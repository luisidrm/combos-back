// Every product needs a category (the owner's rule), but most tests only care about the product. This hands
// a test the id of one plain category per store, creating it the first time it is asked for. It takes the
// service as an argument instead of importing it, so a test file keeps importing services dynamically
// (a static import would open the database pool before the test database exists).

interface CategoryCreator {
  createCategory(tenantId: string, input: { nameEs: string }): Promise<{ id: string }>;
}

const made = new Map<string, Promise<string>>();

export function defaultCategory(catalog: CategoryCreator, tenantId: string): Promise<string> {
  let id = made.get(tenantId);
  if (!id) {
    id = catalog.createCategory(tenantId, { nameEs: 'General' }).then((category) => category.id);
    made.set(tenantId, id);
  }
  return id;
}
