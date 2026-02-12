// Test setup - runs before all test files
// For now, just ensure env is set
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-do-not-use-in-production";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://localhost:5432/padmakara_test";
