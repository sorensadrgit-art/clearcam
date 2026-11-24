/**
 * Paired-clip browser bench entry point — local files only, nothing is uploaded.
 *
 * Samples one clip twice (Adaptive and Direct, order configurable) via
 * runPairedClip(), with a
 * per-pass MediaPipeRunner reset and per-pass pose filters (PoseFilter,
 * WorldPoseFilter, KinematicBoneFilter, ViewOrientationEstimator), matching the
 * app pipeline. One paired JSON export:
 *
 *   - monotonic sampled IDs and source media times (clock label 'media'),
 *   - raw + filtered landmarks and world landmarks per frame,
 *   - selected angles and per-angle sources from computeFrameAngles() in
 *     ../src/biomechanics/frame-angles.mjs (exported angles are interior),
 *   - phase / reps / quality per frame plus per-pass rep summaries,
 *   - user-entered sync offset / convention metadata,
 *   - measured inference and analysis durations (combined across passes).
 *
 * Adaptive passes feed runner.setSubjectExtent() from filtered-landmark extent
 * exactly like the app. After initialize() the actual model/delegate of both
 * passes is compared and a mismatch rejects the trial before export. Cancelling
 * closes the model and revokes the local file URL once the run has settled.
 */

import { runPairedClip, MAX_FRAMES_PER_PASS } from './paired-clip.mjs';
import { MediaPipeRunner } from '../src/tracking/mediapipe-runner.mjs';
import { computeFrameAngles } from '../src/biomechanics/frame-angles.mjs';
import { ANGLE_DEFINITIONS, trackingStatus } from '../src/biomechanics/angle-calculations.mjs';
import { setAngleConvention, getAngleConvention } from '../src/biomechanics/angle-convention.mjs';
import { PoseFilter } from '../src/filters/pose-filter.mjs';
import { WorldPoseFilter } from '../src/filters/world-pose-filter.mjs';
import { KinematicBoneFilter } from '../src/filters/kinematic-filter.mjs';
import { ViewOrientationEstimator } from '../src/biomechanics/view-orientation.mjs';
import { defaultExerciseRegistry } from '../src/exercises/exercise-registry.mjs';
import { analyzeReps, summarizeSession } from '../src/exercises/rep-analysis.mjs';

export const BENCH_FORMAT = 'kinelab-motion.paired-clip-bench/1';
export const CLOCK_LABEL = 'media';
/** Convention of the exported angle values: computeFrameAngles returns interior angles. */
export const EXPORTED_ANGLE_CONVENTION = 'interior';
const CONFIDENCE_THRESHOLD = 0.55;
const ANGLE_MODE = 'auto'; // recorded in metadata; what computeFrameAngles runs
const WARMUP_FRAMES = 3; // excluded from the optional timing summaries
const ANGLE_KEYS = ANGLE_DEFINITIONS.map((def) => def.key);

/** Keep only the ANGLE_DEFINITIONS keys from computeFrameAngles' result. */
export function selectAngles(computed) {
  const source =
    computed && typeof computed === 'object' && computed.angles && typeof computed.angles === 'object'
      ? computed.angles
      : computed;
  const out = {};
  for (const key of ANGLE_KEYS) {
    const value = source ? source[key] : null;
    out[key] = Number.isFinite(value) ? value : null;
  }
  return out;
}

/** Plain-JSON landmarks; only fields the detector actually produced. */
function pickLandmarks(points) {
  if (!Array.isArray(points)) return null;
  return points.map((p) => {
    if (!p) return null; // recorded/filtered arrays may hold null slots
    const out = { x: p.x, y: p.y, z: p.z };
    if (Number.isFinite(p.visibility)) out.visibility = p.visibility;
    if (Number.isFinite(p.presence)) out.presence = p.presence;
    return out;
  });
}

/** Optional timing summary excluding the first `warmup` frames; null when none remain. */
function warmupSummary(frames, warmup, extraAnalysisMs = 0) {
  const kept = frames.slice(warmup);
  if (!kept.length) return null;
  let inferenceMsTotal = 0;
  let analysisMsTotal = extraAnalysisMs;
  for (const f of kept) {
    inferenceMsTotal += f.inferenceMs ?? 0;
    analysisMsTotal += f.analysisMs ?? 0;
  }
  return { warmupExcluded: warmup, sampleCount: kept.length, inferenceMsTotal, analysisMsTotal };
}

