import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANGLE_DEFINITIONS,
  getJointAngles,
  getJointAngles3D,
} from '../src/biomechanics/angle-calculations.mjs';
import { blendAnglesByView, SAGITTAL_ANGLE_KEYS } from '../src/biomechanics/view-orientation.mjs';
import { computeFrameAngles } from '../src/biomechanics/frame-angles.mjs';

const p2 = (x, y, visibility = 0.99) => ({ x, y, visibility, presence: 0.99 });
const p3 = (x, y, z = 0, visibility = 0.99) => ({ x, y, z, visibility, presence: 0.99 });

const def = key => ANGLE_DEFINITIONS.find(d => d.key === key);

// Exact, easily-recognised landmark triples (angle at the middle point).
const A2_90 = [p2(0.5, 0.2), p2(0.5, 0.5), p2(0.8, 0.5)];
const A2_180 = [p2(0.5, 0.2), p2(0.5, 0.5), p2(0.5, 0.8)];
const A3_90 = [p3(0, 1, 0), p3(0, 0, 0), p3(1, 0, 0)];
const A3_180 = [p3(0, 1, 0), p3(0, 0, 0), p3(0, -1, 0)];
const A3_0 = [p3(1, 0, 0), p3(0, 0, 0), p3(2, 0, 0)]; // collinear, same side: 0°
const DEGENERATE_2D = [p2(0.5, 0.5), p2(0.5, 0.5), p2(0.5, 0.5)];
const DEGENERATE_3D = [p3(0, 0, 0), p3(0, 0, 0), p3(0, 0, 0)];

// Full 33-point poses; only `key`'s triple is non-degenerate.
function pose2D(key, triple) {
  const pts = Array.from({ length: 33 }, () => p2(0.5, 0.5));
  const d = def(key);
  pts[d.from] = triple[0];
  pts[d.joint] = triple[1];
  pts[d.to] = triple[2];
  return pts;
}
function pose3D(key, triple) {
  const pts = Array.from({ length: 33 }, () => p3(0, 0, 0));
  const d = def(key);
  pts[d.from] = triple[0];
  pts[d.joint] = triple[1];
  pts[d.to] = triple[2];
  return pts;
}

// Mixed-quality poses so every joint, source and fallback path is exercised.
const chaos2D = () => Array.from({ length: 33 }, (_, i) =>
  p2(((i * 37) % 100) / 100 + 0.001 * (i % 7), ((i * 61) % 100) / 100, i % 3 === 0 ? 0.4 : 0.99));
const chaos3D = () => Array.from({ length: 33 }, (_, i) =>
  p3(((i * 37) % 20) / 10 - 1, ((i * 61) % 20) / 10 - 1, ((i * 23) % 10) / 10, i % 4 === 0 ? 0.3 : 0.99));

const ARGS = { width: 1000, height: 1000, threshold: 0.55 };

// The pre-extraction selection from processFrame, kept verbatim as the numeric oracle.
function legacyFrameAngles({ landmarks, worldLandmarks, width, height, threshold, mode, view }) {
  const angles2D = getJointAngles(landmarks, width, height, threshold);
  let angles = angles2D;
  if (mode !== '2d' && worldLandmarks) {
    const angles3D = getJointAngles3D(worldLandmarks, threshold);
    if (mode === 'auto') {
      angles = blendAnglesByView(angles2D, angles3D, view);
    } else {
      angles = { ...angles2D };
      for (const [k, v] of Object.entries(angles3D)) {
        if (Number.isFinite(v)) angles[k] = v;
      }
    }
  }
  return angles;
}

test('sources cover every angle key', () => {
  const { sources } = computeFrameAngles({
    landmarks: chaos2D(), worldLandmarks: chaos3D(), ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.deepEqual(
    Object.keys(sources).sort(),
    ANGLE_DEFINITIONS.map(d => d.key).sort(),
  );
});

test('mode 2d uses image angles and ignores world landmarks', () => {
  const landmarks = pose2D('leftKnee', A2_90);
  const worldLandmarks = pose3D('leftKnee', A3_180);
  const { angles, sources } = computeFrameAngles({
    landmarks, worldLandmarks, ...ARGS, mode: '2d', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(angles.leftKnee, 90);
  assert.equal(sources.leftKnee, '2d');
  assert.deepEqual(angles, getJointAngles(landmarks, ARGS.width, ARGS.height, ARGS.threshold));
});

test('mode 3d prefers finite world angles and reports them as 3d', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', A3_180),
    ...ARGS, mode: '3d', view: null,
  });
  assert.equal(angles.leftKnee, 180);
  assert.equal(sources.leftKnee, '3d');
});

test('mode 3d falls back to the 2D angle when the world angle is null', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', DEGENERATE_3D),
    ...ARGS, mode: '3d', view: null,
  });
  assert.equal(angles.leftKnee, 90);
  assert.equal(sources.leftKnee, '2d');
});

test('mode 3d preserves a zero world angle instead of falling back to 2D', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', A3_0),
    ...ARGS, mode: '3d', view: null,
  });
  assert.equal(angles.leftKnee, 0);
  assert.equal(sources.leftKnee, '3d');
});

