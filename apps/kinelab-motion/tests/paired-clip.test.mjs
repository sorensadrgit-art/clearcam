import test from 'node:test';
import assert from 'node:assert/strict';
import { runPairedClip, MAX_FRAMES_PER_PASS } from '../bench/paired-clip.mjs';

/**
 * Fake video harness: no Hermes, no DOM. `seek` mimics an async video seek
 * (set currentTime, await a "seeked" tick); `makePass` builds a pass whose
 * sample() reads the fake video element and records call order.
 */
function makeFakeVideo({ onSeek, onSample } = {}) {
  const video = { currentTime: 0 };
  const log = [];
  const passStates = [];

  const seek = async (mediaTimeSec, ctx) => {
    log.push(['seek', mediaTimeSec, ctx?.preset, ctx?.id]);
    if (onSeek) await onSeek({ mediaTimeSec, ctx, video });
    await Promise.resolve(); // simulate async seek completion
    video.currentTime = mediaTimeSec;
  };

  const makePass = ({ preset }) => {
    log.push(['makePass', preset]);
    const state = { preset, closes: 0, samples: 0, open: true };
    passStates.push(state);
    return {
      async sample({ id, mediaTimeSec }) {
        assert.ok(state.open, `sample() called after close() on ${preset}`);
        state.samples++;
        log.push(['sample', id, mediaTimeSec, preset]);
        if (onSample) await onSample({ id, mediaTimeSec, ctx: { preset }, video });
        return {
          id: 'bogus-id', // runner must override: id is authoritative
          mediaTimeSec: -999, // runner must override: mediaTimeSec is authoritative
          currentTimeSec: video.currentTime,
          preset,
        };
      },
      async close() {
        state.closes++;
        state.open = false;
        log.push(['close', preset]);
      },
    };
  };

  return { video, log, passStates, seek, makePass };
}

test('schedules frames at sampleFps and excludes the end timestamp', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 1,
    sampleFps: 4,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  assert.equal(result.sampleFps, 4);
  assert.deepEqual(result.passes.map((p) => p.preset), ['adaptive', 'direct']);
  for (const pass of result.passes) {
    assert.deepEqual(
      pass.frames.map((f) => f.id),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      pass.frames.map((f) => f.mediaTimeSec),
      [0, 0.25, 0.5, 0.75],
    );
  }
});

test('ids and requested media times are deterministic and identical across passes', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 0.5,
    sampleFps: 3,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  const [adaptive, direct] = result.passes;
  assert.deepEqual(
    adaptive.frames.map((f) => [f.id, f.mediaTimeSec]),
    [
      [0, 0],
      [1, 1 / 3],
    ],
  );
  assert.deepEqual(
    direct.frames.map((f) => [f.id, f.mediaTimeSec]),
    [
      [0, 0],
      [1, 1 / 3],
    ],
  );
});

test('id and mediaTimeSec in output are authoritative over sample() results', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 1,
    sampleFps: 2,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  for (const pass of result.passes) {
    for (const frame of pass.frames) {
      assert.equal(typeof frame.id, 'number');
      assert.ok(Number.isInteger(frame.id));
      assert.notEqual(frame.id, 'bogus-id');
      assert.notEqual(frame.mediaTimeSec, -999);
      // non-identity payload fields from sample() survive
      assert.equal(frame.preset, pass.preset);
      assert.equal(frame.currentTimeSec, frame.mediaTimeSec);
    }
  }
});

test('seeks then samples sequentially, one pass at a time', async () => {
  const fake = makeFakeVideo();
  await runPairedClip({
    durationSec: 1,
    sampleFps: 2,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  assert.deepEqual(fake.log, [
    ['makePass', 'adaptive'],
    ['seek', 0, 'adaptive', 0],
    ['sample', 0, 0, 'adaptive'],
    ['seek', 0.5, 'adaptive', 1],
    ['sample', 1, 0.5, 'adaptive'],
    ['close', 'adaptive'],
    ['makePass', 'direct'],
    ['seek', 0, 'direct', 0],
    ['sample', 0, 0, 'direct'],
    ['seek', 0.5, 'direct', 1],
    ['sample', 1, 0.5, 'direct'],
    ['close', 'direct'],
  ]);
});

test('sample count is bounded by ceil(durationSec * sampleFps) and excludes end', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 10,
    sampleFps: 30,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  for (const pass of result.passes) {
    assert.equal(pass.frames.length, 300);
    assert.equal(pass.frames.length, Math.ceil(10 * 30));
    const ids = new Set(pass.frames.map((f) => f.id));
    assert.equal(ids.size, pass.frames.length, 'ids are unique');
    const last = pass.frames.at(-1);
    assert.ok(last.mediaTimeSec < 10, 'end timestamp excluded');
    assert.ok(pass.frames.every((f) => f.mediaTimeSec < 10));
  }
});

test('zero duration yields empty frame lists but still runs and closes both passes', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 0,
    sampleFps: 4,
    seek: fake.seek,
    makePass: fake.makePass,
  });

  assert.deepEqual(result.passes.map((p) => [p.preset, p.frames.length]), [
    ['adaptive', 0],
    ['direct', 0],
  ]);
  assert.deepEqual(fake.passStates.map((s) => s.closes), [1, 1]);
});

