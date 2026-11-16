import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { userApprovalRequests } from "../../src/db/schema/auth.ts";

// Device fingerprints are credentials. This column was never read or written,
// and rows from the old approval flow may still hold raw fingerprints.
describe("user_approval_requests.device_fingerprint", () => {
  it("should no longer be part of the schema", () => {
    expect(Object.keys(getTableColumns(userApprovalRequests))).not.toContain("deviceFingerprint");
  });

  it("should be dropped by a re-runnable migration", () => {
    const sql = readFileSync(
      path.join(
        import.meta.dirname,
        "../../src/db/migrations/0073_drop_approval_request_fingerprint.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(
      'ALTER TABLE "user_approval_requests" DROP COLUMN IF EXISTS "device_fingerprint"',
    );
  });
});
