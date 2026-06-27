// Tests for the security-critical accept/reject logic of the marketplace
// publish gate (CPHM-FR-007 / CPHM-NFR-004 / AC2 / AC3 / AC4).
//
// The trust chain runGate enforces is fail-closed and load-bearing: a
// regression that resolved an unknown or revoked key as active, skipped the
// catalog-signature re-verification, or let a configured-revoked entry through
// unflagged would let a bad catalog ship. These tests pin each branch with
// in-memory ed25519 keypairs (node:crypto only, matching the scripts under
// test), writing the envelopes to a temp dir because runGate reads the catalog
// and key-ring from file paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalPayloadBytes } from "../canonical.mjs";
import { fingerprintKeyId, publicKeyToPem } from "../keys.mjs";
import { runGate } from "../verify-keyring.mjs";
import { buildKeyRingPayload } from "../sign-key-ring.mjs";

/** A fresh ed25519 keypair, exposing the parts the scripts consume. */
function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    keyId: fingerprintKeyId(publicKey),
    pem: publicKeyToPem(publicKey),
  };
}

/** Sign a payload into the { payload, signature } envelope runGate verifies. */
function signEnvelope(payload, privateKey) {
  const signature = cryptoSign(null, canonicalPayloadBytes(payload), privateKey).toString("base64");
  return { payload, signature };
}

/** A ring payload key entry for a given public key + status. */
function ringEntry(pair, status) {
  return { keyId: pair.keyId, publicKeyPem: pair.pem, status };
}

function ringPayload(entries) {
  return { keys: entries, generatedAt: "2026-01-01T00:00:00.000Z" };
}

function catalogPayload(keyId, entries = []) {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", keyId, entries };
}

function entry(id, extra = {}) {
  return {
    id,
    name: id,
    kind: "component",
    version: "0.1.0",
    summary: `${id} summary`,
    source: { type: "release", assetUrl: `https://example/${id}.tgz`, sha256: "sha256-deadbeef" },
    integrity: "sha256-deadbeef",
    provenance: `roubo-plugins/plugins/${id}@0.1.0`,
    ...extra,
  };
}

/**
 * Write the catalog, key-ring, and (optional) revocation config to a temp dir
 * and run the gate against them. Cleans up the temp dir afterwards.
 *
 * @returns {string[]} the gate's failures (empty = pass)
 */
function gate(t, { keyRing, catalog, rootPublicKey, revokedEntryIds }) {
  const dir = mkdtempSync(path.join(tmpdir(), "keyring-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const catalogPath = path.join(dir, "catalog.json");
  const keyRingPath = path.join(dir, "key-ring.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(keyRingPath, JSON.stringify(keyRing));

  let revokedConfigPath;
  if (revokedEntryIds !== undefined) {
    revokedConfigPath = path.join(dir, "key-ring.config.json");
    writeFileSync(revokedConfigPath, JSON.stringify({ keys: [], revokedEntryIds }));
  }

  return runGate({ catalogPath, keyRingPath, rootPublicKey, revokedConfigPath });
}

test("runGate: a catalog signed by an active, ring-resolved key passes", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), root.privateKey);
  const catalog = signEnvelope(catalogPayload(op.keyId, [entry("github-com")]), op.privateKey);

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.deepEqual(failures, []);
});

test("runGate: a catalog keyId absent from the ring is rejected (unknown key)", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const unknown = newKeyPair();
  // The ring vouches for `op`, but the catalog is signed by (and labelled with)
  // an entirely different key that no ring entry covers.
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), root.privateKey);
  const catalog = signEnvelope(
    catalogPayload(unknown.keyId, [entry("github-com")]),
    unknown.privateKey,
  );

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not present in the key-ring/);
});

test("runGate: a catalog keyId resolving to a revoked ring key is rejected", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  // The signing key IS in the ring, but marked revoked (a rotated-out key).
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "revoked")]), root.privateKey);
  const catalog = signEnvelope(catalogPayload(op.keyId, [entry("github-com")]), op.privateKey);

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /status 'revoked'.*not 'active'|not 'active'/);
});

test("runGate: a catalog signature that does not match the resolved key is rejected", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const impostor = newKeyPair();
  // The ring resolves op.keyId -> op's public key, but the catalog (labelled
  // with op.keyId) was signed by a different private key.
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), root.privateKey);
  const catalog = signEnvelope(
    catalogPayload(op.keyId, [entry("github-com")]),
    impostor.privateKey,
  );

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /signature does not verify against the active key/);
});