test('already-aborted signal rejects before any pass is created', async () => {
  const fake = makeFakeVideo();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 4,
      seek: fake.seek,
      makePass: fake.makePass,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(fake.log, []);
});

test('abort mid-run closes the open pass exactly once and skips later passes', async () => {
  const controller = new AbortController();
  const fake = makeFakeVideo({
    onSeek: ({ ctx }) => {
      if (ctx.preset === 'adaptive' && ctx.id === 1) controller.abort();
    },
  });

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: fake.seek,
      makePass: fake.makePass,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [['adaptive', 1]]);
  assert.ok(!fake.log.some((e) => e[0] === 'makePass' && e[1] === 'direct'));
});

test('seek failure cleans up: open pass closed once, completed passes closed once', async () => {
  const boom = new Error('seek failed');
  const fake = makeFakeVideo({
    onSeek: ({ ctx }) => {
      if (ctx.preset === 'direct' && ctx.id === 1) throw boom;
    },
  });

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: fake.seek,
      makePass: fake.makePass,
    }),
    (err) => err === boom,
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [
    ['adaptive', 1],
    ['direct', 1],
  ]);
});

test('sample failure cleans up: open pass closed exactly once', async () => {
  const boom = new Error('sample failed');
  const fake = makeFakeVideo({
    onSample: ({ id, ctx }) => {
      if (ctx.preset === 'adaptive' && id === 0) throw boom;
    },
  });

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: fake.seek,
      makePass: fake.makePass,
    }),
    (err) => err === boom,
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [['adaptive', 1]]);
});

test('closes each pass exactly once on success', async () => {
  const fake = makeFakeVideo();
  await runPairedClip({
    durationSec: 1,
    sampleFps: 4,
    seek: fake.seek,
    makePass: fake.makePass,
  });
  assert.deepEqual(fake.passStates.map((s) => s.closes), [1, 1]);
  assert.deepEqual(fake.passStates.map((s) => s.samples), [4, 4]);
});

test('sample() payload is merged non-destructively; non-object payloads are ignored', async () => {
  const result = await runPairedClip({
    durationSec: 1,
    sampleFps: 1,
    seek: async () => {},
    makePass: () => ({
      sample: async () => undefined,
      close: async () => {},
    }),
  });
  assert.deepEqual(result.passes[0].frames, [{ id: 0, mediaTimeSec: 0 }]);
});

test('rejects an unusable pass object but closes it when it provided close()', async () => {
  let closes = 0;
  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 1,
      seek: async () => {},
      makePass: () => ({ sample: 'nope', close: async () => { closes++; } }),
    }),
    { name: 'TypeError' },
  );
  assert.equal(closes, 1);
});

test('accepts a makePass factory that returns a Promise', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 1,
    sampleFps: 2,
    seek: fake.seek,
    makePass: async (ctx) => {
      await Promise.resolve(); // factory resolves on a later tick
      return fake.makePass(ctx);
    },
  });
  assert.deepEqual(result.passes.map((p) => p.frames.length), [2, 2]);
  assert.deepEqual(fake.passStates.map((s) => s.closes), [1, 1]);
});

test('abort while the makePass promise is pending closes the created pass and rejects', async () => {
  const controller = new AbortController();
  const state = { closes: 0, samples: 0 };
  const makePass = () =>
    new Promise((resolve) => {
      controller.abort(); // aborted before the factory resolves
      resolve({
        sample: async () => { state.samples++; },
        close: async () => { state.closes++; },
      });
    });

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: async () => {},
      makePass,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(state.closes, 1, 'created pass must be closed');
  assert.equal(state.samples, 0);
});

test('rejects before any allocation when durationSec * sampleFps is huge or Infinity', async () => {
  const fake = makeFakeVideo();
  const cases = [
    [1e308, 1e308],
    [Number.MAX_VALUE, 2],
    [Number.MAX_VALUE, 1],
    [1e6, 1e6],
  ];
  for (const [durationSec, sampleFps] of cases) {
    await assert.rejects(
      runPairedClip({ durationSec, sampleFps, seek: fake.seek, makePass: fake.makePass }),
      { name: 'RangeError' },
    );
  }
  assert.deepEqual(fake.log, [], 'nothing may be created before the rejection');
});

