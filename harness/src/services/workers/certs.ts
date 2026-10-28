import * as x509 from '@peculiar/x509'

import { HttpError } from '../http-error.ts'

x509.cryptoProvider.set(crypto)

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const
const VALID_MS = 365 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

const newKeys = () => crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])

const exportKey = async (key: CryptoKey) =>
  x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY')

const positiveSerialNumber = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0]! &= 0x7f
  return Buffer.from(bytes).toString('hex')
}

export const createCsr = async (hostname: string) => {
  const keys = await newKeys()
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${hostname}`,
    keys,
    signingAlgorithm: ALGORITHM,
  })

  return { key: await exportKey(keys.privateKey), csr: csr.toString('pem') }
}

export const createCa = async ({ key, cert }: { key: string; cert: string }) => {
  const caCert = new x509.X509Certificate(cert)
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    x509.PemConverter.decodeFirst(key),
    { name: ALGORITHM.name, namedCurve: ALGORITHM.namedCurve },
    false,
    ['sign']
  )

  const issue = async (subject: string, publicKey: x509.PublicKey | CryptoKey, extensions: x509.Extension[]) => {
    const now = Date.now()
    const issued = await x509.X509CertificateGenerator.create({
      serialNumber: positiveSerialNumber(),
      subject,
      issuer: caCert.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + VALID_MS),
      publicKey,
      signingKey,
      signingAlgorithm: ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        ...extensions,
      ],
    })

    return issued.toString('pem')
  }

  return {
    signWorkerCsr: async (pem: string, hostname: string) => {
      const csr = new x509.Pkcs10CertificateRequest(pem)
      if (!(await csr.verify())) throw new HttpError(400, 'the CSR signature does not verify')
      if (csr.subject !== `CN=${hostname}`) throw new HttpError(400, `the CSR is not for ${hostname}`)

      return issue(csr.subject, csr.publicKey, [
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
      ])
    },

    issueServerCert: async () => {
      const keys = await newKeys()
      const cert = await issue('CN=server', keys.publicKey, [
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      ])

      return { key: await exportKey(keys.privateKey), cert }
    },
  }
}
