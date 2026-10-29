import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const statfs = fs.statfsSync;
fs.statfsSync = (...args) => ({
  ...statfs(...args),
  bsize: 1,
  bavail: Number(process.env.SWIZZLE_TEST_FREE_BYTES),
});
syncBuiltinESMExports();
