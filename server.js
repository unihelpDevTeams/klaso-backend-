import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { v2 as cloudinary } from 'cloudinary';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'tmp', 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/\s+/g, '-').toLowerCase();
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Klaso backend is running.' });
});

app.post('/api/upload-media', upload.single('file'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  try {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: req.body.folder || 'klaso/media',
      resource_type: 'auto',
    });

    fs.unlinkSync(file.path);

    return res.json({
      ok: true,
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
    });
  } catch (error) {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    return res.status(500).json({
      error: 'Cloudinary upload failed.',
      details: error.message,
    });
  }
});

app.delete('/api/delete-media', async (req, res) => {
  const { publicId, resourceType = 'image' } = req.body || {};

  if (!publicId) {
    return res.status(400).json({ error: 'publicId is required.' });
  }

  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({
      error: 'Cloudinary delete failed.',
      details: error.message,
    });
  }
});

app.post('/api/upload-lesson', upload.single('thumbnail'), async (req, res) => {
  const { title, description, hashtags, subject, level, duration, price } = req.body;

  if (!title || !description || !subject) {
    return res.status(400).json({ error: 'Title, description, and subject are required.' });
  }

  try {
    let thumbnailUrl = req.body.thumbnailUrl || null;
    let publicId = null;
    let resourceType = 'image';

    if (req.file) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: 'klaso/lessons',
        resource_type: 'auto',
      });

      thumbnailUrl = uploadResult.secure_url;
      publicId = uploadResult.public_id;
      resourceType = uploadResult.resource_type;

      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }

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
        thumbnailUrl,
        publicId,
        resourceType,
      },
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(500).json({
      error: 'Lesson upload failed.',
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});