# KineLab development and review workflow

Use the [alignment plan](2026-11-24-kinelab-joint-alignment.md) as the implementation brief and the [measurement report](2026-11-24-kinelab-joint-alignment-measurements.md) as the baseline. The runner belongs in the studio's existing static Render artifact. Local bench runs are sufficient for development and require no Render credential.

| Role | Agent | Ownership |
| --- | --- | --- |
| Environment | Antigravity | Read the brief and confirm device, CPU, memory, storage, fixture, and command requirements before implementation. |
| Timing | Hermes | Frame timing, MediaPipe stage instrumentation, and focused timing tests. |
| Replay and integration | Pi with `xiaomi-token-plan-sgp/mimo-v2.6-pro` | Pair the same source frames across input configurations and connect replay to the existing live analysis. Own the browser entry point, app wiring, and focused replay tests. |
| Coordination and QA | Parent | Confirm file ownership, run browser smoke checks and synthetic controls, verify the full suite, and commit the reviewed changes. |
| Independent review | Claude Code | Review the assembled diff read-only. Report findings with severity and file/line, including timestamp handling, test coverage, and hot-path cost. |

Run the two implementation roles in the same Cloudroom sandbox only with disjoint file ownership. Pass the timing API and expected stages to Pi before the first integration edit. The parent stages and commits after handoffs. Launch Claude after both implementation roles have finished, with the baseline revision and verified QA results in its brief. Retry a harness startup once after reading its output. A provider sign-in challenge requires verification through Cloudroom's Agents settings.

## Resource allocation

Antigravity verified four vCPUs, about 8 GB memory, no swap, about 21 GB disk available, Node 24.22.1, and Python 3. Run browser measurements sequentially and use the CPU delegate in this VM. Use the SHA-verified sample clip and keep larger reference archives outside the worktree. Start the development server on loopback with `python3 apps/kinelab-motion/serve.py 4731`.

QA verified that Firefox with Mesa on Xvfb can load the pinned MediaPipe SDK and return all 33 landmarks from the reference MP4. A pre-change live-path check with OpenCap WebM replayed as a MediaStream produced 135 overlay samples in seven seconds, 19 pose FPS, and 57.7 ms p95 from presentation timestamp to first overlay draw. Timing runs on physical devices need their own baseline.

## Run a paired clip locally

Open `http://127.0.0.1:4731/bench/clip-runner.html` from the loopback development server. Choose a local video, a duration, a sample rate, and an exercise. Enter the reference sync offset and document its sign convention if you have a reference. Run the paired benchmark and export its JSON. MediaPipe loads its SDK and model normally. The selected video stays in the browser.

The export records matched Adaptive and Direct passes, the actual model and delegate, requested media times, raw and filtered poses, joint angle sources, tracking and exercise state, and inference and analysis durations. These timings measure sequential analysis of a recording. Use the app's live path to measure camera and draw timing.

The Firefox smoke test sampled the first six seconds of the SHA-verified squat MP4 at 5 Hz. The preview paused when the run started. Adaptive and Direct each exported 30 matching frames with 33 landmarks and angle-source metadata under Full CPU. In one uncontrolled Adaptive-first run, combined inference p95 including the first three frames was 55 ms for Adaptive and 51 ms for Direct. Corrupt input and cancellation both left export disabled. The synthetic knee benchmark remained at 3.2° side-on RMSE.

The export records the pass order. Use the Direct-first option to repeat the same comparison in reverse order. Raw timings and summaries omitting the first three frames per pass are available separately. Order, device, browser and repeat-run variation matter when interpreting the result.

On the final replay code, Firefox passed both orders with 30 matching frames per pass. After omitting the first three frames, combined inference p95 was 50 ms for both presets in the Adaptive-first run and 51 ms for both in the Direct-first run. Chromium enabled Run only after the fixture reached decoded-frame readiness. Claude Code Sonnet approved the replay code after reviewing the fixes and running 48 focused tests. Safari readiness and the Hermes-owned live timing integration remain pending. Hermes startup requires a Nous account verification.

## Acceptance commands

1. The feature owners run focused tests through red and green. Record the commands and the observed failures and passes.
2. QA compares the ordered frame IDs and source timestamps for Direct and Adaptive, checks for 33 landmarks on tracked frames, and spot-checks valid angles, phase, rep events, reference offset, and separate timing stages. Test a missing or corrupt clip and cancellation. Look for browser console errors and use an isolated local profile for camera and file access.
3. Run `node apps/kinelab-motion/bench/accuracy-bench.mjs` and confirm the side-on knee benchmark still reproduces its 3.2° RMSE. Run `node --test --test-concurrency=4 apps/kinelab-motion/tests/*.test.mjs` once after the integrated changes. Require all original 196 tests plus the feature tests to pass.
4. Supply the measured browser outcome, suite output, benchmark output, and exact diff base to Claude. Address confirmed defects, then verify affected behavior before recording the review disposition.
