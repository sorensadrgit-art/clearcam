/**
 * Live frame joint-angle selection.
 *
 * Picks the measurement source per joint — 2D image angles, 3D world angles,
 * or a view-aware blend — mirroring the live processFrame selection exactly:
 * '2d' forces image angles, '3d' overrides with finite world angles (falling
 * back to 2D), and 'auto' blends sagittal joints by view while keeping other
 * joints on the 3D measurement. Null world landmarks fall back to 2D in
 * every mode. Zero-valued angles are real measurements, never "missing".
 */

import { ANGLE_DEFINITIONS, getJointAngles, getJointAngles3D } from './angle-calculations.mjs';
import { blendAnglesByView, SAGITTAL_ANGLE_KEYS } from './view-orientation.mjs';

const finite = v => Number.isFinite(v);

/** Source of the measurement actually selected for one joint: '2d' | '3d' | 'blend' | null. */
function sourceFor(key, a2, a3, mode, view) {
  if (mode === 'auto') {
    const w = SAGITTAL_ANGLE_KEYS.includes(key) ? (view?.sagittal2DWeight ?? 0) : 0;
    if (finite(a2) && finite(a3)) {
      // A weight of exactly 0 or 1 selects a single measurement; only in-between weights blend.
      if (w === 1) return '2d';
      if (w === 0) return '3d';
      return 'blend';
    }
    return finite(a3) ? '3d' : (finite(a2) ? '2d' : null);
  }
  // Forced 3D (and any other non-2d mode): 3D overrides where finite, 2D otherwise.
  return finite(a3) ? '3d' : (finite(a2) ? '2d' : null);
}

/**
 * Computes the live frame's joint angles and the measurement source behind each one.
 *
 * @param {Object} options
 * @param {Array|null} options.landmarks filtered 2D image landmarks
 * @param {Array|null} options.worldLandmarks filtered 3D world landmarks (null when unavailable)
 * @param {number} options.width video width in pixels
 * @param {number} options.height video height in pixels
 * @param {number} [options.threshold] landmark confidence threshold
 * @param {'auto'|'3d'|'2d'} [options.mode] angle dimension mode
 * @param {Object|null} [options.view] view estimate ({ sagittal2DWeight, ... }), used in 'auto'
 * @param {boolean} [options.includeSources] build the per-joint source map (hot path can skip it)
 * @returns {{ angles: Object, sources: Object<'2d'|'3d'|'blend'|null>|null }}
 */
export function computeFrameAngles({ landmarks, worldLandmarks, width, height, threshold, mode = 'auto', view = null, includeSources = true }) {
  const angles2D = getJointAngles(landmarks, width, height, threshold);

  if (mode === '2d' || !worldLandmarks) {
    return {
      angles: angles2D,
      sources: includeSources
        ? Object.fromEntries(ANGLE_DEFINITIONS.map(def => [
            def.key,
            finite(angles2D[def.key]) ? '2d' : null,
          ]))
        : null,
    };
  }

  const angles3D = getJointAngles3D(worldLandmarks, threshold);
  let angles;
  if (mode === 'auto') {
    angles = blendAnglesByView(angles2D, angles3D, view);
  } else {
    angles = { ...angles2D };
    for (const [k, v] of Object.entries(angles3D)) {
      if (finite(v)) angles[k] = v;
    }
  }

  return {
    angles,
    sources: includeSources
      ? Object.fromEntries(ANGLE_DEFINITIONS.map(def => [
          def.key,
          sourceFor(def.key, angles2D[def.key], angles3D[def.key], mode, view),
        ]))
      : null,
  };
}
