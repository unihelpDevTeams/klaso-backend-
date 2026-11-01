import crypto from 'node:crypto';

const ENCRYPTION_VERSION = 1;

function deriveAccountKey(masterKey, purpose) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    masterKey,
    Buffer.alloc(0),
    Buffer.from(`klaso-bank-account:${purpose}`),
    32
  ));
}

export function normalizeBankList(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.banks)
      ? payload.banks
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.data?.banks)
          ? payload.data.banks
          : [];
  const uniqueBanks = new Map();

  for (const bank of entries) {
    if (!bank || typeof bank !== 'object' || bank.code == null || typeof bank.name !== 'string') {
      continue;
    }

    const code = String(bank.code).trim();
    const name = bank.name.trim();
    if (code && name && !uniqueBanks.has(code)) {
      uniqueBanks.set(code, { code, name, country: String(bank.country || 'NG').trim() || 'NG' });
    }
  }

  return [...uniqueBanks.values()];
}

export function parseFlutterwaveBankList(responseOk, payload) {
  if (!responseOk || payload?.status !== 'success') {
    const error = new Error(payload?.message || 'Flutterwave failed to return supported banks.');
    error.statusCode = 502;
    throw error;
  }

  const banks = normalizeBankList(payload);
  if (banks.length === 0) {
    const error = new Error('Flutterwave returned no supported banks.');
    error.statusCode = 502;
    throw error;
  }
  return banks;
}

export function getAccountHolderName(payload) {
  const account = payload?.data || payload?.account || payload;
  const name = account?.account_name || account?.accountName;
  return typeof name === 'string' ? name.trim() : '';
}

export function requireBankEncryptionKey(value) {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/i.test(value)) {
    const error = new Error('Bank account encryption is not configured. Set BANK_ACCOUNT_ENCRYPTION_KEY to a 32-byte hex key.');
    error.statusCode = 503;
    throw error;
  }

  return Buffer.from(value, 'hex');
}

export function encryptAccountNumber(accountNumber, key) {
  const initializationVector = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveAccountKey(key, 'encryption'),
    initializationVector
  );
  const ciphertext = Buffer.concat([
    cipher.update(String(accountNumber), 'utf8'),
    cipher.final(),
  ]);

  return {
    version: ENCRYPTION_VERSION,
    iv: initializationVector.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptAccountNumber(value, key) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || value.version !== ENCRYPTION_VERSION) {
    throw new Error('Saved bank account encryption format is unsupported.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveAccountKey(key, 'encryption'),
    Buffer.from(value.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function fingerprintAccountNumber(tutorId, bankCode, accountNumber, key) {
  return crypto
    .createHmac('sha256', deriveAccountKey(key, 'fingerprint'))
    .update(`${tutorId}\0${bankCode}\0${String(accountNumber).trim()}`)
    .digest('hex');
}

export function maskAccountNumber(accountNumber) {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  return digits.length > 4 ? `••••${digits.slice(-4)}` : '••••';
}

export function serializeBankAccount(id, account) {
  return {
    id,
    accountName: String(account.accountName || ''),
    bankName: String(account.bankName || ''),
    accountNumberMasked: String(account.accountNumberMasked || '••••'),
    isDefault: account.isDefault === true,
    isVerified: account.isVerified === true,
    country: String(account.country || 'NG'),
    currency: String(account.currency || 'NGN'),
    createdAt: typeof account.createdAt?.toMillis === 'function' ? account.createdAt : null,
  };
}

export function validateBankAccountInput(bankCode, accountNumber, banks, countryCode = 'NG') {
  const country = String(countryCode || 'NG').trim().toUpperCase();
  const normalizedBankCode = String(bankCode || '').trim();
  const normalizedAccountNumber = String(accountNumber || '').replace(/\D/g, '');

  if (country !== 'NG') {
    const error = new Error('Only Nigerian payout accounts are supported.');
    error.statusCode = 400;
    throw error;
  }
  if (!/^\d{10}$/.test(normalizedAccountNumber)) {
    const error = new Error('Enter a valid 10-digit Nigerian bank account number.');
    error.statusCode = 400;
    throw error;
  }

  const bank = banks.find((candidate) => candidate.code === normalizedBankCode);
  if (!bank) {
    const error = new Error('The selected bank code is not supported. Choose a bank from the list.');
    error.statusCode = 400;
    throw error;
  }

  return { bank, accountNumber: normalizedAccountNumber, country };
}