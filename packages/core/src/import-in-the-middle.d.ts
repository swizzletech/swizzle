// The package types its .mjs entry in register-hooks.d.ts, which NodeNext reads only for a .js
// specifier; a .mjs specifier looks for register-hooks.d.mts.
declare module "import-in-the-middle/register-hooks.mjs" {
  export * from "import-in-the-middle/register-hooks.js";
}
