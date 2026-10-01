import crypto from 'crypto';

// Encryption for private data stored in the database (guest ID numbers,
// senior/PWD ID numbers, each property's PayMongo secret key).
// AES-256-GCM. The key is NOT in the database: it is the Vercel environment
// variable DATA_ENCRYPTION_KEY (64 hex letters, or 32 bytes in base64).
// A stored value looks like  enc:v1:<base64 of iv + tag + data>.
// Values that do not start with "enc:v1:" are older plain text and are
// returned as they are, so old records keep working.
// Lives in _lib so it adds no serverless function.

const PREFIX = 'enc:v1:';
let warned = false;

function getKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

export function encryptionReady() {
  return getKey() !== null;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Strict: refuses to run without a key. Use for secrets (payment keys).
export function encryptText(plain) {
  const key = getKey();
  if (!key) throw new Error('encryption_not_configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

// Soft: empty stays empty. Without a key it keeps the text plain (and logs a
// warning) so check-in never breaks. Use for ID numbers.
export function encryptSoft(plain) {
  if (plain === undefined || plain === null || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  if (!getKey()) {
    if (!warned) {
      warned = true;
      console.error('DATA_ENCRYPTION_KEY is not set: private data is being saved as plain text');
    }
    return plain;
  }
  return encryptText(plain);
}

// Strict decrypt: throws if the value cannot be opened.
export function decryptStrict(value) {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) throw new Error('encryption_not_configured');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (raw.length < 29) throw new Error('bad_ciphertext');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Soft decrypt for screens: plain text passes through; a value that cannot be
// opened (wrong or missing key) comes back as null instead of crashing.
export function decryptText(value) {
  if (value === undefined || value === null || value === '') return value;
  try {
    return decryptStrict(value);
  } catch (err) {
    console.error('decryptText failed', err && err.message);
    return null;
  }
}

// Returns a copy of the row with the listed fields decrypted.
export function decryptFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f]) out[f] = decryptText(out[f]);
  }
  return out;
}
