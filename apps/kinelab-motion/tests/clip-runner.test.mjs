/**
 * Regression tests for the paired-clip browser bench (bench/clip-runner.mjs):
 * paired actual model/delegate metadata, Adaptive subject-extent updates after a
 * tracked pose, pause-before-seek behavior, and cancellation / mismatched-delegate
 * cleanup. Fake video/runner doubles only — no DOM, network, or uploads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, CLOCK_LABEL } from '../bench/clip-runner.mjs';

// What the fake initialize() actually reports (a fallback below the preferred model).
const ACTUAL = { success: true, model: 'lite', delegate: 'CPU' };

function fakeVideo() {
  const listeners = new Map();
  const video = {
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    events: [],
    pause() {
      this.events.push('pause');
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    _t: 0,
  };
  Object.defineProperty(video, 'currentTime', {
    get() {
      return this._t;
    },
    set(v) {
      this.events.push('seek');
      this._t = v;
      const fired = [...(listeners.get('seeked') ?? [])];
      listeners.set('seeked', []);
      queueMicrotask(() => fired.forEach((fn) => fn()));
    },
  });
  return video;
}

/** Static tracked pose: left hip/knee/ankle give a ~90° knee. */
function fakeLandmarks() {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 })).map((p, i) => {
    if (i === 11) return { x: 0.5, y: 0.3, z: 0, visibility: 0.9 };
    if (i === 25) return { x: 0.5, y: 0.7, z: 0, visibility: 0.9 };
    if (i === 27) return { x: 0.3, y: 0.7, z: 0, visibility: 0.9 };
    return p;
  });
}

function makeFakeRunner(initResults, { onDetect } = {}) {
  const queue = Array.isArray(initResults) ? [...initResults] : [initResults];
  return {
    preferredModel: 'full',
    preset: null,
    extentCalls: [],
    detectCount: 0,
    closed: 0,
    setInferencePreset(preset) {
      this.preset = preset;
    },
    setSubjectExtent(extent) {
      this.extentCalls.push({ preset: this.preset, extent });
    },
    close() {
      this.closed++;
    },
    async initialize() {
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    detectForVideo() {
      this.detectCount++;
      onDetect?.(this.detectCount);
      return { landmarks: fakeLandmarks(), worldLandmarks: null };
    },
  };
}

function trialOptions(video, runner, extra = {}) {
  return {
    video,
    source: { name: 'clip.mp4' },
    durationSec: 0.2,
    sampleFps: 10,
    exerciseId: 'squat',
    syncOffsetSec: 0,
    syncConvention: '',
    makeRunner: () => runner,
    ...extra,
  };
}

/** Same extent rule the bench applies to filtered landmarks. */
function extentOf(landmarks) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of landmarks) {
    if (!p || !Number.isFinite(p.y) || (p.visibility ?? 1) < 0.55) continue;
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return hi > lo ? hi - lo : null;
}

test('paired export carries the actual model/delegate reported by initialize()', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner(ACTUAL);
  const { exportData } = await runTrial(trialOptions(video, runner));

  assert.equal(exportData.clock, CLOCK_LABEL);
  assert.deepEqual(exportData.order, { requested: 'adaptive-first', actual: ['adaptive', 'direct'] });
  assert.equal(exportData.angles.mode, 'auto');
  assert.deepEqual(exportData.runtime, { model: 'lite', delegate: 'CPU', matched: true });
  assert.deepEqual(exportData.schedule.frames, [
    { id: 0, mediaTimeSec: 0 },
    { id: 1, mediaTimeSec: 0.1 },
  ]);
  assert.equal(exportData.passes[0].preset, 'adaptive');
  assert.equal(exportData.passes[1].preset, 'direct');
  for (const pass of exportData.passes) {
    assert.equal(pass.model, 'lite'); // real fallback result, not the preferred model
    assert.equal(pass.delegate, 'CPU');
    assert.equal(pass.frames.length, 2);
  }
  // Frames are paired across passes on id and source media time.
  const [a, b] = exportData.passes.map((p) => p.frames.map((f) => [f.id, f.mediaTimeSec]));
  assert.deepEqual(a, b);
  // 2-frame passes are too short for the optional warmup summary.
  for (const pass of exportData.passes) assert.equal(pass.timing.summary, undefined);
  assert.equal(exportData.durations.summary, undefined);
});

test('adaptive pass updates subject extent from filtered landmarks after a tracked pose', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner(ACTUAL);
  const { exportData } = await runTrial(trialOptions(video, runner));

  const adaptive = exportData.passes.find((p) => p.preset === 'adaptive');
  const updates = runner.extentCalls.filter((e) => e.preset === 'adaptive' && e.extent !== null);
  assert.equal(updates.length, adaptive.frames.length, 'one extent update per sampled frame');
  for (const [i, frame] of adaptive.frames.entries()) {
    assert.ok(frame.landmarks, 'pose tracked');
    assert.ok(updates[i].extent > 0, 'extent is a real update after the pose');
    assert.equal(updates[i].extent, extentOf(frame.landmarks), 'extent matches the filtered landmarks');
  }
});

test('runTrial pauses the preview before the first seek', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner(ACTUAL);
  await runTrial(trialOptions(video, runner));

  assert.equal(video.events[0], 'pause');
  assert.ok(video.events.includes('seek'));
});

test('cancellation rejects the trial and closes the model', async () => {
  const video = fakeVideo();
  const controller = new AbortController();
  const runner = makeFakeRunner(ACTUAL, {
    onDetect: (n) => {
      if (n === 2) controller.abort(new Error('Cancelled'));
    },
  });

  await assert.rejects(
    () => runTrial(trialOptions(video, runner, { signal: controller.signal })),
    /Cancelled/,
  );
  assert.ok(runner.closed >= 2, 'model closed on cancellation');
});

test('a mismatched actual delegate rejects the trial and closes the model', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner([ACTUAL, { success: true, model: 'lite', delegate: 'GPU' }]);

  await assert.rejects(() => runTrial(trialOptions(video, runner)), /mismatch/);
  assert.ok(runner.closed >= 2, 'rejecting factory still closes the model');
});

test('records requested and actual pass order', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner(ACTUAL);
  const { exportData } = await runTrial(trialOptions(video, runner, { reverseOrder: true }));

  assert.equal(exportData.order.requested, 'direct-first');
  assert.deepEqual(exportData.order.actual, exportData.passes.map((p) => p.preset));
  assert.deepEqual(exportData.order.actual, ['direct', 'adaptive']);
});

test('timing is marked uncontrolled with warmup-excluded summaries and raw frame timings', async () => {
  const video = fakeVideo();
  const runner = makeFakeRunner(ACTUAL);
  const { exportData } = await runTrial(trialOptions(video, runner, { durationSec: 0.6 })); // 6 frames per pass

  assert.equal(exportData.durations.controlled, false);
  for (const pass of exportData.passes) {
    assert.equal(pass.frames.length, 6);
    for (const frame of pass.frames) {
      assert.ok(Number.isFinite(frame.inferenceMs) && Number.isFinite(frame.analysisMs), 'raw frame timings kept');
    }
    const summary = pass.timing.summary;
    assert.equal(summary.warmupExcluded, 3);
    assert.equal(summary.sampleCount, 3);
    assert.ok(summary.inferenceMsTotal <= pass.timing.inferenceMsTotal);
    assert.ok(summary.analysisMsTotal <= pass.timing.analysisMsTotal);
  }
  assert.equal(exportData.durations.summary.warmupExcluded, 6);
  assert.equal(exportData.durations.summary.sampleCount, 6);
});