test('MAX_FRAMES_PER_PASS bounds the sample count (3600 allowed, 3601 rejected)', async () => {
  assert.equal(MAX_FRAMES_PER_PASS, 3600);

  let samples = 0;
  const result = await runPairedClip({
    durationSec: 1,
    sampleFps: MAX_FRAMES_PER_PASS,
    seek: async () => {},
    makePass: () => ({ sample: async () => { samples++; }, close: async () => {} }),
  });
  assert.equal(result.passes[0].frames.length, MAX_FRAMES_PER_PASS);
  assert.equal(samples, 2 * MAX_FRAMES_PER_PASS, 'both passes sampled');

  const fake = makeFakeVideo();
  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: MAX_FRAMES_PER_PASS + 1,
      seek: fake.seek,
      makePass: fake.makePass,
    }),
    { name: 'RangeError' },
  );
  assert.deepEqual(fake.log, [], 'rejected before any pass was created');
});

test('tiny positive clips include t=0 exactly once', async () => {
  const fake = makeFakeVideo();
  const result = await runPairedClip({
    durationSec: 1e-6,
    sampleFps: 30,
    seek: fake.seek,
    makePass: fake.makePass,
  });
  for (const pass of result.passes) {
    assert.deepEqual(pass.frames.map((f) => [f.id, f.mediaTimeSec]), [[0, 0]]);
  }
});

test('preserves the original seek failure when close also fails', async () => {
  const boom = new Error('seek failed');
  const closeBoom = new Error('close failed');
  const fake = makeFakeVideo({
    onSeek: ({ ctx }) => {
      if (ctx.preset === 'adaptive' && ctx.id === 0) throw boom;
    },
  });
  const makePass = (ctx) => {
    const p = fake.makePass(ctx);
    return {
      sample: p.sample,
      close: async () => {
        await p.close();
        throw closeBoom;
      },
    };
  };

  await assert.rejects(
    runPairedClip({ durationSec: 1, sampleFps: 2, seek: fake.seek, makePass }),
    (err) => err === boom,
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [['adaptive', 1]]);
});

test('preserves the original sample failure when close also fails', async () => {
  const boom = new Error('sample failed');
  const closeBoom = new Error('close failed');
  const fake = makeFakeVideo({
    onSample: ({ id, ctx }) => {
      if (ctx.preset === 'adaptive' && id === 0) throw boom;
    },
  });
  const makePass = (ctx) => {
    const p = fake.makePass(ctx);
    return {
      sample: p.sample,
      close: async () => {
        await p.close();
        throw closeBoom;
      },
    };
  };

  await assert.rejects(
    runPairedClip({ durationSec: 1, sampleFps: 2, seek: fake.seek, makePass }),
    (err) => err === boom,
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [['adaptive', 1]]);
});

test('abort during the final sample rejects and cleans up', async () => {
  const controller = new AbortController();
  const fake = makeFakeVideo({
    onSample: ({ id, ctx }) => {
      if (ctx.preset === 'direct' && id === 1) controller.abort(); // very last sample of the run
    },
  });

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: fake.seek,
      makePass: fake.makePass,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [
    ['adaptive', 1],
    ['direct', 1],
  ]);
});

test('abort during the final close rejects even though all samples succeeded', async () => {
  const controller = new AbortController();
  const state = { closes: 0, samples: 0 };

  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: async () => {},
      makePass: ({ preset }) => ({
        sample: async () => { state.samples++; return { ok: true }; },
        close: async () => {
          state.closes++;
          if (preset === 'direct') controller.abort(); // abort during the last close
        },
      }),
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(state.samples, 4, 'all samples ran');
  assert.equal(state.closes, 2, 'both passes closed');
});

test('falsy thrown values reject the run instead of being swallowed', async () => {
  for (const falsy of [null, undefined, false, 0, '']) {
    const fake = makeFakeVideo({ onSample: () => { throw falsy; } });
    let rejected = false;
    let reason;
    try {
      await runPairedClip({ durationSec: 1, sampleFps: 2, seek: fake.seek, makePass: fake.makePass });
    } catch (err) {
      rejected = true;
      reason = err;
    }
    assert.equal(rejected, true, `throwing ${String(falsy)} must reject`);
    assert.ok(Object.is(reason, falsy), 'rejection reason is the thrown value');
    assert.deepEqual(fake.passStates.map((s) => [s.preset, s.closes]), [['adaptive', 1]]);

    // same for a falsy failure from close() on the success path
    let closeRejected = false;
    let closeReason;
    try {
      await runPairedClip({
        durationSec: 1,
        sampleFps: 2,
        seek: async () => {},
        makePass: () => ({ sample: async () => {}, close: async () => { throw falsy; } }),
      });
    } catch (err) {
      closeRejected = true;
      closeReason = err;
    }
    assert.equal(closeRejected, true, `close throwing ${String(falsy)} must reject`);
    assert.ok(Object.is(closeReason, falsy));
  }
});

