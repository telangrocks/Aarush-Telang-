import path from 'node:path';

export default {
  resolve: {
    alias: {
      '@shared/monitoring': path.resolve(__dirname, '../shared/monitoring/index.ts'),
      vitest: path.resolve(__dirname, '../backend/node_modules/vitest/dist/index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
};
