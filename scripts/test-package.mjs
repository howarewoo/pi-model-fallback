import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
assert.ok(args.length <= 1, "Usage: npm run test:package -- [release.tgz]");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/package.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, RELEASE_TARBALL: args[0] ? resolve(args[0]) : "" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