test("runGate: a key-ring not signed by the root key is rejected, before any key resolution", (t) => {
  const root = newKeyPair();
  const wrongRoot = newKeyPair();
  const op = newKeyPair();
  // The ring is signed by the wrong root; runGate is given the real root public
  // key, so the ring-signature check fails and it returns early.
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), wrongRoot.privateKey);
  const catalog = signEnvelope(catalogPayload(op.keyId, [entry("github-com")]), op.privateKey);

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /does not verify against the root public key/);
});

test("runGate: a configured-revoked entry that is present but unflagged fails the gate", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), root.privateKey);
  // `process` is in revokedEntryIds but its catalog entry is not revoked: true.
  const catalog = signEnvelope(catalogPayload(op.keyId, [entry("process")]), op.privateKey);

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: ["process"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /listed in revokedEntryIds but is not revoked/);
});

test("runGate: a configured-revoked entry that is flagged revoked: true passes", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const keyRing = signEnvelope(ringPayload([ringEntry(op, "active")]), root.privateKey);
  const catalog = signEnvelope(
    catalogPayload(op.keyId, [entry("process", { revoked: true })]),
    op.privateKey,
  );

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: ["process"],
  });
  assert.deepEqual(failures, []);
});

test("runGate: a key-ring that is not a { payload, signature } envelope is rejected", (t) => {
  const root = newKeyPair();
  const op = newKeyPair();
  const keyRing = { payload: ringPayload([ringEntry(op, "active")]) }; // no signature
  const catalog = signEnvelope(catalogPayload(op.keyId, [entry("github-com")]), op.privateKey);

  const failures = gate(t, {
    keyRing,
    catalog,
    rootPublicKey: root.publicKey,
    revokedEntryIds: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not a \{ payload, signature \} envelope/);
});

test("buildKeyRingPayload: injects the active key alongside config keys, sorted with an active present", (t) => {
  const rotatedOut = newKeyPair();
  const active = newKeyPair();
  const dir = mkdtempSync(path.join(tmpdir(), "keyring-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "key-ring.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ keys: [{ publicKeyPem: rotatedOut.pem, status: "revoked" }] }),
  );

  const payload = buildKeyRingPayload({ configPath, activeKeyPem: active.pem });

  assert.equal(payload.keys.length, 2);
  assert.ok(payload.keys.some((k) => k.keyId === active.keyId && k.status === "active"));
  assert.ok(payload.keys.some((k) => k.keyId === rotatedOut.keyId && k.status === "revoked"));
  // Deterministic order: sorted by keyId.
  const ids = payload.keys.map((k) => k.keyId);
  assert.deepEqual(ids, [...ids].sort());
});

test("buildKeyRingPayload: an injected active key overrides a same-key config entry", (t) => {
  const op = newKeyPair();
  const dir = mkdtempSync(path.join(tmpdir(), "keyring-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "key-ring.config.json");
  // The same key is listed revoked in config but injected active at publish time.
  writeFileSync(
    configPath,
    JSON.stringify({ keys: [{ publicKeyPem: op.pem, status: "revoked" }] }),
  );

  const payload = buildKeyRingPayload({ configPath, activeKeyPem: op.pem });

  assert.equal(payload.keys.length, 1);
  assert.equal(payload.keys[0].keyId, op.keyId);
  assert.equal(payload.keys[0].status, "active");
});

test("buildKeyRingPayload: throws when the ring would be empty", () => {
  assert.throws(() => buildKeyRingPayload({}), /empty/i);
});

test("buildKeyRingPayload: throws when no key is active", (t) => {
  const op = newKeyPair();
  const dir = mkdtempSync(path.join(tmpdir(), "keyring-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "key-ring.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ keys: [{ publicKeyPem: op.pem, status: "revoked" }] }),
  );

  assert.throws(() => buildKeyRingPayload({ configPath }), /no 'active' key/);
});

test("buildKeyRingPayload: throws when a config key declares a mismatched keyId", (t) => {
  const op = newKeyPair();
  const dir = mkdtempSync(path.join(tmpdir(), "keyring-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "key-ring.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      keys: [{ publicKeyPem: op.pem, status: "active", keyId: "ed25519-deadbeefdeadbeef" }],
    }),
  );

  assert.throws(() => buildKeyRingPayload({ configPath }), /declares keyId .* but its public key/);
});

// createPublicKey is imported for parity with the scripts under test but the
// helpers above already exercise the key paths through them; keep the surface
// minimal by asserting the fingerprint scheme stays stable here.
test("keys: fingerprintKeyId is stable and prefixed for a given key", () => {
  const op = newKeyPair();
  assert.equal(fingerprintKeyId(createPublicKey(op.pem)), op.keyId);
  assert.match(op.keyId, /^ed25519-[0-9a-f]{16}$/);
});
