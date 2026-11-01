import crypto, { randomUUID } from 'crypto';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'tmp', 'uploads');
const maxFileSize = 500 * 1024 * 1024;
const allowedFolders = new Set(['klaso/lessons', 'klaso/profiles', 'klaso/media']);

fs.mkdirSync(uploadsDir, { recursive: true });

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined,
  credentials:
    process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const requiredR2Settings = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
];
const firebaseAdminApp = getApps()[0] || initializeApp({
  credential: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
    : applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || undefined,
});
const firebaseAuth = getAdminAuth(firebaseAdminApp);
const firebaseDb = getFirestore(firebaseAdminApp);

function getConfiguredAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/x-m4v',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: maxFileSize },
  fileFilter: (_req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(new Error('Unsupported file type. Upload an image or supported video.'));
  },
});

const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';
const TUTOR_SHARE_RATE = 0.8;
const KLASO_COMMISSION_RATE = 0.2;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

function parseMoney(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return Number(numericValue.toFixed(2));
}

function getTransactionDocRef(txRef) {
  return firebaseDb.collection('transactions').doc(`tx_${String(txRef || '').trim()}`);
}

function getPurchaseDocRef(txRef) {
  return firebaseDb.collection('purchases').doc(`purchase_${String(txRef || '').trim()}`);
}

