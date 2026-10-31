import { randomUUID } from 'crypto';
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

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

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

async function storeInR2(file, folder) {
  const key = `${folder}/${randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
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

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Klaso backend is running.' });
});

app.post('/api/upload-media', upload.single('file'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  const folder = getUploadFolder(req.body.folder);
  if (!folder) {
    await removeTemporaryFile(file);
    return res.status(400).json({ error: 'Unsupported upload folder.' });
  }

  if (!requireR2Configuration(res)) {
    await removeTemporaryFile(file);
    return;
  }

  try {
    const result = await storeInR2(file, folder);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('R2 media upload failed:', error);
    return res.status(500).json({ error: 'Media upload failed.' });
  } finally {
    await removeTemporaryFile(file);
  }
});

app.delete('/api/delete-media', async (req, res) => {
  const key = req.body?.key;

  if (typeof key !== 'string' || !key.startsWith('klaso/') || key.includes('..')) {
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

app.post('/api/upload-lesson', upload.single('thumbnail'), async (req, res) => {
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
    const result = req.file ? await storeInR2(req.file, folder) : null;
    return res.json({
      ok: true,
      lesson: {
        title,
        description,
        hashtags: hashtags ? hashtags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
        subject,
        level: level || 'Beginner',
        duration: duration || '0:00',
        price: price || '0',
        thumbnailUrl: result?.url || req.body.thumbnailUrl || null,
        thumbnailKey: result?.key || null,
      },
    });
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
