// @ts-check
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// Every module directory under src/modules — keep this list in sync with
// CLAUDE.md section 4. Adding a module means adding its name here.
const moduleNames = [
  'tenancy',
  'identity',
  'catalog',
  'media',
  'geo',
  'cart',
  'orders',
  'payments',
  'fulfilment',
  'notifications',
  'audit',
];

// Generates one zone per (target module, other module) pair so that any
// non-index file inside a module can never import another module's
// internals (schema.ts / repo.ts / service.ts / routes.ts) directly —
// only that module's index.ts (its public service + router) is reachable.
// A plain `no-restricted-imports` cannot express this: it matches raw
// import specifiers, and a sibling-module relative import like
// `../catalog/catalog.repo.js` never contains the literal segment
// "modules", so it would slip straight through. `import/no-restricted-paths`
// resolves specifiers to real file paths first, which is what makes the
// zone below actually catch that case.
const boundaryZones = moduleNames.flatMap((target) =>
  moduleNames
    .filter((from) => from !== target)
    .map((from) => ({
      target: `./src/modules/${target}/**/!(index).ts`,
      from: `./src/modules/${from}`,
      except: ['./index.ts'],
      message: `Import ${from}'s public service from its index.ts. Never import ${from}'s repo.ts or schema.ts directly — add a method to ${from}Service instead.`,
    })),
);

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      // Every relative import in this codebase points at compiled '.js'
      // paths (NodeNext ESM convention) while the source files on disk are
      // '.ts'. The default node resolver can't bridge that and silently
      // fails to resolve — which made the boundary rule below a no-op.
      'import/resolver': {
        typescript: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'import/no-restricted-paths': ['error', { zones: boundaryZones }],
    },
  },
);
