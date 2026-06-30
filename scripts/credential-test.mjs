// Demonstrates credential validation in src/index.ts:
//   1. missing key   -> fails safely (no throw)
//   2. key present    -> validates and loads
//   3. key rotated    -> change detected and adopted mid-flight
//   4. key removed    -> fails safely again
// Imports the compiled module directly; main() is guarded so no server starts.
import { validateStoreCredential } from "../dist/index.js";

function show(label, r) {
  console.log(label, JSON.stringify(r));
}

// 1. No env var set -> fail safe
delete process.env.STORE_KEY_47;
show("missing  ->", validateStoreCredential("47"));

// 2. Set the key -> ok, fresh load
process.env.STORE_KEY_47 = "sk_live_original";
show("present  ->", validateStoreCredential("47"));

// 3. Rotate the key while "running" -> ok, rotated:true
process.env.STORE_KEY_47 = "sk_live_rotated";
show("rotated  ->", validateStoreCredential("47"));

// 3b. Same key again -> ok, rotated:false
show("stable   ->", validateStoreCredential("47"));

// 4. Remove the key mid-flight -> fail safe
delete process.env.STORE_KEY_47;
show("removed  ->", validateStoreCredential("47"));

// 5. Blank value is treated as missing
process.env.STORE_KEY_102 = "   ";
show("blank    ->", validateStoreCredential("102"));
