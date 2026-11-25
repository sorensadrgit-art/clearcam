const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function subjectBounds(landmarks, threshold) {
  if (!landmarks) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  let torsoPoints = 0;
  for (const [index, point] of landmarks.entries()) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        Math.min(point.visibility ?? 1, point.presence ?? 1) < threshold) continue;
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
    if ([11, 12, 23, 24].includes(index)) torsoPoints++;
  }
  return bottom > top ? { left, right, top, bottom, torsoPoints } : null;
}

// Coordinates refer to the uncropped video. Only the display layer follows the subject.
export function followTransform(bounds, videoAspect, stageAspect, mirrored) {
  if (!bounds || bounds.torsoPoints < 2 || !(videoAspect > 0 && stageAspect > 0)) return null;
  const { left, right, top, bottom } = bounds;
  const zoom = clamp(0.80 / Math.max(right - left, bottom - top), 1, 2);
  const halfTravel = (zoom - 1) / 2;
  // object-fit: contain can letterbox on either axis.
  const width = Math.min(1, videoAspect / stageAspect);
  const height = Math.min(1, stageAspect / videoAspect);
  const x = (0.5 - (left + right) / 2) * (mirrored ? -1 : 1);
  const y = 0.5 - (top + bottom) / 2;
  const dx = 100 * width * clamp(x * zoom, -halfTravel, halfTravel);
  const dy = 100 * height * clamp(y * zoom, -halfTravel, halfTravel);
  return `translate(${dx.toFixed(2)}%, ${dy.toFixed(2)}%) scale(${zoom.toFixed(3)})`;
}
