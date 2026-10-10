import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'

test('the unpacked extension identity stays pinned when archives are copied or updated', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
  const der = Buffer.from(manifest.key, 'base64')
  const publicKey = createPublicKey({ key: der, type: 'spki', format: 'der' })
  assert.equal(publicKey.asymmetricKeyType, 'rsa')
  const prefix = createHash('sha256').update(der).digest('hex').slice(0, 32)
  const id = [...prefix].map(value => String.fromCharCode(97 + parseInt(value, 16))).join('')
  assert.equal(id, 'oljjkibnelfpnchehckndlpbflhfooce', 'do not regenerate the key when packaging a new version')
})