test('preserves a falsy body failure even when close also fails', async () => {
  const closeBoom = new Error('close failed');
  let rejected = false;
  let reason;
  try {
    await runPairedClip({
      durationSec: 1,
      sampleFps: 2,
      seek: async () => { throw null; },
      makePass: () => ({ sample: async () => {}, close: async () => { throw closeBoom; } }),
    });
  } catch (err) {
    rejected = true;
    reason = err;
  }
  assert.equal(rejected, true);
  assert.equal(reason, null, 'first (falsy) failure wins over the close failure');
});

test('cap is absolute despite reciprocal rounding (span rounds to 3600, strict < wants 3601)', async () => {
  // fl(3600 / 463) rounds down; durationSec one ulp above it keeps
  // durationSec * sampleFps == 3600 while id / sampleFps < durationSec
  // holds for id up to 3600 — the loop must still stop at 3600 frames.
  const sampleFps = 463;
  const durationSec = 7.7753779697624195;
  assert.equal(durationSec * sampleFps, MAX_FRAMES_PER_PASS);

  const result = await runPairedClip({
    durationSec,
    sampleFps,
    seek: async () => {},
    makePass: () => ({ sample: async () => {}, close: async () => {} }),
  });
  for (const pass of result.passes) {
    assert.equal(pass.frames.length, MAX_FRAMES_PER_PASS);
  }
});

test('reverseOrder=true runs Direct then Adaptive with identical frames and unchanged keys', async () => {
  const base = makeFakeVideo();
  const normal = await runPairedClip({
    durationSec: 1,
    sampleFps: 4,
    seek: base.seek,
    makePass: base.makePass,
  });

  const rev = makeFakeVideo();
  const reversed = await runPairedClip({
    durationSec: 1,
    sampleFps: 4,
    seek: rev.seek,
    makePass: rev.makePass,
    reverseOrder: true,
  });

  // call order: direct pass is created first
  assert.deepEqual(
    rev.log.filter((e) => e[0] === 'makePass').map((e) => e[1]),
    ['direct', 'adaptive'],
  );
  // return order follows call order
  assert.deepEqual(reversed.passes.map((p) => p.preset), ['direct', 'adaptive']);
  assert.deepEqual(normal.passes.map((p) => p.preset), ['adaptive', 'direct']);

  // identical result keys and sampleFps
  assert.deepEqual(Object.keys(reversed), Object.keys(normal));
  assert.equal(reversed.sampleFps, normal.sampleFps);
  for (const pass of reversed.passes) {
    assert.deepEqual(Object.keys(pass), ['preset', 'frames']);
  }

  // identical frames per preset across the two orders
  const by = (res, preset) => res.passes.find((p) => p.preset === preset);
  for (const preset of ['adaptive', 'direct']) {
    assert.deepEqual(by(reversed, preset).frames, by(normal, preset).frames);
    assert.deepEqual(
      by(reversed, preset).frames.map((f) => [f.id, f.mediaTimeSec]),
      [
        [0, 0],
        [1, 0.25],
        [2, 0.5],
        [3, 0.75],
      ],
    );
  }
});

test('reverseOrder accepts only booleans', async () => {
  await assert.rejects(
    runPairedClip({
      durationSec: 1,
      sampleFps: 4,
      seek: async () => {},
      makePass: () => ({ sample: async () => {}, close: async () => {} }),
      reverseOrder: 'yes',
    }),
    { name: 'TypeError' },
  );
});

test('validates inputs', async () => {
  const noop = async () => {};
  const makePass = () => ({ sample: async () => {}, close: async () => {} });
  const cases = [
    [{ durationSec: NaN, sampleFps: 4, seek: noop, makePass }, 'TypeError'],
    [{ durationSec: -1, sampleFps: 4, seek: noop, makePass }, 'RangeError'],
    [{ durationSec: 1, sampleFps: 0, seek: noop, makePass }, 'RangeError'],
    [{ durationSec: 1, sampleFps: -2, seek: noop, makePass }, 'RangeError'],
    [{ durationSec: 1, sampleFps: NaN, seek: noop, makePass }, 'TypeError'],
    [{ durationSec: 1, sampleFps: 4, seek: null, makePass }, 'TypeError'],
    [{ durationSec: 1, sampleFps: 4, seek: noop, makePass: undefined }, 'TypeError'],
    [{ durationSec: 1, sampleFps: 4, seek: noop, makePass, reverseOrder: 1 }, 'TypeError'],
    [undefined, 'TypeError'],
  ];
  for (const [args, name] of cases) {
    await assert.rejects(runPairedClip(args), { name });
  }
});
