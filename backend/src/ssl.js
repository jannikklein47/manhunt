/**
 * SSL certificate reader.
 *
 * Loads the TLS certificate pair for HTTPS mode from disk. Deployment puts
 * the certificates under `/home/ubuntu/ssl/batterysync/` (mounted into the
 * container); locally the files simply don't exist and the server falls back
 * to plain HTTP.
 *
 * Configuration (environment variables):
 * - `SSL_DIR`  directory holding the pair   (default: `/etc/manhunt/ssl`)
 * - `SSL_CERT` certificate file name        (default: `fullchain.pem`)
 * - `SSL_KEY`  private key file name        (default: `privkey.pem`)
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export function readSslCredentials(env = process.env) {
  const dir = env.SSL_DIR || '/etc/manhunt/ssl'
  const certPath = path.join(dir, env.SSL_CERT || 'fullchain.pem')
  const keyPath = path.join(dir, env.SSL_KEY || 'privkey.pem')

  if (!existsSync(certPath) || !existsSync(keyPath)) return null
  try {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
  } catch (err) {
    console.warn(`[manhunt] SSL files exist but could not be read — falling back to HTTP: ${err.message}`)
    return null
  }
}
