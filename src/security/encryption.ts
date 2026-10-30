import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard for GCM
const KEY_LENGTH = 32; // 256 bits

/**
 * Retrieves or automatically initializes the master encryption key.
 * Stored in ENCRYPTION_KEY environment variable, or persisted securely in data/.key.
 */
function getMasterKey(): Buffer {
  if (process.env.ENCRYPTION_KEY) {
    const raw = process.env.ENCRYPTION_KEY.trim();
    if (raw.length === 64) {
      return Buffer.from(raw, 'hex');
    }
    // If not hex, hash it with SHA-256 to ensure exact 32-byte length
    return crypto.createHash('sha256').update(raw).digest();
  }

  // File fallback in data/.key
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const keyFile = path.join(dataDir, '.key');
  if (fs.existsSync(keyFile)) {
    const stored = fs.readFileSync(keyFile, 'utf-8').trim();
    return Buffer.from(stored, 'hex');
  }

  // Generate a new 256-bit cryptographically secure key
  const newKey = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyFile, newKey.toString('hex'), { mode: 0o600 });
  return newKey;
}

const MASTER_KEY = getMasterKey();

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 */
export function decrypt(encryptedPayload: string): string {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format. Expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}
