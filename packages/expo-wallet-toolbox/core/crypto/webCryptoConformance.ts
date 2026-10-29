/**
 * Everything the MLS stack asks of `crypto.subtle`, in one list.
 *
 * `react-native-quick-crypto`'s WebCrypto is partial in ways that are invisible
 * until the exact call is made: Ed25519 and X25519 keygen are commented out,
 * HMAC imports but cannot sign, HKDF cannot be imported at all. Each gap
 * surfaced only when an MLS exchange happened to reach it, which meant finding
 * them one device round-trip at a time.
 *
 * So the requirements live here rather than only in a test. Jest runs this
 * against the shim, and the app runs the identical list on device at startup —
 * the gaps are then a single log line instead of a week of walls.
 *
 * Every check is self-contained and swallows its own error: the point is to
 * report all failures at once, not to stop at the first.
 */

export interface ConformanceResult {
  /** `Algorithm: operation`, e.g. `X25519: deriveBits`. */
  name: string
  ok: boolean
  /** Why it failed, when it did. */
  detail?: string
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const u8 = (b: ArrayBuffer | Uint8Array) => new Uint8Array(b as ArrayBuffer)

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function unhex(text: string): Uint8Array<ArrayBuffer> {
  const pairs = text.match(/../g) ?? []
  const out = new Uint8Array(new ArrayBuffer(pairs.length))
  pairs.forEach((pair, i) => {
    out[i] = parseInt(pair, 16)
  })
  return out
}

/** Fails the check with a readable reason rather than throwing. */
class CheckFailed extends Error {}

function expect(condition: boolean, why: string): void {
  if (!condition) throw new CheckFailed(why)
}

type Check = (subtle: SubtleCrypto) => Promise<void>

const CHECKS: Record<string, Check> = {
  'SHA-256: digest': async subtle => {
    const out = u8(await subtle.digest('SHA-256', utf8('abc')))
    expect(out.length === 32, `digest produced ${out.length} bytes`)
  },

  'HMAC: sign and verify': async subtle => {
    // RFC 4231 test case 1. A self-consistent HMAC that is simply wrong would
    // pass a round-trip check and then disagree with every other device.
    const key = await subtle.importKey('raw', new Uint8Array(20).fill(0x0b), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify'
    ])
    const tag = u8(await subtle.sign('HMAC', key, utf8('Hi There')))
    expect(
      hex(tag) === 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
      `HMAC-SHA256 disagrees with RFC 4231: ${hex(tag).slice(0, 16)}…`
    )
    expect(await subtle.verify('HMAC', key, tag, utf8('Hi There')), 'a valid tag was rejected')
    expect(!(await subtle.verify('HMAC', key, tag, utf8('other'))), 'a tag for other data was accepted')
  },

