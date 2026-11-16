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
  testTimeout: 30000,
};
