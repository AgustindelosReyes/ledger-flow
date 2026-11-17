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
  // The tests share the test PostgreSQL and Redis: they run serially so that the worker of
  // one file does not consume the jobs of another.
  maxWorkers: 1,
  testTimeout: 30000,
};
