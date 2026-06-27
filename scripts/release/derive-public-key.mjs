// Derive a public key PEM from a key PEM read on stdin.
//
// Reads an ed25519 key PEM on STDIN (PKCS8 private or SPKI public) and writes
// its SPKI public PEM to STDOUT. The private key is never written to disk or
// logged: it stays on the pipe (CPHM-NFR-006 / AC3). Two uses:
//
//   - The pages workflow pipes the operational signing secret through this to
//     get the active operational PUBLIC key (injected into the key-ring via
//     sign-key-ring --active-key-file) and pipes the root signing secret through
//     it to get the root PUBLIC key for the verify-keyring gate.
//   - A maintainer rotating a key runs `node scripts/release/derive-public-key.mjs
//     < old-priv.pem` to get the public PEM to paste into
//     marketplace/key-ring.config.json with status 'revoked'.
//
// node:crypto only; no new dependency (CPHM-NFR-006).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublicKey, publicKeyToPem, readStdin } from "./keys.mjs";

async function main() {
  const pem = (await readStdin()).trim();
  if (!pem) {
    throw new Error(
      "No key on stdin. Pipe an ed25519 key PEM in, e.g. `node scripts/release/derive-public-key.mjs < key.pem`.",
    );
  }
  process.stdout.write(publicKeyToPem(loadPublicKey(pem)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
