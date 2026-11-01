export function collectOwnedTutorialMediaKeys(courseData, lessonDataList, tutorId, publicUrl) {
  const allowedPrefixes = [
    `klaso/lessons/${tutorId}/`,
    `klaso/media/${tutorId}/`,
  ];
  const mediaKeys = new Set();

  const addKey = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const key = value.trim();
    if (
      key.includes('..')
      || key.includes('\\')
      || !allowedPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      throw new Error('A tutorial references media that is not owned by this tutor.');
    }
    mediaKeys.add(key);
  };

  const addUrl = (value) => {
    if (typeof value !== 'string' || !value.trim() || !publicUrl) return;

    let mediaUrl;
    let configuredPublicUrl;
    try {
      mediaUrl = new URL(value);
      configuredPublicUrl = new URL(publicUrl);
    } catch {
      return;
    }
    if (mediaUrl.origin !== configuredPublicUrl.origin) return;

    const basePath = configuredPublicUrl.pathname.replace(/\/+$/, '');
    if (basePath && !mediaUrl.pathname.startsWith(`${basePath}/`)) {
      throw new Error('A tutorial references an invalid Cloudflare R2 media URL.');
    }
    const encodedKey = basePath
      ? mediaUrl.pathname.slice(basePath.length + 1)
      : mediaUrl.pathname.replace(/^\/+/, '');
    let key;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      throw new Error('A tutorial contains an invalid media URL.');
    }
    addKey(key);
  };

  const addAssets = (asset) => {
    if (!asset || typeof asset !== 'object') return;
    for (const keyField of ['videoKey', 'thumbnailKey']) addKey(asset[keyField]);
    for (const urlField of ['videoUrl', 'thumbnailUrl', 'image', 'imageUrl']) addUrl(asset[urlField]);
  };

  addAssets(courseData);
  if (Array.isArray(courseData?.curriculum)) courseData.curriculum.forEach(addAssets);
  if (Array.isArray(lessonDataList)) lessonDataList.forEach(addAssets);
  return [...mediaKeys];
}