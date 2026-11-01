import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOwnedTutorialMediaKeys } from './tutorialDeletionUtils.js';

const publicUrl = 'https://media.example.test';

test('collects and deduplicates all course, curriculum, and lesson R2 assets', () => {
  const keys = collectOwnedTutorialMediaKeys({
    videoKey: 'klaso/lessons/tutor-1/course-video.mp4',
    thumbnailUrl: `${publicUrl}/klaso/lessons/tutor-1/course-thumb.jpg`,
    curriculum: [{ videoKey: 'klaso/media/tutor-1/module.mp4' }],
  }, [{
    videoKey: 'klaso/lessons/tutor-1/course-video.mp4',
    thumbnailKey: 'klaso/lessons/tutor-1/lesson-thumb.jpg',
  }], 'tutor-1', publicUrl);

  assert.deepEqual(keys.sort(), [
    'klaso/lessons/tutor-1/course-thumb.jpg',
    'klaso/lessons/tutor-1/course-video.mp4',
    'klaso/lessons/tutor-1/lesson-thumb.jpg',
    'klaso/media/tutor-1/module.mp4',
  ]);
});

test('ignores media hosted outside the configured R2 public origin', () => {
  assert.deepEqual(collectOwnedTutorialMediaKeys({
    videoUrl: 'https://external.example.test/lesson.mp4',
  }, [], 'tutor-1', publicUrl), []);
});

test('refuses media keys owned by a different tutor or unsafe paths', () => {
  assert.throws(() => collectOwnedTutorialMediaKeys({
    videoKey: 'klaso/lessons/another-tutor/lesson.mp4',
  }, [], 'tutor-1', publicUrl), /not owned by this tutor/);
  assert.throws(() => collectOwnedTutorialMediaKeys({
    videoKey: 'klaso/lessons/tutor-1/../other/file.mp4',
  }, [], 'tutor-1', publicUrl), /not owned by this tutor/);
});

test('rejects same-origin R2 URLs outside the configured base path', () => {
  assert.throws(() => collectOwnedTutorialMediaKeys({
    videoUrl: `${publicUrl}/other-bucket/video.mp4`,
  }, [], 'tutor-1', `${publicUrl}/bucket`), /invalid Cloudflare R2 media URL/);
});