/** Vertical extent of the reliably detected body (same as the app's helper). */
function subjectExtent(landmarks, minVisibility) {
  if (!Array.isArray(landmarks)) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of landmarks) {
    if (!p || !Number.isFinite(p.y) || (p.visibility ?? 1) < minVisibility) continue;
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return hi > lo ? hi - lo : null;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Seek and settle at a media time. A same-time target resolves immediately only
 * when no seek is in flight (a pending seek has not settled at the target yet);
 * abort and media errors reject with full listener cleanup. Requires loaded clip data (readyState >= HAVE_CURRENT_DATA).
 */
export function seekTo(video, mediaTimeSec, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Cancelled'));
      return;
    }
    if (video.readyState < 2) {
      reject(new Error('Clip has no loaded data; cannot seek'));
      return;
    }
    if (video.currentTime === mediaTimeSec && !video.seeking) {
      resolve(); // same-time target with no seek in flight: already settled there
      return;
    }
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', onAbort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`Seek to ${mediaTimeSec}s failed (media error)`));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Cancelled'));
    };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    signal?.addEventListener('abort', onAbort);
    try {
      video.currentTime = mediaTimeSec;
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/** Pairing invariants: equal across passes, strictly monotonic ids and media times. */
export function verifyPaired(result) {
  const passes = result?.passes ?? [];
  if (passes.length !== 2) throw new Error('Trial rejected: expected exactly two passes');
  const [a, b] = passes;
  if (!a.frames.length) throw new Error('Trial rejected: no sampled frames');
  if (a.frames.length !== b.frames.length) throw new Error('Trial rejected: pass frame counts differ');
  let prevId = -Infinity;
  let prevTime = -Infinity;
  for (let i = 0; i < a.frames.length; i++) {
    const fa = a.frames[i];
    const fb = b.frames[i];
    if (fa.id !== fb.id || fa.mediaTimeSec !== fb.mediaTimeSec) {
      throw new Error(`Trial rejected: passes are not paired at frame ${i}`);
    }
    if (!(fa.id > prevId) || !(fa.mediaTimeSec > prevTime) || !Number.isFinite(fa.mediaTimeSec)) {
      throw new Error(`Trial rejected: sampled ids/media times not monotonic at frame ${i}`);
    }
    prevId = fa.id;
    prevTime = fa.mediaTimeSec;
  }
}

/** Actual model/delegate must match across the Adaptive/Direct passes. */
export function verifyRuntimeMatch(initRecords) {
  if (initRecords.length !== 2) throw new Error('Trial rejected: model/delegate not known for both passes');
  const [first, second] = initRecords;
  if (first.model !== second.model || first.delegate !== second.delegate) {
    throw new Error(
      `Trial rejected: actual model/delegate mismatch across passes ` +
        `(${first.preset}: ${first.model}/${first.delegate} vs ${second.preset}: ${second.model}/${second.delegate})`,
    );
  }
  return { model: first.model, delegate: first.delegate };
}

/**
 * Runs one paired trial over a loaded local clip.
 * @returns {Promise<{ exportData: Object, initRecords: Array }>}
 */
export async function runTrial({
  video,
  source,
  durationSec,
  sampleFps,
  exerciseId,
  syncOffsetSec,
  syncConvention,
  reverseOrder = false,
  signal,
  onStatus = () => {},
  makeRunner = () => new MediaPipeRunner({ preferredModel: 'full' }),
}) {
  const exercise = defaultExerciseRegistry.get(exerciseId);
  if (!exercise) throw new Error(`Unknown exercise: ${exerciseId}`);

  const runner = makeRunner();
  video.pause?.(); // pause the preview synchronously: a playing clip would advance during seeks
  const initRecords = [];
  const passMeta = new Map();

  try {
    const { sampleFps: fps, passes } = await runPairedClip({
      durationSec,
      sampleFps,
      reverseOrder,
      seek: (mediaTimeSec) => seekTo(video, mediaTimeSec, signal),
      makePass: async ({ preset }) => {
        // Per-pass reset: fresh landmarker, fresh filters, fresh analysis state.
        runner.close();
        runner.setInferencePreset(preset);
        runner.setSubjectExtent(null);

        const poseFilter = new PoseFilter();
        const worldFilter = new WorldPoseFilter();
        const kinematicFilter = new KinematicBoneFilter();
        const viewEstimator = new ViewOrientationEstimator();
        poseFilter.setVisibilityThreshold(CONFIDENCE_THRESHOLD);
        worldFilter.setVisibilityThreshold(CONFIDENCE_THRESHOLD);

        let exState = exercise.createState();
        const repFrames = [];
        const width = video.videoWidth;
        const height = video.videoHeight;

        let rec;
        try {
          rec = await runner.initialize(runner.preferredModel, onStatus);
          if (!rec || rec.success === false) {
            throw new Error('Trial rejected: model initialization did not complete');
          }
          const other = initRecords[0];
          if (other && (other.model !== rec.model || other.delegate !== rec.delegate)) {
            throw new Error(
              `Trial rejected: actual model/delegate mismatch across passes ` +
                `(${other.preset}: ${other.model}/${other.delegate} vs ${preset}: ${rec.model}/${rec.delegate})`,
            );
          }
          initRecords.push({ preset, model: rec.model, delegate: rec.delegate });
        } catch (err) {
          runner.close(); // factory failure: never leave a half-initialized model behind
          throw err;
        }

        return {
          sample: async ({ mediaTimeSec }) => {
            const timestampMs = mediaTimeSec * 1000; // media clock: source media time

            const i0 = now();
            const raw = runner.detectForVideo(video, timestampMs);
            const inferenceMs = now() - i0;

            const a0 = now();
            const landmarks = poseFilter.filter(raw.landmarks, timestampMs);
            let worldLandmarks = raw.worldLandmarks;
            if (raw.worldLandmarks) {
              worldLandmarks = kinematicFilter.filter(
                worldFilter.filter(raw.worldLandmarks, timestampMs),
                timestampMs,
              );
            } else {
              worldFilter.reset();
            }
            const view = viewEstimator.update(worldLandmarks, timestampMs);
            // Adaptive sizing follows the filtered extent, like the app: takes
            // effect on the next frame's inference.
            runner.setSubjectExtent(subjectExtent(landmarks, CONFIDENCE_THRESHOLD));
            const computed = computeFrameAngles({
              landmarks,
              worldLandmarks,
              width,
              height,
              threshold: CONFIDENCE_THRESHOLD,
              mode: ANGLE_MODE,
              view,
            });
            const angles = selectAngles(computed);
            const trackingQuality = trackingStatus(landmarks, CONFIDENCE_THRESHOLD, exercise.id);
            exState = exercise.update(exState, {
              angles,
              landmarks,
              width,
              height,
              timestampMs,
              trackingQuality,
            });
            repFrames.push({
              timestampMs,
              angles,
              landmarks,
              reps: exState.reps ?? 0,
              status: exState.status ?? null,
            });
            const analysisMs = now() - a0;

            return {
              landmarks: pickLandmarks(landmarks),
              rawLandmarks: pickLandmarks(raw.landmarks),
              worldLandmarks: pickLandmarks(worldLandmarks),
              rawWorldLandmarks: pickLandmarks(raw.worldLandmarks),
              angles,
              sources: computed.sources ?? null,
              phase: exState.phase ?? null,
              reps: exState.reps ?? null,
              status: exState.status ?? null,
              trackingQuality,
              inferenceMs,
              analysisMs,
            };
          },
          close: async () => {
            const a1 = now();
            const reps = analyzeReps(repFrames, exercise.id);
            passMeta.set(preset, { reps, session: summarizeSession(reps), summaryMs: now() - a1 });
            runner.close();
          },
        };
      },
      signal,
    });

    verifyPaired({ passes });
    const { model, delegate } = verifyRuntimeMatch(initRecords);

    let inferenceMsTotal = 0;
    let analysisMsTotal = 0;
    const passSummaries = [];
    const exportPasses = passes.map((pass) => {
      const meta = passMeta.get(pass.preset) ?? { reps: [], session: null, summaryMs: 0 };
      const init = initRecords.find((r) => r.preset === pass.preset); // real labels from initialize()
      let passInference = 0;
      let passAnalysis = meta.summaryMs;
      for (const frame of pass.frames) {
        passInference += frame.inferenceMs ?? 0;
        passAnalysis += frame.analysisMs ?? 0;
      }
      inferenceMsTotal += passInference;
      analysisMsTotal += passAnalysis;
      const summary = warmupSummary(pass.frames, WARMUP_FRAMES, meta.summaryMs);
      if (summary) passSummaries.push(summary);
      return {
        preset: pass.preset,
        model: init.model,
        delegate: init.delegate,
        timing: {
          inferenceMsTotal: passInference,
          analysisMsTotal: passAnalysis, // filtering + angles + exercise/rep analysis
          ...(summary ? { summary } : {}), // optional: first WARMUP_FRAMES excluded
        },
        reps: meta.reps,
        session: meta.session,
        frames: pass.frames, // raw per-frame timings retained
      };
    });
    const summary = passSummaries.length
      ? {
          warmupExcluded: WARMUP_FRAMES * passSummaries.length,
          sampleCount: passSummaries.reduce((n, s) => n + s.sampleCount, 0),
          inferenceMsTotal: passSummaries.reduce((n, s) => n + s.inferenceMsTotal, 0),
          analysisMsTotal: passSummaries.reduce((n, s) => n + s.analysisMsTotal, 0),
        }
      : null;

    const exportData = {
      format: BENCH_FORMAT,
      createdAt: new Date().toISOString(),
      clock: CLOCK_LABEL,
      source,
      schedule: {
        sampleFps: fps,
        durationSec,
        frames: passes[0].frames.map((f) => ({ id: f.id, mediaTimeSec: f.mediaTimeSec })),
      },
      sync: { offsetSec: syncOffsetSec, convention: syncConvention },
      order: {
        requested: reverseOrder ? 'direct-first' : 'adaptive-first',
        actual: passes.map((p) => p.preset), // the run order actually used
      },
      angles: {
        convention: EXPORTED_ANGLE_CONVENTION, // describes the exported angle values
        displayConvention: getAngleConvention(), // user-entered metadata
        mode: ANGLE_MODE,
        keys: ANGLE_KEYS,
      },
      runtime: { model, delegate, matched: true },
      durations: {
        controlled: false, // single sequential pass pair: timings are uncontrolled
        inferenceMsTotal,
        analysisMsTotal,
        ...(summary ? { summary } : {}),
      },
      passes: exportPasses,
    };

    return { exportData, initRecords };
  } finally {
    runner.close();
  }
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }); // compact: exports can be large
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function boot() {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('clip-file');
  const video = $('clip-video');
  const fpsInput = $('sample-fps');
  const durationInput = $('clip-duration');
  const syncOffsetInput = $('sync-offset');
  const syncConventionInput = $('sync-convention');
  const reverseOrderInput = $('reverse-order');
  const conventionSelect = $('angle-convention');
  const exerciseSelect = $('exercise-select');
  const runBtn = $('run-btn');
  const cancelBtn = $('cancel-btn');
  const exportBtn = $('export-btn');
  const statusEl = $('bench-status');

  const state = {
    fileUrl: null,
    source: null,
    exportData: null,
    controller: null,
    cancelled: false,
    loadCleanup: null,
    clipReady: false,
    running: false,
  };
  const settingsFields = [
    fileInput, fpsInput, durationInput, syncOffsetInput, syncConventionInput,
    reverseOrderInput, conventionSelect, exerciseSelect,
  ];
  const say = (msg) => {
    statusEl.textContent = msg;
  };
  const clearLoadListeners = () => {
    if (state.loadCleanup) {
      state.loadCleanup(); // drop pending listeners so a stale selection can't touch a newer clip
      state.loadCleanup = null;
    }
  };
  const setRunning = (running) => {
    state.running = running;
    runBtn.disabled = running || !state.clipReady; // Run waits for loadeddata (readyState >= 2)
    for (const field of settingsFields) field.disabled = running; // settings snapshotted at start; frozen mid-run
    video.controls = !running;
    cancelBtn.disabled = !running || state.cancelled;
    exportBtn.disabled = running || !state.exportData;
  };
  const revokeFileUrl = (clearInput = true) => {
    clearLoadListeners();
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = null;
    state.source = null;
    state.clipReady = false;
    video.removeAttribute('src');
    video.load();
    if (clearInput) fileInput.value = '';
  };
  const badFile = (msg) => {
    revokeFileUrl();
    state.exportData = null;
    setRunning(false);
    say(msg);
  };

  for (const exercise of defaultExerciseRegistry.getAll()) {
    const option = document.createElement('option');
    option.value = exercise.id;
    option.textContent = exercise.name;
    exerciseSelect.appendChild(option);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    revokeFileUrl(false); // keeps the new selection in the input; clears stale load listeners
    state.exportData = null; // a new clip invalidates any earlier export
    exportBtn.disabled = true;
    if (!file) return;
    if (file.type && !file.type.startsWith('video/')) {
      badFile(`Bad file: "${file.name}" is not a video. Choose a local video file.`);
      return;
    }
    state.fileUrl = URL.createObjectURL(file); // local blob URL; never uploaded
    state.source = { name: file.name, type: file.type || null, sizeBytes: file.size };
    const onError = () => {
      clearLoadListeners();
      badFile(`Bad file: "${file.name}" could not be decoded as video.`);
    };
    const onReady = () => {
      clearLoadListeners();
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        badFile(`Bad file: could not read the duration of "${file.name}".`);
        return;
      }
      state.source.durationSec = video.duration;
      state.source.videoWidth = video.videoWidth;
      state.source.videoHeight = video.videoHeight;
      durationInput.value = String(Math.floor(video.duration * 100) / 100); // floor: never above the actual duration
      durationInput.max = String(video.duration);
      state.clipReady = true; // loadeddata: readyState >= 2, seeking is safe
      setRunning(state.running);
      say(`Clip ready locally: ${file.name} (${video.videoWidth}x${video.videoHeight}).`);
    };
    state.loadCleanup = () => {
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onReady);
    };
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onReady);
    video.src = state.fileUrl;
    video.load();
  });

  conventionSelect.addEventListener('change', () => {
    setAngleConvention(conventionSelect.value);
  });

  runBtn.addEventListener('click', async () => {
    if (runBtn.disabled) return;
    const clipDurationSec = state.source?.durationSec;
    const durationSec = Number(durationInput.value);
    const sampleFps = Number(fpsInput.value);
    const syncOffsetSec = Number(syncOffsetInput.value);
    // Snapshot every setting now; setRunning(true) freezes the fields for the run.
    const syncConvention = syncConventionInput.value.trim();
    const exerciseId = exerciseSelect.value;
    const displayConvention = conventionSelect.value;
    const reverseOrder = reverseOrderInput.checked;
    if (!state.fileUrl || !Number.isFinite(clipDurationSec)) {
      say('Choose a local clip file first.');
      return;
    }
    if (!state.clipReady) {
      say('Waiting for the clip to finish loading (loadeddata) before running.');
      return;
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      say('Duration must be a positive number of seconds.');
      return;
    }
    if (durationSec > clipDurationSec) {
      say(`Duration ${durationSec}s exceeds the loaded clip length (${clipDurationSec.toFixed(2)}s).`);
      return;
    }
    if (!Number.isFinite(sampleFps) || sampleFps <= 0) {
      say('Sample FPS must be a positive number.');
      return;
    }
    if (durationSec * sampleFps > MAX_FRAMES_PER_PASS) {
      say(`Duration x FPS must be at most ${MAX_FRAMES_PER_PASS} samples per pass.`);
      return;
    }
    if (!Number.isFinite(syncOffsetSec)) {
      say('Sync offset must be a number (seconds).');
      return;
    }

    setAngleConvention(displayConvention);
    state.exportData = null;
    state.cancelled = false;
    state.controller = new AbortController();
    setRunning(true);
    say(`Running paired bench (${reverseOrder ? 'Direct first' : 'Adaptive first'}). Keep this tab visible; Cancel stays available.`);

    try {
      const { exportData } = await runTrial({
        video,
        source: { ...state.source, clock: CLOCK_LABEL },
        durationSec,
        sampleFps,
        exerciseId,
        syncOffsetSec,
        syncConvention,
        reverseOrder,
        signal: state.controller.signal,
        onStatus: say,
      });
      state.exportData = exportData;
      say(
        `Trial complete: ${exportData.schedule.frames.length} paired frames, ` +
          `actual model ${exportData.runtime.model.toUpperCase()} (${exportData.runtime.delegate}). Export ready.`,
      );
    } catch (err) {
      say(err && err.message ? err.message : `Trial failed: ${err}`);
    } finally {
      if (state.cancelled) {
        // Cancel closes the model (runTrial's finally) and revokes the local URL —
        // only now, once the aborted run has fully settled.
        revokeFileUrl();
        say('Cancelled. Model closed and local URL revoked; nothing was uploaded.');
      }
      state.controller = null;
      state.cancelled = false;
      setRunning(false);
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (!state.controller || state.cancelled) return;
    state.cancelled = true;
    cancelBtn.disabled = true;
    say('Cancelling… closing the model.');
    state.controller.abort(new Error('Cancelled by user'));
  });

  exportBtn.addEventListener('click', () => {
    if (!state.exportData) return;
    const stamp = state.exportData.createdAt.replace(/[:.]/g, '-');
    downloadJson(state.exportData, `paired-clip-${stamp}.json`);
    say('Paired JSON exported to your downloads.');
  });

  setRunning(false);
}

if (typeof document !== 'undefined') boot();