test('auto mode blends 2D and 3D for sagittal joints and reports blend', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', A3_180),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(angles.leftKnee, 135);
  assert.equal(sources.leftKnee, 'blend');
});

test('auto mode weight 1 or 0 counts as a single source', () => {
  const landmarks = pose2D('leftKnee', A2_90);
  const worldLandmarks = pose3D('leftKnee', A3_180);
  const side = computeFrameAngles({
    landmarks, worldLandmarks, ...ARGS, mode: 'auto', view: { sagittal2DWeight: 1 },
  });
  assert.equal(side.angles.leftKnee, 90);
  assert.equal(side.sources.leftKnee, '2d');

  const front = computeFrameAngles({
    landmarks, worldLandmarks, ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0 },
  });
  assert.equal(front.angles.leftKnee, 180);
  assert.equal(front.sources.leftKnee, '3d');
});

test('auto mode keeps non-sagittal joints on the 3D measurement', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftElbow', A2_90),
    worldLandmarks: pose3D('leftElbow', A3_180),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 1 },
  });
  assert.equal(angles.leftElbow, 180);
  assert.equal(sources.leftElbow, '3d');
});

test('auto mode preserves a zero angle from its single finite source', () => {
  const { angles, sources } = computeFrameAngles({
    landmarks: pose2D('leftKnee', DEGENERATE_2D),
    worldLandmarks: pose3D('leftKnee', A3_0),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 1 },
  });
  assert.equal(angles.leftKnee, 0);
  assert.equal(sources.leftKnee, '3d');
});

test('auto mode reports the actual fallback source when one measurement is missing', () => {
  const only2D = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', DEGENERATE_3D),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(only2D.angles.leftKnee, 90);
  assert.equal(only2D.sources.leftKnee, '2d');

  const only3D = computeFrameAngles({
    landmarks: pose2D('leftKnee', DEGENERATE_2D),
    worldLandmarks: pose3D('leftKnee', A3_180),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(only3D.angles.leftKnee, 180);
  assert.equal(only3D.sources.leftKnee, '3d');

  const neither = computeFrameAngles({
    landmarks: pose2D('leftKnee', DEGENERATE_2D),
    worldLandmarks: pose3D('leftKnee', DEGENERATE_3D),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(neither.angles.leftKnee, null);
  assert.equal(neither.sources.leftKnee, null);
});

test('null world landmarks fall back to 2D in every mode', () => {
  for (const mode of ['2d', '3d', 'auto']) {
    const { angles, sources } = computeFrameAngles({
      landmarks: pose2D('leftKnee', A2_90),
      worldLandmarks: null,
      ...ARGS, mode, view: { sagittal2DWeight: 0.5 },
    });
    assert.equal(angles.leftKnee, 90, mode);
    assert.equal(sources.leftKnee, '2d', mode);

    const none = computeFrameAngles({
      landmarks: pose2D('leftKnee', DEGENERATE_2D),
      worldLandmarks: null,
      ...ARGS, mode, view: null,
    });
    assert.equal(none.angles.leftKnee, null, mode);
    assert.equal(none.sources.leftKnee, null, mode);
  }
});

test('includeSources defaults to true and false skips the source map entirely', () => {
  const blended = computeFrameAngles({
    landmarks: pose2D('leftKnee', A2_90),
    worldLandmarks: pose3D('leftKnee', A3_180),
    ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 },
  });
  assert.equal(blended.sources.leftKnee, 'blend'); // default builds the map

  const args = { landmarks: chaos2D(), worldLandmarks: chaos3D(), ...ARGS, mode: 'auto', view: { sagittal2DWeight: 0.5 } };
  const lean = computeFrameAngles({ ...args, includeSources: false });
  assert.equal(lean.sources, null);
  assert.deepEqual(lean.angles, computeFrameAngles(args).angles);

  for (const mode of ['2d', '3d', 'auto']) {
    for (const worldLandmarks of [chaos3D(), null]) {
      const full = computeFrameAngles({ ...args, mode, worldLandmarks });
      const skipped = computeFrameAngles({ ...args, mode, worldLandmarks, includeSources: false });
      assert.equal(skipped.sources, null, mode);
      assert.deepEqual(skipped.angles, full.angles, mode);
    }
  }
});

test('numeric behavior matches the pre-extraction selection for all modes and views', () => {
  const poses = [
    { landmarks: pose2D('leftKnee', A2_90), worldLandmarks: pose3D('leftKnee', A3_180) },
    { landmarks: chaos2D(), worldLandmarks: chaos3D() },
    { landmarks: chaos2D(), worldLandmarks: null },
    { landmarks: pose2D('leftElbow', A2_180), worldLandmarks: pose3D('leftElbow', A3_0) },
  ];
  for (const mode of ['2d', '3d', 'auto']) {
    for (const view of [null, { sagittal2DWeight: 0 }, { sagittal2DWeight: 0.5 }, { sagittal2DWeight: 1 }]) {
      for (const [i, pose] of poses.entries()) {
        const args = { ...pose, ...ARGS, mode, view };
        assert.deepEqual(
          computeFrameAngles(args).angles,
          legacyFrameAngles(args),
          `mode=${mode} w=${view?.sagittal2DWeight} pose=${i}`,
        );
      }
    }
  }
});
