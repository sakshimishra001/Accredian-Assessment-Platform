import "dotenv/config";

/**
 * Returns TEST_DATABASE_URL after checking it cannot be the development database,
 * because integration tests truncate every table.
 */
export function getTestDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set. Add it to .env (see .env.example) to run integration tests.");
  }
  const dbName = new URL(testUrl).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run integration tests: database "${dbName}" does not look like a test database.`);
  }
  if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === new URL(testUrl).pathname) {
    throw new Error("Refusing to run integration tests: TEST_DATABASE_URL points at the same database as DATABASE_URL.");
  }
  return testUrl;
}
