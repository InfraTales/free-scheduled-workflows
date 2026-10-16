module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // test/local needs DynamoDB Local and Step Functions Local: `npm run test:local`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/local/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 120000,
};
