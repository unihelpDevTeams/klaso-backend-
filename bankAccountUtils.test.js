import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptAccountNumber,
  encryptAccountNumber,
  fingerprintAccountNumber,
  getAccountHolderName,
  maskAccountNumber,
  normalizeBankList,
  parseFlutterwaveBankList,
  requireBankEncryptionKey,
  serializeBankAccount,
  validateBankAccountInput,
} from './bankAccountUtils.js';

const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('normalizes bank arrays and filters invalid or duplicate records', () => {
  assert.deepEqual(normalizeBankList({ banks: [
    { code: 44, name: ' First Bank ' },
    { code: '44', name: 'Duplicate First Bank' },
    { code: '', name: 'Missing code' },
    { code: '999', name: '' },
    null,
  ] }), [{ code: '44', name: 'First Bank', country: 'NG' }]);
});

test('supports wrapped Flutterwave bank payloads', () => {
  assert.deepEqual(normalizeBankList({ data: { banks: [{ code: '044', name: 'First Bank' }] } }), [
    { code: '044', name: 'First Bank', country: 'NG' },
  ]);
});

test('extracts account names from Flutterwave responses', () => {
  assert.equal(getAccountHolderName({ data: { account_name: ' Account Holder ' } }), 'Account Holder');
  assert.equal(getAccountHolderName({ account: { accountName: 'Account Holder' } }), 'Account Holder');
  assert.equal(getAccountHolderName({ status: 'error' }), '');
});

test('encrypts account numbers and decrypts them for the transfer operation', () => {
  const encrypted = encryptAccountNumber('0123456789', requireBankEncryptionKey(testKey));
  assert.notEqual(encrypted.ciphertext, '0123456789');
  assert.equal(decryptAccountNumber(encrypted, requireBankEncryptionKey(testKey)), '0123456789');
  assert.equal(decryptAccountNumber('0123456789', requireBankEncryptionKey(testKey)), '0123456789');
});

test('fingerprints duplicate accounts deterministically without storing the account number', () => {
  const key = requireBankEncryptionKey(testKey);
  assert.equal(
    fingerprintAccountNumber('tutor-a', '044', '0123456789', key),
    fingerprintAccountNumber('tutor-a', '044', '0123456789', key)
  );
  assert.notEqual(
    fingerprintAccountNumber('tutor-a', '044', '0123456789', key),
    fingerprintAccountNumber('tutor-b', '044', '0123456789', key)
  );
});

test('masks account numbers and serializes only safe fields', () => {
  assert.equal(maskAccountNumber('0123456789'), '••••6789');
  assert.equal(maskAccountNumber('1234'), '••••');
  const account = serializeBankAccount('account-id', {
    bankCode: '044',
    accountNumberEncrypted: { ciphertext: 'secret' },
    accountNumber: '0123456789',
    accountNumberMasked: '••••6789',
    bankName: 'First Bank',
    accountName: 'Account Holder',
  });
  assert.equal(account.accountNumberMasked, '••••6789');
  assert.equal('accountNumber' in account, false);
  assert.equal('accountNumberEncrypted' in account, false);
  assert.equal('bankCode' in account, false);
});

test('rejects invalid encryption keys', () => {
  assert.throws(() => requireBankEncryptionKey('not-a-key'), /BANK_ACCOUNT_ENCRYPTION_KEY/);
});

test('validates bank code, country, and Nigerian account number before resolution', () => {
  const banks = [{ code: '044', name: 'First Bank', country: 'NG' }];
  assert.deepEqual(validateBankAccountInput('044', '0123456789', banks), {
    bank: banks[0],
    accountNumber: '0123456789',
    country: 'NG',
  });
  assert.throws(() => validateBankAccountInput('invalid', '0123456789', banks), /bank code/);
  assert.throws(() => validateBankAccountInput('044', '123', banks), /10-digit/);
  assert.throws(() => validateBankAccountInput('044', '0123456789', banks, 'GH'), /Only Nigerian/);
});

test('rejects Flutterwave errors and empty or malformed bank responses instead of returning an empty list', () => {
  assert.throws(
    () => parseFlutterwaveBankList(true, { status: 'error', message: 'Invalid key' }),
    /Invalid key/
  );
  assert.throws(() => parseFlutterwaveBankList(true, { status: 'success', data: [] }), /no supported banks/);
  assert.throws(() => parseFlutterwaveBankList(false, { status: 'success', data: [] }), /supported banks/);
  assert.deepEqual(parseFlutterwaveBankList(true, {
    status: 'success',
    data: [{ code: '044', name: 'First Bank' }],
  }), [{ code: '044', name: 'First Bank', country: 'NG' }]);
});