  'HKDF: deriveBits': async subtle => {
    // RFC 5869 test case 1. Checking only the length would let an
    // implementation ignore the salt or the info and still look healthy, while
    // the two sides of an exchange derived different secrets.
    const key = await subtle.importKey('raw', new Uint8Array(22).fill(0x0b), 'HKDF', false, ['deriveBits'])
    const bits = u8(
      await subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: unhex('000102030405060708090a0b0c'),
          info: unhex('f0f1f2f3f4f5f6f7f8f9')
        },
        key,
        42 * 8
      )
    )
    expect(bits.length === 42, `derived ${bits.length} bytes, wanted 42`)
    expect(
      hex(bits) === '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      `HKDF-SHA256 disagrees with RFC 5869: ${hex(bits).slice(0, 16)}…`
    )
  },

  'Ed25519: generateKey': async subtle => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    expect(pair?.privateKey !== undefined && pair?.publicKey !== undefined, 'no key pair came back')
  },

  'Ed25519: sign and verify': async subtle => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const signature = await subtle.sign('Ed25519', pair.privateKey, utf8('key package'))
    expect(await subtle.verify('Ed25519', pair.publicKey, signature, utf8('key package')), 'own signature rejected')
    const bad = u8(signature)
    bad[0] ^= 1
    expect(!(await subtle.verify('Ed25519', pair.publicKey, bad, utf8('key package'))), 'tampered signature accepted')
  },

  'Ed25519: pkcs8 round-trip': async subtle => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey)
    const again = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign'])
    const a = u8(await subtle.sign('Ed25519', pair.privateKey, utf8('same')))
    const b = u8(await subtle.sign('Ed25519', again, utf8('same')))
    expect(same(a, b), 'the reimported key signed differently')
  },

  'X25519: generateKey': async subtle => {
    const pair = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    expect(pair?.privateKey !== undefined, 'no key pair came back')
  },

  'X25519: deriveBits agrees both ways': async subtle => {
    const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const theirs = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const a = u8(await subtle.deriveBits({ name: 'X25519', public: theirs.publicKey }, ours.privateKey, 256))
    const b = u8(await subtle.deriveBits({ name: 'X25519', public: ours.publicKey }, theirs.privateKey, 256))
    expect(a.length === 32, `derived ${a.length} bytes`)
    expect(same(a, b), 'the two sides derived different secrets')
  },

  'X25519: raw and jwk round-trip': async subtle => {
    const pair = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const raw = await subtle.exportKey('raw', pair.publicKey)
    await subtle.importKey('raw', raw, 'X25519', true, [])

    // hpke serialises private keys through jwk, and a malformed base64url
    // here is what broke the P-256 path.
    const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
    expect(typeof jwk.d === 'string', 'jwk carried no private scalar')
    expect(/^[A-Za-z0-9_-]+$/.test(jwk.d as string), `jwk.d is not base64url: ${String(jwk.d).slice(0, 12)}…`)
    await subtle.importKey('jwk', jwk, 'X25519', true, ['deriveBits'])
  },

  'X25519: pkcs8 round-trip': async subtle => {
    const pair = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
    const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey)
    await subtle.importKey('pkcs8', pkcs8, 'X25519', true, ['deriveBits'])
  },

  'AES-GCM: encrypt and decrypt': async subtle => {
    const key = await subtle.importKey('raw', new Uint8Array(16).fill(3), { name: 'AES-GCM' }, true, [
      'encrypt',
      'decrypt'
    ])
    const iv = new Uint8Array(12).fill(4)
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8('aad') }, key, utf8('secret'))
    const opened = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8('aad') }, key, sealed)
    expect(same(u8(opened), utf8('secret')), 'decrypt did not return the plaintext')
  },

  'AES-GCM: refuses a wrong tag': async subtle => {
    const key = await subtle.importKey('raw', new Uint8Array(16).fill(3), { name: 'AES-GCM' }, true, [
      'encrypt',
      'decrypt'
    ])
    const iv = new Uint8Array(12).fill(4)
    const sealed = u8(await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8('secret')))
    sealed[sealed.length - 1] ^= 1
    let refused = false
    try {
      await subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)
    } catch {
      refused = true
    }
    expect(refused, 'a tampered ciphertext was accepted')
  }
}

/** Run every check, reporting all of them rather than stopping at the first. */
export async function checkWebCrypto(subtle: SubtleCrypto): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = []
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      await check(subtle)
      results.push({ name, ok: true })
    } catch (cause) {
      results.push({ name, ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return results
}

/** One line per failure, or a single line saying everything passed. */
export function formatConformance(results: ConformanceResult[]): string {
  const failed = results.filter(r => !r.ok)
  if (failed.length === 0) return `[Crypto Setup] WebCrypto conformance: all ${results.length} checks passed`
  return [
    `[Crypto Setup] WebCrypto conformance: ${failed.length}/${results.length} FAILED`,
    ...failed.map(r => `  ✗ ${r.name} — ${r.detail ?? 'failed'}`)
  ].join('\n')
}
