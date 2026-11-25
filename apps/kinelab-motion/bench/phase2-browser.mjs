// Run against an isolated, loopback-only browser debugging session. No dependencies.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const [engine, mode, manifestPath, outputPath, origin = 'http://127.0.0.1:4731'] = process.argv.slice(2);
if (!['firefox', 'chromium'].includes(engine) || !['clip', 'live'].includes(mode) || !outputPath) {
  throw new Error('Usage: node phase2-browser.mjs firefox|chromium clip|live manifest.json results.json [app-origin]');
}

const manifest = JSON.parse(await readFile(manifestPath));
const output = { engine, mode, cases: [] };
const browserPid = Number(process.env.KINELAB_BROWSER_PID);
const appUrl = new URL(origin);
if (!['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname)) {
  throw new Error('Use a loopback server for this benchmark.');
}

async function processTreeMemory(root) {
  // Linux lab-only supplement. PSS apportions shared pages across processes.
  const tasks = await readdir('/proc/' + root + '/task');
  const children = new Set(
    (await Promise.all(tasks.map((task) => readFile('/proc/' + root + '/task/' + task + '/children', 'utf8')
      .catch(() => '')))).join(' ').trim().split(/\s+/).filter(Boolean),
  );
  const rollup = await readFile('/proc/' + root + '/smaps_rollup', 'utf8').catch(() => '');
  const own = /^Pss:\s+(\d+) kB/m.exec(rollup);
  if (!own) return null;
  const descendants = await Promise.all([...children].map((child) => processTreeMemory(child).catch(() => null)));
  if (descendants.includes(null)) return null;
  return Number(own[1]) + descendants.reduce((sum, child) => sum + child, 0);
}

async function connect() {
  const firefox = engine === 'firefox';
  const endpoint = 'http://127.0.0.1:4732';
  const target = firefox ? null : await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT' })).json();
  const socket = new WebSocket(firefox ? 'ws://127.0.0.1:4733/session' : target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const requests = new Map();
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    const request = requests.get(reply.id);
    if (!request) return;
    requests.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) {
      const error = typeof reply.error === 'string' ? reply.message : reply.error.message;
      request.reject(new Error(error || 'Browser protocol error'));
    } else request.resolve(reply.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      requests.delete(requestId);
      reject(new Error(method + ' timed out'));
    }, 120000);
    requests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  let context;
  if (firefox) {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    ({ context } = await send('browsingContext.create', { type: 'tab' }));
    await send('browsingContext.activate', { context });
  } else {
    await send('Page.bringToFront');
  }
  const evaluate = async (expression) => {
    if (firefox) {
      const result = await send('script.evaluate', { target: { context }, awaitPromise: true, expression });
      if (result.type !== 'success') throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return {
    evaluate,
    async navigate(url) {
      if (firefox) {
        await send('browsingContext.navigate', { context, url, wait: 'complete' });
      } else {
        const { errorText } = await send('Page.navigate', { url });
        if (errorText) throw new Error(errorText);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    },
    async close() {
      try {
        if (firefox) {
          await send('browsingContext.close', { context });
          await send('session.end');
        } else {
          await fetch(endpoint + '/json/close/' + target.id);
        }
      } finally {
        socket.close();
      }
    },
  };
}

async function runInPage(mode, config, encoded) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { MediaPipeRunner } = await import('/src/tracking/mediapipe-runner.mjs');
  const media = document.createElement('video');
  media.muted = true;
  media.playsInline = true;
  media.preload = 'auto';
  const sourceUrl = URL.createObjectURL(new Blob([
    Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
  ], { type: config.mime }));
  try {
    await new Promise((resolve, reject) => {
      media.onloadeddata = resolve;
      media.onerror = () => reject(new Error(media.error?.message || 'Could not decode the benchmark video.'));
      media.src = sourceUrl;
    });
    const source = { width: media.videoWidth, height: media.videoHeight, durationSec: media.duration };
    const initialize = MediaPipeRunner.prototype.initialize;
    const loads = new WeakSet();
    const initialized = [];
    MediaPipeRunner.prototype.initialize = async function (...args) {
      if (!loads.has(this)) {
        const loadVision = this.loadVision;
        this.loadVision = async () => {
          const sdk = await loadVision();
          return { ...sdk, PoseLandmarker: { createFromOptions(files, options) {
            if (options.baseOptions.delegate !== 'CPU') throw new Error('Benchmark pins the CPU delegate.');
            return sdk.PoseLandmarker.createFromOptions(files, options);
          } } };
        };
        loads.add(this);
      }
      const result = await initialize.apply(this, args);
      initialized.push(result);
      if (result.success !== false && (result.model !== 'full' || result.delegate !== 'CPU')) {
        throw new Error('Benchmark requires MediaPipe Full on CPU.');
      }
      return result;
    };

    if (mode === 'clip') {
      const { runTrial } = await import('/bench/clip-runner.mjs');
      const { exportData } = await runTrial({
        video: media, source, durationSec: config.durationSec, sampleFps: config.sampleFps,
        exerciseId: config.exerciseId || 'squat', reverseOrder: config.reverseOrder ?? false,
        syncOffsetSec: 0, syncConvention: 'same recorded start',
      });
      // Do not export video, landmarks, per-frame angles or identifying filenames.
      return JSON.stringify({ ...scoreClip(exportData, config), browser: navigator.userAgent });
    }

    const byId = (id) => document.getElementById(id);
    const capture = media.captureStream || media.mozCaptureStream;
    if (!capture) throw new Error('This browser does not support HTML video captureStream.');
    media.loop = true;
    navigator.mediaDevices.getUserMedia = async () => {
      await media.play();
      return capture.call(media);
    };
    byId('model-choice').value = 'full';
    byId('model-choice').dispatchEvent(new Event('change'));
    byId('start-button').click();
    for (let i = 0; i < 200 && byId('record-button').disabled; i++) await wait(100);
    if (byId('record-button').disabled) throw new Error('Live camera path did not start.');
    const timing = globalThis.kinelabTiming;
    if (!timing) throw new Error('Missing live timing API. Run against the Phase 2 implementation.');
    await wait(1800);
    // Start both observations at the same place in the same looping media.
    await new Promise((resolve) => {
      if (media.currentTime === 0) resolve();
      else {
        media.addEventListener('seeked', resolve, { once: true });
        media.currentTime = 0;
      }
    });
    const playback = media.getVideoPlaybackQuality();
    timing.reset();
    await wait(config.observeMs || 6000);
    const report = await timing.snapshot();
    const end = media.getVideoPlaybackQuality();
    if (initialized.length !== 1 || initialized[0].success === false) {
      throw new Error('Measurement requires one successful configuration per live run.');
    }
    return JSON.stringify({
      source, runtime: { model: initialized[0].model, delegate: initialized[0].delegate },
      browser: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      preset: config.preset, playback: {
        presentedOrDropped: end.totalVideoFrames - playback.totalVideoFrames,
        dropped: end.droppedVideoFrames - playback.droppedVideoFrames,
      }, report,
    });
  } finally {
    document.getElementById('stop-button')?.click();
    media.pause();
    URL.revokeObjectURL(sourceUrl);
  }
}

function scoreClip(data, config) {
  const quantile = (values, p) => values.length
    ? values.toSorted((a, b) => a - b)[Math.ceil(p * values.length) - 1]
    : null;
  const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const stages = (values) => ({
    count: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), p99: quantile(values, 0.99),
  });
  const timing = (frames, field) => stages(frames.slice(3).map((frame) => frame[field]));
  const hasPose = (frame) => frame.rawLandmarks?.some(Boolean);
  function coverageDuringOcclusion(frames) {
    if (!config.occlusion) return null;
    const [from, to] = config.occlusion;
    const occluded = frames.filter(({ mediaTimeSec }) => mediaTimeSec >= from && mediaTimeSec <= to);
    const first = frames.find((frame) => frame.mediaTimeSec > to && hasPose(frame));
    return {
      frames: occluded.length,
      detected: occluded.filter(hasPose).length,
      firstPoseAfterMaskMs: first ? (first.mediaTimeSec - to) * 1000 : null,
    };
  }
  function sideMetrics(frames, side, width, height) {
    const joint = side + 'Knee';
    const index = side === 'left' ? 25 : 26;
    const flexion = frames.map((frame) => Number.isFinite(frame.angles?.[joint]) ? 180 - frame.angles[joint] : null);
    const valid = flexion.filter(Number.isFinite);
    const path = frames.map((frame) => frame.landmarks?.[index]);
    const raw = frames.map((frame) => frame.rawLandmarks?.[index]);
    const trajectoryResidual = (points) => mean(points.slice(2).flatMap((p, i) => {
      const a = points[i], b = points[i + 1];
      if (![p, a, b].every((point) => point?.visibility >= 0.55)) return [];
      return [Math.hypot((a.x - 2 * b.x + p.x) * width, (a.y - 2 * b.y + p.y) * height)];
    }));
    const matched = flexion.flatMap((angle, i) => {
      const reference = config.reference?.[i]?.[side];
      return Number.isFinite(angle) && Number.isFinite(reference)
        ? [{ estimated: angle, reference, time: frames[i].mediaTimeSec }] : [];
    });
    const peak = (key) => matched.reduce((best, row) => row[key] > best[key] ? row : best);
    const errors = matched.map((row) => row.estimated - row.reference);
    return {
      validAngles: valid.length,
      filteredKneeSecondDifferencePx: trajectoryResidual(path),
      rawKneeSecondDifferencePx: trajectoryResidual(raw),
      peakFlexion: valid.length ? Math.max(...valid) : null,
      matched: matched.length, referenceMAEDeg: mean(errors.map(Math.abs)),
      referenceBiasDeg: mean(errors), referenceErrorP95Deg: quantile(errors.map(Math.abs), 0.95),
      referencePeakTimingErrorMs: matched.length ? (peak('estimated').time - peak('reference').time) * 1000 : null,
      referencePeakErrorDeg: matched.length ? peak('estimated').estimated - peak('reference').reference : null,
    };
  }
  return {
    runtime: data.runtime, schedule: data.schedule, source: data.source, order: data.order,
    expectedReps: config.expectedReps ?? null,
    passes: data.passes.map(({ preset, frames }) => ({
      preset, observedFrames: frames.length,
      detectedFrames: frames.filter(hasPose).length,
      occlusion: coverageDuringOcclusion(frames),
      reps: frames.at(-1)?.reps ?? 0,
      timing: {
        inferenceIncludingStagingMs: timing(frames, 'inferenceMs'),
        analysisMs: timing(frames, 'analysisMs'),
        samples: frames.map(({ inferenceMs, analysisMs }) => [inferenceMs, analysisMs]),
      },
      left: sideMetrics(frames, 'left', data.source.width, data.source.height),
      right: sideMetrics(frames, 'right', data.source.width, data.source.height),
    })),
  };
}

const browser = await connect();
try {
  for (const config of manifest) {
    const bytes = await readFile(resolve(dirname(manifestPath), config.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const query = mode === 'live' ? '/?timing=1&timingLock=1&input=' + config.preset : '/bench/clip-runner.html';
    await browser.navigate(new URL(query, origin).href);
    const expression = '(' + runInPage + ')(' + [mode, config, bytes.toString('base64')]
      .map((arg) => JSON.stringify(arg)).join(',') + ')';
    const entry = { case: config.id, sha256 };
    const memorySamplesKiB = [];
    let sampler;
    if (mode === 'live' && Number.isInteger(browserPid) && browserPid > 0) {
      sampler = setInterval(() => {
        processTreeMemory(browserPid).then((sample) => {
          if (sample !== null) memorySamplesKiB.push(sample);
        }).catch(() => {});
      }, 1000);
    }
    try {
      const result = await browser.evaluate('const scoreClip = ' + scoreClip + '; ' + expression);
      entry.data = JSON.parse(result);
    } catch (error) {
      entry.error = error.message;
    } finally {
      clearInterval(sampler);
      if (sampler) {
        entry.browserProcessMemory = {
          source: 'Linux process tree PSS, includes startup and browser chrome',
          intervalMs: 1000,
          samplesKiB: memorySamplesKiB,
          peakKiB: memorySamplesKiB.length ? Math.max(...memorySamplesKiB) : null,
        };
      }
    }
    output.cases.push(entry);
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(config.id, entry.error ? entry.error.slice(0, 300) : 'ok');
  }
} finally {
  await browser.close();
}
if (output.cases.some((entry) => entry.error)) process.exitCode = 1;
