module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/local'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
  // Both suites share one DynamoDB Local; run them one after the other.
  maxWorkers: 1,
};
