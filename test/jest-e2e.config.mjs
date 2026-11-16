/** @type {import('jest').Config} */
export default {
  displayName: 'e2e',
  testEnvironment: 'node',
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/test/support/global-setup.mjs',
  setupFiles: ['<rootDir>/test/support/setup-env.mjs'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Los tests comparten PostgreSQL y Redis de test: en serie, para que el worker de un
  // archivo no consuma los jobs de otro.
  maxWorkers: 1,
  testTimeout: 30000,
};