function getTimestampMillis(value) {
  if (typeof value?.toMillis === 'function') {
    return value.toMillis();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortWalletTransactions(documents) {
  return documents
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .sort((left, right) => getTimestampMillis(right.createdAt) - getTimestampMillis(left.createdAt));
}

function generateTxRef(prefix = 'KLS') {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `${prefix}_${Date.now()}_${suffix}`;
}

async function verifyFlutterwaveChecksum(rawBody, headerSignature) {
  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash || !headerSignature) {
    return !headerSignature && !secretHash;
  }

  const expectedHash = crypto
    .createHmac('sha256', secretHash)
    .update(rawBody)
    .digest('hex');

  const actual = Buffer.from(String(headerSignature));
  const expected = Buffer.from(expectedHash);
  if (actual.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}

async function verifyFlutterwavePaymentReference(txRef) {
  const authorization = `Bearer ${process.env.FLW_SECRET_KEY}`;
  const response = await fetch(`${FLUTTERWAVE_BASE_URL}/transactions/verify/${encodeURIComponent(txRef)}`, {
    method: 'GET',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Flutterwave verification failed: ${errorText}`);
  }

  const result = await response.json();
  if (!result || result.status !== 'success') {
    throw new Error(result?.message || 'Flutterwave verification returned an unsuccessful response.');
  }

  return result.data || null;
}

async function ensureCourseAccess(studentId, tutorialId) {
  if (!studentId || !tutorialId) return false;

  const purchaseSnapshot = await firebaseDb
    .collection('purchases')
    .where('studentId', '==', studentId)
    .where('tutorialId', '==', tutorialId)
    .limit(1)
    .get();

  if (!purchaseSnapshot.empty) return true;

  const enrollmentSnapshot = await firebaseDb
    .collection('enrollments')
    .where('userId', '==', studentId)
    .where('courseId', '==', tutorialId)
    .limit(1)
    .get();

  return !enrollmentSnapshot.empty;
}

async function buildTutorWalletSnapshot(tutorId) {
  if (!tutorId) {
    return {
      totalEarnings: 0,
      availableBalance: 0,
      pendingBalance: 0,
      withdrawnAmount: 0,
    };
  }

  const walletSnap = await firebaseDb.collection('tutorWallets').doc(tutorId).get();
  if (!walletSnap.exists) {
    return {
      totalEarnings: 0,
      availableBalance: 0,
      pendingBalance: 0,
      withdrawnAmount: 0,
    };
  }

  const walletData = walletSnap.data() || {};
  return {
    totalEarnings: Number(walletData.totalEarnings || 0),
    availableBalance: Number(walletData.availableBalance || 0),
    pendingBalance: Number(walletData.pendingBalance || 0),
    withdrawnAmount: Number(walletData.withdrawnAmount || 0),
  };
}

async function recordSuccessfulPurchase(transactionData, flutterwaveData) {
  const txRef = transactionData.txRef;
  const studentId = transactionData.studentId;
  const tutorialId = transactionData.tutorialId;
  const tutorId = transactionData.tutorId;
  const courseDoc = await firebaseDb.collection('courses').doc(tutorialId).get();
  const courseData = courseDoc.exists ? courseDoc.data() || {} : {};
  const amountPaid = Number(transactionData.amount);
  const commission = Number((amountPaid * KLASO_COMMISSION_RATE).toFixed(2));
  const tutorEarnings = Number((amountPaid * TUTOR_SHARE_RATE).toFixed(2));
  const transactionDocRef = getTransactionDocRef(txRef);
  const purchaseDocRef = getPurchaseDocRef(txRef);

  const existingPurchase = await purchaseDocRef.get();
  if (existingPurchase.exists) {
    await transactionDocRef.set({
      status: 'successful',
      flutterwaveTransactionId: flutterwaveData?.id ? String(flutterwaveData.id) : transactionData.flutterwaveTransactionId || '',
      verifiedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { alreadyProcessed: true, purchaseId: existingPurchase.id };
  }

  const purchasePayload = {
    purchaseId: purchaseDocRef.id,
    studentId,
    tutorId,
    tutorialId,
    amountPaid,
    commission,
    tutorEarnings,
    currency: transactionData.currency,
    transactionId: transactionDocRef.id,
    purchasedAt: FieldValue.serverTimestamp(),
    courseTitle: courseData.title || '',
    subject: courseData.subject || '',
  };

  const walletRef = firebaseDb.collection('tutorWallets').doc(tutorId || 'unknown-tutor');
  const enrollmentRef = firebaseDb.collection('enrollments').doc(`${studentId}_${tutorialId}`);

  await firebaseDb.runTransaction(async (transaction) => {
    const walletDoc = await transaction.get(walletRef);
    const walletData = walletDoc.exists ? walletDoc.data() || {} : {};
    const existingTotal = Number(walletData.totalEarnings || 0);
    const existingPending = Number(walletData.pendingBalance || 0);
    const existingAvailable = Number(walletData.availableBalance || 0);

    transaction.set(purchaseDocRef, purchasePayload, { merge: false });
    transaction.set(
      walletRef,
      {
        tutorId,
        totalEarnings: Number((existingTotal + tutorEarnings).toFixed(2)),
        availableBalance: Number((existingAvailable + tutorEarnings).toFixed(2)),
        pendingBalance: Number((existingPending + tutorEarnings).toFixed(2)),
        withdrawnAmount: Number(walletData.withdrawnAmount || 0),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      firebaseDb.collection('walletTransactions').doc(),
      {
        transactionId: randomUUID(),
        tutorId,
        type: 'sale',
        amount: Number(tutorEarnings.toFixed(2)),
        description: `Course sale: ${courseData.title || 'tutorial'}`,
        reference: purchaseDocRef.id,
        status: 'success',
        relatedPurchaseId: purchaseDocRef.id,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      enrollmentRef,
      {
        userId: studentId,
        courseId: tutorialId,
        tutorId,
        title: courseData.title || '',
        subject: courseData.subject || '',
        price: amountPaid,
        enrolledAt: FieldValue.serverTimestamp(),
        lastAccessedAt: FieldValue.serverTimestamp(),
        status: 'active',
      },
      { merge: true }
    );
    transaction.set(
      transactionDocRef,
      {
        status: 'successful',
        flutterwaveTransactionId: flutterwaveData?.id ? String(flutterwaveData.id) : transactionData.flutterwaveTransactionId || '',
        verifiedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { alreadyProcessed: false, purchaseId: purchaseDocRef.id };
}

async function finalizeTransactionByReference(txRef, userId) {
  const transactionDocRef = getTransactionDocRef(txRef);
  const transactionDoc = await transactionDocRef.get();

  if (!transactionDoc.exists) {
    throw new Error('Payment transaction not found.');
  }

  const transactionData = transactionDoc.data();
  if (transactionData.studentId !== userId) {
    throw new Error('This payment belongs to a different user.');
  }

  if (transactionData.status === 'successful' && transactionData.verifiedAt) {
    return {
      ok: true,
      verified: true,
      alreadyProcessed: true,
      status: 'successful',
    };
  }

  const flutterwaveData = await verifyFlutterwavePaymentReference(txRef);
  const txAmount = parseMoney(transactionData.amount);
  const verifiedAmount = Number(flutterwaveData.amount);
  const verifiedCurrency = String(flutterwaveData.currency || '').toUpperCase();
  const expectedCurrency = String(transactionData.currency || '').toUpperCase();

  if (!flutterwaveData || String(flutterwaveData.tx_ref) !== txRef) {
    throw new Error('The transaction reference does not match the payment record.');
  }

  if (!txAmount || verifiedAmount !== txAmount) {
    throw new Error('The transaction amount does not match the expected amount.');
  }

  if (verifiedCurrency !== expectedCurrency) {
    throw new Error('The transaction currency does not match the expected currency.');
  }

  if (String(flutterwaveData.status || '').toLowerCase() !== 'successful') {
    await transactionDocRef.set({
      status: 'failed',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw new Error('The payment is not complete yet.');
  }

  const result = await recordSuccessfulPurchase(transactionData, flutterwaveData);
  return {
    ok: true,
    verified: true,
    alreadyProcessed: result.alreadyProcessed,
    purchaseId: result.purchaseId,
    status: 'successful',
  };
}

function shouldRejectCourseAccess(data) {
  return !data || !String(data.title || '').trim();
}

function buildCurrencyFromRequest(req) {
  const requestedCurrency = String(req.body?.currency || 'NGN').trim().toUpperCase();
  return requestedCurrency || 'NGN';
}

async function getFinancialSettings() {
  const settingsDoc = await firebaseDb.collection('financialSettings').doc('default').get();
  const existing = settingsDoc.exists ? settingsDoc.data() || {} : {};
  return {
    commissionPercentage: Number(existing.commissionPercentage ?? 0.2),
    minimumWithdrawal: Number(existing.minimumWithdrawal ?? 2000),
    maximumWithdrawal: Number(existing.maximumWithdrawal ?? 0),
    withdrawalFee: Number(existing.withdrawalFee ?? 0),
    withdrawalEnabled: existing.withdrawalEnabled !== false,
    supportedCurrencies: Array.isArray(existing.supportedCurrencies) && existing.supportedCurrencies.length
      ? existing.supportedCurrencies
      : ['NGN'],
  };
}

async function ensureTutorWallet(tutorId) {
  if (!tutorId) return null;

  const walletRef = firebaseDb.collection('tutorWallets').doc(tutorId);
  const walletSnapshot = await walletRef.get();
  if (walletSnapshot.exists) {
    return walletSnapshot.data();
  }

  const initialWallet = {
    tutorId,
    totalEarnings: 0,
    availableBalance: 0,
    pendingBalance: 0,
    reservedBalance: 0,
    withdrawnAmount: 0,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await walletRef.set(initialWallet, { merge: true });
  return initialWallet;
}

async function createWalletTransaction({
  tutorId,
  type,
  amount,
  description,
  reference,
  status = 'success',
  relatedPurchaseId = null,
  relatedWithdrawalId = null,
}) {
  if (!tutorId) return null;

  const docRef = firebaseDb.collection('walletTransactions').doc();
  await docRef.set({
    transactionId: docRef.id,
    tutorId,
    type,
    amount: Number(amount || 0),
    description,
    reference: reference || docRef.id,
    status,
    relatedPurchaseId,
    relatedWithdrawalId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return docRef.id;
}

async function requireTutorAccess(req, res, next) {
  try {
    const userSnapshot = await firebaseDb.collection('users').doc(req.auth.uid).get();
    const userProfile = userSnapshot.data() || {};
    if (userProfile.role !== 'tutor' || userProfile.approved !== true) {
      return res.status(403).json({ error: 'Only approved tutors can access the wallet.' });
    }

    req.tutorProfile = userProfile;
    return next();
  } catch (error) {
    console.error('Unable to verify tutor wallet access:', error);
    return res.status(500).json({ error: 'Unable to verify tutor wallet access.' });
  }
}

function getBankListUrl(countryCode = 'NG') {
  return countryCode === 'NG' ? `${FLUTTERWAVE_BASE_URL}/banks/NG` : `${FLUTTERWAVE_BASE_URL}/banks/${countryCode}`;
}

function getTransferFee(amount, settings) {
  const baseFee = Number(settings.withdrawalFee || 0);
  if (baseFee <= 0) return 0;
  return Number(Math.min(baseFee, amount * 0.01).toFixed(2));
}

function maskAccountNumber(accountNumber) {
  const value = String(accountNumber || '').trim();
  if (!value) return '';
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

async function resolveFlutterwaveBankAccount(bankCode, accountNumber, countryCode = 'NG') {
  const response = await fetch(`${FLUTTERWAVE_BASE_URL}/accounts/resolve`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      account_number: String(accountNumber || '').trim(),
      account_bank: String(bankCode || '').trim(),
      country: String(countryCode || 'NG').trim(),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== 'success') {
    throw new Error(payload?.message || 'Unable to resolve the bank account from Flutterwave.');
  }

  return payload.data || {};
}

function getMissingR2Settings() {
  return requiredR2Settings.filter((setting) => !process.env[setting]);
}

function getUploadFolder(value) {
  const folder = value || 'klaso/media';
  return allowedFolders.has(folder) ? folder : null;
}

function getObjectUrl(key) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
}

async function storeInR2(file, folder, userId) {
  const key = `${folder}/${userId}/${randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
  const uploadTask = new Upload({
    client: r2Client,
    params: {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(file.path),
      ContentLength: file.size,
      ContentType: file.mimetype,
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });

  await uploadTask.done();

  return {
    url: getObjectUrl(key),
    key,
    resourceType: file.mimetype.startsWith('video/') ? 'video' : 'image',
    format: path.extname(file.originalname).slice(1).toLowerCase(),
  };
}

async function removeTemporaryFile(file) {
  if (!file) return;

  try {
    await fs.promises.unlink(file.path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Unable to remove temporary upload:', error);
    }
  }
}

function requireR2Configuration(res) {
  const missingSettings = getMissingR2Settings();
  if (missingSettings.length === 0) return true;

  console.error(`R2 upload configuration is missing: ${missingSettings.join(', ')}`);
  res.status(503).json({
    error: 'Media storage is not configured.',
    missingSettings,
  });
  return false;
}

async function authenticateFirebaseUser(req, res, next) {
  const authorization = req.get('authorization') || '';
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }

  try {
    req.auth = await firebaseAuth.verifyIdToken(tokenMatch[1]);
    return next();
  } catch {
    return res.status(401).json({ error: 'Authentication token is invalid or expired.' });
  }
}

async function requireLessonCreator(req, res, next) {
  if (req.auth.admin === true) return next();

  try {
    const userSnapshot = await firebaseDb.collection('users').doc(req.auth.uid).get();
    const userProfile = userSnapshot.data();
    if (userProfile?.role === 'tutor' && userProfile.approved === true) {
      return next();
    }

    return res.status(403).json({ error: 'Only verified tutors and admins can upload lessons.' });
  } catch (error) {
    console.error('Unable to verify lesson creator permissions:', error);
    return res.status(500).json({ error: 'Unable to verify lesson creator permissions.' });
  }
}

async function authorizeMediaFolder(req, res, next) {
  const folder = getUploadFolder(req.query.folder);
  if (!folder) {
    return res.status(400).json({ error: 'Unsupported upload folder.' });
  }

  if (folder === 'klaso/profiles' || req.auth.admin === true) {
    req.uploadFolder = folder;
    return next();
  }

  return requireLessonCreator(req, res, () => {
    req.uploadFolder = folder;
    return next();
  });
}

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Klaso backend is running.' });
});

app.post('/api/admin/verify', async (req, res) => {
  const authorization = req.get('authorization') || '';
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }

  let decodedToken;
  try {
    decodedToken = await firebaseAuth.verifyIdToken(tokenMatch[1]);
  } catch {
    return res.status(401).json({ error: 'Authentication token is invalid or expired.' });
  }

  try {
    const userRecord = await firebaseAuth.getUser(decodedToken.uid);
    const email = userRecord.email?.trim().toLowerCase();
    const isConfiguredAdmin =
      typeof email === 'string' && getConfiguredAdminEmails().includes(email);
    const isAdmin = isConfiguredAdmin && userRecord.emailVerified === true;
    const customClaims = { ...userRecord.customClaims };

    if (isAdmin) {
      customClaims.admin = true;
    } else {
      delete customClaims.admin;
    }

    if (Boolean(userRecord.customClaims?.admin) !== isAdmin) {
      await firebaseAuth.setCustomUserClaims(decodedToken.uid, customClaims);
    }

    return res.json({
      isAdmin,
      emailVerificationRequired: isConfiguredAdmin && !userRecord.emailVerified,
    });
  } catch (error) {
    console.error('Unable to verify configured admin access:', error);
    return res.status(500).json({ error: 'Unable to verify admin access.' });
  }
});

app.post('/api/payments/initialize', authenticateFirebaseUser, async (req, res) => {
  const tutorialId = String(req.body?.tutorialId || req.body?.courseId || '').trim();
  if (!tutorialId) {
    return res.status(400).json({ error: 'A valid tutorial ID is required.' });
  }

  try {
    const courseSnapshot = await firebaseDb.collection('courses').doc(tutorialId).get();
    if (!courseSnapshot.exists) {
      return res.status(404).json({ error: 'Tutorial not found.' });
    }

    const courseData = courseSnapshot.data() || {};
    const amount = parseMoney(courseData.price);
    if (!amount) {
      return res.status(400).json({ error: 'This tutorial has no valid price set yet.' });
    }

    const studentId = req.auth.uid;
    const purchaseQuery = await firebaseDb
      .collection('purchases')
      .where('studentId', '==', studentId)
      .where('tutorialId', '==', tutorialId)
      .limit(1)
      .get();

    if (!purchaseQuery.empty) {
      const existingPurchase = purchaseQuery.docs[0].data();
      return res.json({
        ok: true,
        alreadyPurchased: true,
        purchase: existingPurchase,
        redirectUrl: process.env.FLW_REDIRECT_URL || 'klaso://checkout',
      });
    }

    const txRef = generateTxRef('KLS');
    const transactionDocRef = getTransactionDocRef(txRef);
    const tutorId = String(courseData.createdBy || courseData.tutorId || courseData.tutor?.uid || '');
    const redirectUrl = process.env.FLW_REDIRECT_URL || 'klaso://checkout';
    const payload = {
      tx_ref: txRef,
      amount: Number(amount.toFixed(2)),
      currency: 'NGN',
      redirect_url: redirectUrl,
      payment_options: 'card,banktransfer,account,ussd',
      meta: {
        tutorialId,
        studentId,
        tutorId,
      },
      customer: {
        email: req.auth.email || 'student@klaso.app',
        name: req.auth.name || 'Klaso Student',
        phonenumber: req.auth.phone_number || '',
      },
      customizations: {
        title: 'Klaso Tutorial Purchase',
        description: `Payment for ${courseData.title || 'tutorial'}`,
        logo: 'https://placehold.co/200x200/16a34a/ffffff?text=Klaso',
      },
    };

    const flutterwaveResponse = await fetch(`${FLUTTERWAVE_BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const flutterwaveResult = await flutterwaveResponse.json();
    if (!flutterwaveResponse.ok || flutterwaveResult.status !== 'success') {
      console.error('Flutterwave initialization failed:', flutterwaveResult);
      return res.status(502).json({
        error: flutterwaveResult?.message || 'Unable to initialize payment with Flutterwave.',
      });
    }

    const paymentLink = flutterwaveResult.data?.link || flutterwaveResult.data?.checkout_url || null;
    if (!paymentLink) {
      return res.status(502).json({ error: 'Flutterwave did not return a valid checkout link.' });
    }

    await transactionDocRef.set({
      transactionId: transactionDocRef.id,
      txRef,
      studentId,
      tutorId,
      tutorialId,
      amount,
      currency: 'NGN',
      status: 'pending',
      flutterwaveTransactionId: flutterwaveResult.data?.id ? String(flutterwaveResult.data.id) : '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      verifiedAt: null,
      redirectUrl,
      paymentLink,
    }, { merge: false });

    return res.json({
      ok: true,
      transactionId: transactionDocRef.id,
      txRef,
      checkoutUrl: paymentLink,
      redirectUrl,
      amount,
      currency: 'NGN',
      status: 'pending',
    });
  } catch (error) {
    console.error('Unable to initialize payment:', error);
    return res.status(500).json({ error: 'Unable to initialize payment.' });
  }
});

app.get('/api/payments/verify', authenticateFirebaseUser, async (req, res) => {
  const txRef = String(req.query?.reference || req.query?.txRef || req.query?.tx_ref || '').trim();

  if (!txRef) {
    return res.status(400).json({ error: 'A valid transaction reference is required.' });
  }

  try {
    const verificationResult = await finalizeTransactionByReference(txRef, req.auth.uid);
    return res.json({
      ok: true,
      verified: verificationResult.verified,
      alreadyProcessed: Boolean(verificationResult.alreadyProcessed),
      status: verificationResult.status,
      txRef,
    });
  } catch (error) {
    console.error('Unable to verify payment:', error);
    return res.status(400).json({
      error: error.message || 'Unable to verify payment.',
      verified: false,
    });
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  const signature = req.get('verif-hash') || req.get('x-flw-signature') || '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  try {
    if (!signature) {
      return res.status(401).json({ error: 'Missing Flutterwave webhook signature.' });
    }

    const isValidSignature = await verifyFlutterwaveChecksum(rawBody, signature);
    if (!isValidSignature) {
      return res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
    }

    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    const eventPayload = payload?.data || payload;
    const txRef = String(eventPayload?.tx_ref || payload?.txRef || '').trim();
    const txStatus = String(eventPayload?.status || payload?.status || '').toLowerCase();

    if (!txRef) {
      return res.status(400).json({ error: 'Missing Flutterwave transaction reference.' });
    }

    const transactionDocRef = getTransactionDocRef(txRef);
    const transactionDoc = await transactionDocRef.get();
    if (!transactionDoc.exists) {
      return res.status(202).json({ ok: true, ignored: true, message: 'Unknown transaction accepted for audit.' });
    }

    const transactionData = transactionDoc.data();
    if (txStatus === 'successful' && transactionData.status !== 'successful') {
      await finalizeTransactionByReference(txRef, transactionData.studentId);
    } else if (txStatus === 'failed' || txStatus === 'cancelled') {
      await transactionDocRef.set({
        status: txStatus === 'cancelled' ? 'cancelled' : 'failed',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return res.status(200).json({ ok: true, processed: true, txRef });
  } catch (error) {
    console.error('Flutterwave webhook processing failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.get('/api/purchases/my-purchases', authenticateFirebaseUser, async (req, res) => {
  try {
    const purchaseSnapshot = await firebaseDb
      .collection('purchases')
      .where('studentId', '==', req.auth.uid)
      .orderBy('purchasedAt', 'desc')
      .get();

    return res.json({
      ok: true,
      purchases: purchaseSnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
        purchasedAt: docSnap.data().purchasedAt?.toDate?.() ? docSnap.data().purchasedAt.toDate().toISOString() : null,
      })),
    });
  } catch (error) {
    console.error('Unable to fetch purchases:', error);
    return res.status(500).json({ error: 'Unable to fetch your purchases.' });
  }
});

app.get('/api/purchases', authenticateFirebaseUser, async (req, res) => {
  const tutorialId = String(req.query?.tutorialId || req.query?.courseId || '').trim();

  if (!tutorialId) {
    const purchaseSnapshot = await firebaseDb
      .collection('purchases')
      .where('studentId', '==', req.auth.uid)
      .get();

    return res.json({
      ok: true,
      purchases: purchaseSnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })),
    });
  }

  try {
    const hasAccess = await ensureCourseAccess(req.auth.uid, tutorialId);
    return res.json({
      ok: true,
      tutorialId,
      hasAccess,
      purchased: hasAccess,
    });
  } catch (error) {
    console.error('Unable to verify tutorial access:', error);
    return res.status(500).json({ error: 'Unable to verify tutorial access.' });
  }
});

app.get('/api/tutor/insights', authenticateFirebaseUser, async (req, res) => {
  try {
    const userSnapshot = await firebaseDb.collection('users').doc(req.auth.uid).get();
    const userProfile = userSnapshot.data();
    if (userProfile?.role !== 'tutor' || userProfile.approved !== true) {
      return res.status(403).json({ error: 'Only verified tutors can view tutorial insights.' });
    }

    const courseSnapshot = await firebaseDb
      .collection('courses')
      .where('createdBy', '==', req.auth.uid)
      .get();
    const courses = await Promise.all(courseSnapshot.docs.map(async (courseDocument) => {
      const enrollmentSnapshot = await firebaseDb
        .collection('enrollments')
        .where('courseId', '==', courseDocument.id)
        .get();
      const course = courseDocument.data();

      return {
        id: courseDocument.id,
        title: course.title || '',
        subject: course.subject || '',
        level: course.level || '',
        rating: typeof course.rating === 'number' ? course.rating : null,
        enrollmentCount: enrollmentSnapshot.size,
      };
    }));

    const ratedCourses = courses.filter((course) => course.rating !== null);
    return res.json({
      courses,
      summary: {
        enrollments: courses.reduce((total, course) => total + course.enrollmentCount, 0),
        averageRating: ratedCourses.length
          ? ratedCourses.reduce((total, course) => total + course.rating, 0) / ratedCourses.length
          : null,
      },
    });
  } catch (error) {
    console.error('Unable to load tutor insights:', error);
    return res.status(500).json({ error: 'Unable to load tutor insights.' });
  }
});

app.get('/api/wallet', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  try {
    const wallet = await ensureTutorWallet(req.auth.uid);
    const walletTransactionsSnapshot = await firebaseDb
      .collection('walletTransactions')
      .where('tutorId', '==', req.auth.uid)
      .get();
    const walletTransactions = sortWalletTransactions(walletTransactionsSnapshot.docs).slice(0, 20);

    const summary = {
      totalEarnings: Number(wallet?.totalEarnings || 0),
      availableBalance: Number(wallet?.availableBalance || 0),
      pendingBalance: Number(wallet?.pendingBalance || 0),
      reservedBalance: Number(wallet?.reservedBalance || 0),
      withdrawnAmount: Number(wallet?.withdrawnAmount || 0),
      totalTutorialsSold: 0,
      lastTransactions: walletTransactions,
    };

    const purchasesSnapshot = await firebaseDb
      .collection('purchases')
      .where('tutorId', '==', req.auth.uid)
      .get();
    summary.totalTutorialsSold = purchasesSnapshot.size;

    return res.json({ ok: true, wallet: summary });
  } catch (error) {
    console.error('Unable to load tutor wallet summary:', error);
    return res.status(500).json({ error: 'Unable to load tutor wallet summary.' });
  }
});

app.get('/api/wallet/transactions', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  try {
    const snapshot = await firebaseDb
      .collection('walletTransactions')
      .where('tutorId', '==', req.auth.uid)
      .get();

    return res.json({
      ok: true,
      transactions: sortWalletTransactions(snapshot.docs),
    });
  } catch (error) {
    console.error('Unable to fetch wallet transactions:', error);
    return res.status(500).json({ error: 'Unable to fetch wallet transactions.' });
  }
});

app.get('/api/wallet/summary', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const wallet = await ensureTutorWallet(req.auth.uid);
  return res.json({
    ok: true,
    summary: {
      totalEarnings: Number(wallet?.totalEarnings || 0),
      availableBalance: Number(wallet?.availableBalance || 0),
      pendingBalance: Number(wallet?.pendingBalance || 0),
      reservedBalance: Number(wallet?.reservedBalance || 0),
      withdrawnAmount: Number(wallet?.withdrawnAmount || 0),
    },
  });
});

app.get('/api/wallet/banks', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  try {
    if (!process.env.FLW_SECRET_KEY) {
      return res.status(503).json({ error: 'Flutterwave is not configured on this server.' });
    }

    const response = await fetch(getBankListUrl('NG'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        Accept: 'application/json',
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message || 'Unable to load supported banks.');
    }

    const banks = Array.isArray(payload.data) ? payload.data : [];
    return res.json({
      ok: true,
      banks: banks.map((bank) => ({
        code: bank.code,
        name: bank.name,
        country: bank.country || 'NG',
      })),
    });
  } catch (error) {
    console.error('Unable to load Flutterwave banks:', error);
    return res.status(500).json({ error: 'Unable to load supported banks.' });
  }
});

app.post('/api/wallet/banks/resolve', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const { bankCode, accountNumber, country = 'NG' } = req.body || {};

  if (!bankCode || !accountNumber) {
    return res.status(400).json({ error: 'Bank code and account number are required.' });
  }

  try {
    const resolved = await resolveFlutterwaveBankAccount(bankCode, accountNumber, country);
    return res.json({
      ok: true,
      account: {
        bankCode,
        accountNumber: String(accountNumber).trim(),
        accountName: resolved.account_name || resolved.accountName || '',
        resolved: Boolean(resolved.account_name || resolved.accountName),
      },
    });
  } catch (error) {
    console.error('Unable to resolve bank account:', error);
    return res.status(400).json({ error: error.message || 'Unable to resolve the bank account.' });
  }
});

app.post('/api/wallet/bank-accounts', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const { bankCode, bankName, accountNumber, country = 'NG', currency = 'NGN', isDefault = false } = req.body || {};

  if (!bankCode || !bankName || !accountNumber) {
    return res.status(400).json({ error: 'Bank details are incomplete.' });
  }

  try {
    const resolved = await resolveFlutterwaveBankAccount(bankCode, accountNumber, country);
    const accountName = resolved.account_name || resolved.accountName || '';
    if (!accountName) {
      return res.status(400).json({ error: 'Unable to verify the bank account holder name.' });
    }

    const accountRef = firebaseDb.collection('tutorBankAccounts').doc();
    const payload = {
      bankAccountId: accountRef.id,
      tutorId: req.auth.uid,
      bankCode: String(bankCode).trim(),
      bankName: String(bankName).trim(),
      accountNumberEncrypted: String(accountNumber).trim(),
      accountName,
      country: String(country || 'NG').trim(),
      currency: String(currency || 'NGN').trim().toUpperCase(),
      isVerified: true,
      isDefault: Boolean(isDefault),
      accountNumberMasked: maskAccountNumber(accountNumber),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await accountRef.set(payload);

    if (Boolean(isDefault)) {
      const existingAccounts = await firebaseDb
        .collection('tutorBankAccounts')
        .where('tutorId', '==', req.auth.uid)
        .get();

      await Promise.all(
        existingAccounts.docs
          .filter((docSnap) => docSnap.id !== accountRef.id)
          .map((docSnap) => docSnap.ref.update({ isDefault: false, updatedAt: FieldValue.serverTimestamp() }))
      );
    }

    return res.json({ ok: true, account: payload });
  } catch (error) {
    console.error('Unable to save tutor bank account:', error);
    return res.status(400).json({ error: error.message || 'Unable to save the bank account.' });
  }
});

app.get('/api/wallet/bank-accounts', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const snapshot = await firebaseDb
    .collection('tutorBankAccounts')
    .where('tutorId', '==', req.auth.uid)
    .orderBy('createdAt', 'desc')
    .get();

  return res.json({
    ok: true,
    accounts: snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })),
  });
});

app.put('/api/wallet/bank-accounts/:id/default', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const accountId = req.params.id;
  const accountRef = firebaseDb.collection('tutorBankAccounts').doc(accountId);
  const accountSnap = await accountRef.get();

  if (!accountSnap.exists || accountSnap.data().tutorId !== req.auth.uid) {
    return res.status(404).json({ error: 'Bank account not found.' });
  }

  const existingAccounts = await firebaseDb
    .collection('tutorBankAccounts')
    .where('tutorId', '==', req.auth.uid)
    .get();

  await Promise.all(
    existingAccounts.docs.map((docSnap) => docSnap.ref.update({
      isDefault: docSnap.id === accountId,
      updatedAt: FieldValue.serverTimestamp(),
    }))
  );

  return res.json({ ok: true, accountId });
});

app.delete('/api/wallet/bank-accounts/:id', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const accountId = req.params.id;
  const accountRef = firebaseDb.collection('tutorBankAccounts').doc(accountId);
  const accountSnap = await accountRef.get();

  if (!accountSnap.exists || accountSnap.data().tutorId !== req.auth.uid) {
    return res.status(404).json({ error: 'Bank account not found.' });
  }

  await accountRef.delete();
  return res.json({ ok: true, deleted: true, accountId });
});

app.post('/api/wallet/withdraw', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const { amount, bankAccountId, currency = 'NGN' } = req.body || {};
  const numericAmount = Number(amount);
  const settings = await getFinancialSettings();

  if (!bankAccountId) {
    return res.status(400).json({ error: 'A bank account is required for the withdrawal.' });
  }

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Enter a valid withdrawal amount.' });
  }

  if (!settings.withdrawalEnabled) {
    return res.status(403).json({ error: 'Withdrawals are currently disabled.' });
  }

  if (numericAmount < settings.minimumWithdrawal) {
    return res.status(400).json({ error: `Minimum withdrawal is ${settings.minimumWithdrawal}.` });
  }

  const walletRef = firebaseDb.collection('tutorWallets').doc(req.auth.uid);
  const bankAccountRef = firebaseDb.collection('tutorBankAccounts').doc(bankAccountId);
  const bankSnap = await bankAccountRef.get();

  if (!bankSnap.exists || bankSnap.data().tutorId !== req.auth.uid || bankSnap.data().isVerified !== true) {
    return res.status(400).json({ error: 'The selected bank account is invalid or not verified.' });
  }

  const walletSnapshot = await walletRef.get();
  const walletData = walletSnapshot.exists ? walletSnapshot.data() || {} : { availableBalance: 0, pendingBalance: 0, reservedBalance: 0 };
  const availableBalance = Number(walletData.availableBalance || 0);
  const reservedBalance = Number(walletData.reservedBalance || 0);

  if (availableBalance < numericAmount) {
    return res.status(400).json({ error: 'Available balance is insufficient for this withdrawal.' });
  }

  const withdrawalRef = firebaseDb.collection('withdrawals').doc();
  const transferFee = getTransferFee(numericAmount, settings);
  const reference = `WDL_${Date.now()}_${randomUUID().slice(0, 8).toUpperCase()}`;

  try {
    const withdrawalPayload = {
      withdrawalId: withdrawalRef.id,
      tutorId: req.auth.uid,
      amount: Number(numericAmount.toFixed(2)),
      currency: String(currency || 'NGN').toUpperCase(),
      bankAccountId: bankAccountId,
      withdrawalReference: reference,
      flutterwaveTransferId: '',
      transferFee,
      status: 'pending',
      failureReason: '',
      requestedAt: FieldValue.serverTimestamp(),
      processedAt: null,
      completedAt: null,
    };

    await firebaseDb.runTransaction(async (transaction) => {
      const currentWallet = (await transaction.get(walletRef)).data() || {};
      const currentAvailable = Number(currentWallet.availableBalance || 0);
      const currentReserved = Number(currentWallet.reservedBalance || 0);

      if (currentAvailable < numericAmount) {
        throw new Error('Available balance is insufficient for this withdrawal.');
      }

      transaction.update(walletRef, {
        availableBalance: Number((currentAvailable - numericAmount).toFixed(2)),
        reservedBalance: Number((currentReserved + numericAmount).toFixed(2)),
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(withdrawalRef, withdrawalPayload, { merge: false });
      transaction.set(firebaseDb.collection('walletTransactions').doc(), {
        transactionId: randomUUID(),
        tutorId: req.auth.uid,
        type: 'withdrawal',
        amount: Number(numericAmount.toFixed(2)),
        description: 'Withdrawal requested',
        reference,
        status: 'pending',
        relatedWithdrawalId: withdrawalRef.id,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    const transferResponse = await fetch(`${FLUTTERWAVE_BASE_URL}/transfers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        account_bank: bankSnap.data().bankCode,
        account_number: String(bankSnap.data().accountNumberEncrypted || '').trim(),
        amount: Number(numericAmount.toFixed(2)),
        narration: 'Klaso tutor withdrawal',
        currency: String(currency || 'NGN').toUpperCase(),
        reference,
        debit_currency: String(currency || 'NGN').toUpperCase(),
      }),
    });

    const transferPayload = await transferResponse.json().catch(() => ({}));
    if (!transferResponse.ok || transferPayload.status !== 'success') {
      const walletReset = await walletRef.get();
      const walletDataReset = walletReset.data() || {};
      await firebaseDb.runTransaction(async (transaction) => {
        const latestWallet = (await transaction.get(walletRef)).data() || {};
        const latestAvailable = Number(latestWallet.availableBalance || 0);
        const latestReserved = Number(latestWallet.reservedBalance || 0);
        transaction.update(walletRef, {
          availableBalance: Number((latestAvailable + numericAmount).toFixed(2)),
          reservedBalance: Number((latestReserved - numericAmount).toFixed(2)),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(withdrawalRef, {
          status: 'failed',
          failureReason: transferPayload?.message || 'Flutterwave transfer could not be initiated.',
          processedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      return res.status(400).json({ error: transferPayload?.message || 'Unable to initiate the withdrawal transfer.' });
    }

    const transferId = transferPayload.data?.id || transferPayload.data?.transfer_reference || '';
    await withdrawalRef.update({
      flutterwaveTransferId: String(transferId),
      status: 'processing',
      processedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await createWalletTransaction({
      tutorId: req.auth.uid,
      type: 'withdrawal',
      amount: numericAmount,
      description: 'Withdrawal requested',
      reference,
      status: 'pending',
      relatedWithdrawalId: withdrawalRef.id,
    });

    return res.json({
      ok: true,
      withdrawal: {
        withdrawalId: withdrawalRef.id,
        withdrawalReference: reference,
        status: 'processing',
        amount: numericAmount,
        transferFee,
      },
    });
  } catch (error) {
    console.error('Unable to process withdrawal request:', error);
    return res.status(500).json({ error: error.message || 'Unable to process withdrawal request.' });
  }
});

app.get('/api/wallet/withdrawals', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const snapshot = await firebaseDb
    .collection('withdrawals')
    .where('tutorId', '==', req.auth.uid)
    .orderBy('requestedAt', 'desc')
    .get();

  return res.json({
    ok: true,
    withdrawals: snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })),
  });
});

app.get('/api/wallet/withdrawals/:id', authenticateFirebaseUser, requireTutorAccess, async (req, res) => {
  const docSnap = await firebaseDb.collection('withdrawals').doc(req.params.id).get();
  if (!docSnap.exists || docSnap.data().tutorId !== req.auth.uid) {
    return res.status(404).json({ error: 'Withdrawal not found.' });
  }

  return res.json({ ok: true, withdrawal: { id: docSnap.id, ...docSnap.data() } });
});

app.post('/api/payments/webhook', async (req, res) => {
  const signature = req.get('verif-hash') || req.get('x-flw-signature') || '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  try {
    if (!signature) {
      return res.status(401).json({ error: 'Missing Flutterwave webhook signature.' });
    }

    const isValidSignature = await verifyFlutterwaveChecksum(rawBody, signature);
    if (!isValidSignature) {
      return res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
    }

    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    const eventPayload = payload?.data || payload;
    const txRef = String(eventPayload?.tx_ref || payload?.txRef || '').trim();
    const txStatus = String(eventPayload?.status || payload?.status || '').toLowerCase();

    if (!txRef) {
      return res.status(400).json({ error: 'Missing Flutterwave transaction reference.' });
    }

    const transactionDocRef = getTransactionDocRef(txRef);
    const transactionDoc = await transactionDocRef.get();
    if (!transactionDoc.exists) {
      return res.status(202).json({ ok: true, ignored: true, message: 'Unknown transaction accepted for audit.' });
    }

    const transactionData = transactionDoc.data();
    if (txStatus === 'successful' && transactionData.status !== 'successful') {
      await finalizeTransactionByReference(txRef, transactionData.studentId);
    } else if (txStatus === 'failed' || txStatus === 'cancelled') {
      await transactionDocRef.set({
        status: txStatus === 'cancelled' ? 'cancelled' : 'failed',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return res.status(200).json({ ok: true, processed: true, txRef });
  } catch (error) {
    console.error('Flutterwave webhook processing failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.post(
  '/api/upload-media',
  authenticateFirebaseUser,
  authorizeMediaFolder,
  upload.single('file'),
  async (req, res) => {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    if (!requireR2Configuration(res)) {
      await removeTemporaryFile(file);
      return;
    }

    try {
      const result = await storeInR2(file, req.uploadFolder, req.auth.uid);
      return res.json({ ok: true, ...result });
    } catch (error) {
      console.error('R2 media upload failed:', error);
      return res.status(500).json({ error: 'Media upload failed.' });
    } finally {
      await removeTemporaryFile(file);
    }
  }
);

app.delete('/api/delete-media', authenticateFirebaseUser, async (req, res) => {
  const key = req.body?.key;

  const escapedUserId = req.auth.uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownedObjectPrefix = `^klaso/(lessons|profiles|media)/${escapedUserId}/`;
  const canDeleteObject =
    typeof key === 'string' &&
    !key.includes('..') &&
    (new RegExp(ownedObjectPrefix).test(key) || req.auth.admin === true);
  if (!canDeleteObject) {
    return res.status(400).json({ error: 'A valid R2 object key is required.' });
  }

  if (!requireR2Configuration(res)) return;

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      })
    );
    return res.json({ ok: true });
  } catch (error) {
    console.error('R2 media deletion failed:', error);
    return res.status(500).json({ error: 'Media deletion failed.' });
  }
});

app.post(
  '/api/upload-lesson',
  authenticateFirebaseUser,
  requireLessonCreator,
  upload.single('thumbnail'),
  async (req, res) => {
  const { title, description, hashtags, subject, level, duration, price } = req.body;

  if (!title || !description || !subject) {
    await removeTemporaryFile(req.file);
    return res.status(400).json({ error: 'Title, description, and subject are required.' });
  }

  if (req.file && !req.file.mimetype.startsWith('image/')) {
    await removeTemporaryFile(req.file);
    return res.status(400).json({ error: 'The lesson thumbnail must be an image.' });
  }

  if (!requireR2Configuration(res)) {
    await removeTemporaryFile(req.file);
    return;
  }

  const folder = getUploadFolder('klaso/lessons');

  try {
    const result = req.file ? await storeInR2(req.file, folder, req.auth.uid) : null;
    return res.json({
      ok: true,
      lesson: {
        title,
        description,
        hashtags: hashtags ? hashtags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
        subject,
        level: level || null,
        duration: duration || null,
        price: price || null,
        thumbnailUrl: result?.url || req.body.thumbnailUrl || null,
        thumbnailKey: result?.key || null,
      },
      }
    );
  } catch (error) {
    console.error('R2 lesson upload failed:', error);
    return res.status(500).json({ error: 'Lesson upload failed.' });
  } finally {
    await removeTemporaryFile(req.file);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 500 MB upload limit.' });
  }
  if (error instanceof Error && error.message.startsWith('Unsupported file type.')) {
    return res.status(415).json({ error: error.message });
  }

  console.error('Backend request failed:', error);
  return res.status(500).json({ error: 'Request failed.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
