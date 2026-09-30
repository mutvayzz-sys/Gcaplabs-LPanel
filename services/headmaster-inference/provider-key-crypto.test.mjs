import test from "node:test";
import assert from "node:assert/strict";
import { decryptProviderKey, encryptProviderKey } from "./provider-key-crypto.mjs";

// Known-answer vector shared with the admission copy of this module.
const SECRET = "x".repeat(40);
const OWNER = "11111111-2222-4333-8444-555555555555";
const CIPHERTEXT = "v1.AQEBAQEBAQEBAQEB.ToA3uDYcSME91jsc6rGfFw.MTulZuVxPoKanCMU";
const fixedIv = () => Buffer.alloc(12, 1);

test("known-answer vector encrypts to the exact wire string", () => {
  assert.equal(
    encryptProviderKey({
      secret: SECRET,
      ownerId: OWNER,
      provider: "openai",
      apiKey: "sk-test-1234",
      randomBytes: fixedIv,
    }),
    CIPHERTEXT,
  );
});

test("known-answer vector decrypts and round-trips with random IVs", () => {
  assert.equal(
    decryptProviderKey({
      secret: SECRET,
      ownerId: OWNER,
      provider: "openai",
      ciphertext: CIPHERTEXT,
    }),
    "sk-test-1234",
  );
  const a = encryptProviderKey({
    secret: SECRET,
    ownerId: OWNER,
    provider: "groq",
    apiKey: "gsk_abc",
  });
  const b = encryptProviderKey({
    secret: SECRET,
    ownerId: OWNER,
    provider: "groq",
    apiKey: "gsk_abc",
  });
  assert.notEqual(a, b);
  assert.equal(
    decryptProviderKey({
      secret: SECRET,
      ownerId: OWNER.toUpperCase(),
      provider: "groq",
      ciphertext: a,
    }),
    "gsk_abc",
  );
});

test("wrong owner, provider, tag, or secret fail", () => {
  const base = { secret: SECRET, ownerId: OWNER, provider: "openai", ciphertext: CIPHERTEXT };
  const undecryptable = { code: "provider_key_undecryptable" };
  assert.throws(
    () => decryptProviderKey({ ...base, ownerId: "11111111-2222-4333-8444-555555555556" }),
    undecryptable,
  );
  assert.throws(() => decryptProviderKey({ ...base, provider: "groq" }), undecryptable);
  assert.throws(() => decryptProviderKey({ ...base, secret: "y".repeat(40) }), undecryptable);
  const parts = CIPHERTEXT.split(".");
  parts[2] = "AAAAAAAAAAAAAAAAAAAAAA";
  assert.throws(() => decryptProviderKey({ ...base, ciphertext: parts.join(".") }), undecryptable);
  assert.throws(() => decryptProviderKey({ ...base, ciphertext: "v2.a.b.c" }), undecryptable);
  assert.throws(() => decryptProviderKey({ ...base, secret: "short" }), {
    code: "provider_key_secret_invalid",
  });
});
