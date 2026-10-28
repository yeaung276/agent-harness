import * as x509 from '@peculiar/x509'

x509.cryptoProvider.set(crypto)

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const

export const createTestCa = async () => {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=worker-ca',
    keys,
    signingAlgorithm: ALGORITHM,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  })

  return {
    key: x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'),
    cert: cert.toString('pem'),
  }
}
