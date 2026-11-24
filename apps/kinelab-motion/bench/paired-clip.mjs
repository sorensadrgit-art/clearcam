/**
 * Paired-clip bench runner: samples one clip twice (adaptive, then direct) over
 * an identical deterministic schedule so per-frame results can be paired.
 *
 * Contract:
 * - makePass({ preset }) is called per preset and may return a Promise; the
 *   awaited result must be { sample({id, mediaTimeSec}), close() }. Abort is
 *   checked immediately after creation; a pass created after an abort is still
 *   closed before rejecting.
 * - reverseOrder (default false) picks pass order: false = adaptive, direct;
 *   true = direct, adaptive. Only the order changes — schedule, frame
 *   contents, error/cleanup semantics, and result keys are identical, and
 *   passes[] is returned in run order.
 * - Per frame: await seek(mediaTimeSec, {preset, id}), then await
 *   pass.sample({ id, mediaTimeSec }), strictly sequential. The end timestamp
 *   (== durationSec) is excluded; tiny positive clips include t=0 once.
 * - Schedule: id = i, mediaTimeSec = i / sampleFps for i = 0, 1, ... while
 *   mediaTimeSec < durationSec (strict), capped at MAX_FRAMES_PER_PASS.
 *   ids/mediaTimeSec are deterministic and identical across passes; in output
 *   frames they are authoritative over whatever sample() returns (other
 *   payload fields are merged underneath).
 * - Result: { sampleFps, passes: [{ preset, frames }] }.
 *
 * Limits and cleanup:
 * - MAX_FRAMES_PER_PASS (3600) is an absolute per-pass cap. durationSec *
 *   sampleFps must be finite and <= MAX_FRAMES_PER_PASS; overflow or larger
 *   products reject with RangeError before any pass is created.
 * - close() runs exactly once per created pass from a single cleanup step. The
 *   first failure wins (including falsy thrown values like null/undefined);
 *   abort is checked after each sample and after cleanup, so cancellation
 *   during the final sample or final close still rejects. A pass that fails
 *   validation but provided close() is still closed.
 */

const PRESETS = ['adaptive', 'direct'];

/** Absolute cap on samples per pass (3600 frames ≈ 2 min at 30 fps). */
export const MAX_FRAMES_PER_PASS = 3600;

function checkAbort(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  else if (signal.aborted) {
    throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
  }
}

function requireFunction(fn, name) {
  if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
}

function validateArgs({ durationSec, sampleFps, seek, makePass, reverseOrder }) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec)) {
    throw new TypeError('durationSec must be a finite number');
  }
  if (durationSec < 0) throw new RangeError('durationSec must be >= 0');
  if (typeof sampleFps !== 'number' || !Number.isFinite(sampleFps)) {
    throw new TypeError('sampleFps must be a finite number');
  }
  if (sampleFps <= 0) throw new RangeError('sampleFps must be > 0');
  requireFunction(seek, 'seek');
  requireFunction(makePass, 'makePass');
  if (reverseOrder !== undefined && typeof reverseOrder !== 'boolean') {
    throw new TypeError('reverseOrder must be a boolean');
  }

  // Reject overflow/huge spans before anything is created or allocated.
  const span = durationSec * sampleFps;
  if (!Number.isFinite(span)) {
    throw new RangeError(`durationSec * sampleFps must be finite (got ${span})`);
  }
  if (span > MAX_FRAMES_PER_PASS) {
    throw new RangeError(
      `durationSec * sampleFps must be <= ${MAX_FRAMES_PER_PASS} frames per pass (got ${span})`,
    );
  }
}

export async function runPairedClip({
  durationSec,
  sampleFps,
  seek,
  makePass,
  signal,
  reverseOrder = false,
} = {}) {
  validateArgs({ durationSec, sampleFps, seek, makePass, reverseOrder });

  const passes = [];
  const presets = reverseOrder ? [...PRESETS].reverse() : PRESETS;

  for (const preset of presets) {
    checkAbort(signal);
    const pass = await makePass({ preset }); // factory may return a Promise
    if (!pass || typeof pass.close !== 'function') {
      throw new TypeError(`makePass({ preset: '${preset}' }) must return { sample, close }`);
    }

    let failed = false;
    let failure;
    const fail = (err) => {
      if (!failed) {
        failed = true;
        failure = err;
      }
    };

    try {
      checkAbort(signal); // abort immediately after creation
      if (typeof pass.sample !== 'function') {
        throw new TypeError(`makePass({ preset: '${preset}' }) must return { sample, close }`);
      }

      const frames = [];
      // Absolute cap: reciprocal rounding must never yield > MAX frames.
      for (let id = 0; id < MAX_FRAMES_PER_PASS; id++) {
        const mediaTimeSec = id / sampleFps;
        if (!(mediaTimeSec < durationSec)) break; // strict < excludes the end timestamp
        checkAbort(signal);
        await seek(mediaTimeSec, { preset, id });
        checkAbort(signal);
        const data = await pass.sample({ id, mediaTimeSec });
        checkAbort(signal); // cancellation during the final sample must reject
        frames.push(
          data && typeof data === 'object'
            ? { ...data, id, mediaTimeSec }
            : { id, mediaTimeSec },
        );
      }
      passes.push({ preset, frames });
    } catch (err) {
      fail(err);
    }

    // Single cleanup step: close() exactly once, first failure preserved.
    try {
      await pass.close();
    } catch (closeError) {
      fail(closeError);
    }
    try {
      checkAbort(signal); // cancellation during the final close must reject
    } catch (abortError) {
      fail(abortError);
    }
    if (failed) throw failure;
  }

  return { sampleFps, passes };
}
