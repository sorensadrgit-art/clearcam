# KineLab joint alignment measurement report

**Decision:** Proceed with development of the repeatable clip runner and frame-level instrumentation. Retain the current model, Adaptive input, and overlay defaults while gathering a better reference and device baseline. No candidate cleared both the quality and latency criteria for a default change.

## Methods and evidence

- **Browser timing.** Chromium 156 on a four-vCPU Linux cloud VM. The MediaPipe GPU delegate used software WebGL (SwiftShader). KineLab modules and MediaPipe Tasks Vision 1.2.3 ran on the same video inputs. Timed segments cover staging, SDK, postprocessing, and rendering. Browser timestamps are relative to video presentation or canvas draw submission. They do not include physical camera exposure or screen scan-out.
- **Footage.** The TensorFlow.js squat fixture is 720 × 1280, 13 s, 5 fps. The public OpenCap example contains two synchronized 360 × 640, 3.3 s, approximately 60 fps views of one squat trial. The fixed-frame comparison processed 65 fixture frames and 99 frames per OpenCap view at 30 Hz. Timing playback used source cadence and omitted the first three inference samples for stage percentiles. [TensorFlow.js test fixture](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/test_data/pose_squats.mp4) · [OpenCap public example](https://app.opencap.ai/session/7272a71a-e70a-4794-a253-39e11cb7542c) · [Trial metadata](https://api.opencap.ai/trials/679bd7e9-cfdf-4042-ad56-233affdbb714/)
- **References.** The example's `ik_results` file is OpenCap's fitted multi-camera result. The measurements below are agreement with that proxy. The comparison mapped KineLab's included angle to flexion with `180 − angle` and matched each 30 Hz video sample by timestamp to the 60 Hz reference within 9 ms, with no fitted lag. For image alignment, one annotator marked the visible right hip, knee, and ankle in eight TensorFlow.js frames before seeing landmark locations. Those 24 visual selections give a rough projected landmark comparison.
- **Projection control.** The actual canvas renderer drew a known knee at the expected pixel in all four portrait/landscape and mirrored/unmirrored combinations. The opposite location stayed empty. This checks the backing canvas transform. Browser crop and physical screen alignment still need to be tested with the live source.
- **Access.** The SimTK LabValidation video archive redirects to a login and lists a 19 GB download. The alternate Zenodo record describes synchronized footage, but the downloaded archives contained 99 TRC files and 294 markerless CSVs. The Harvard Dataverse SUMediPose dataset has synchronized projected and 3D reference positions and a noncommercial licence. A lab reference recording with an eligible use agreement and target hardware remain necessary for the production decision. [SimTK download](https://simtk.org/frs/?group_id=2385#pack_2354) · [Zenodo deposit](https://zenodo.org/records/18399031) · [SUMediPose dataset](https://doi.org/10.7910/DVN/GRRROM)

## What if we change the angle pipeline?

Full CPU, Adaptive input, 99 fixed samples per camera. Values are knee flexion MAE in degrees against the OpenCap demo proxy. Every row had both knee estimates on all frames.

| Variant | Cam 0 left / right | Cam 1 left / right |
| --- | ---: | ---: |
| Raw 2D | 10.50 / 27.27 | 25.74 / 9.27 |
| Filtered 2D | 10.49 / 27.09 | 25.51 / 9.25 |
| Raw 3D | 16.91 / 24.03 | 15.75 / 4.47 |
| Smoothed 3D, bone correction off | 18.75 / 23.40 | 16.89 / 6.14 |
| Smoothed 3D, current bone correction | 13.93 / 21.48 | 11.54 / 6.19 |
| Current Auto | 12.75 / 22.40 | 11.54 / 6.19 |

- **Change the model?** With Adaptive and Auto, Heavy lowered Cam 0 right error from 22.40° to 17.89°, but raised Cam 1 right error from 6.19° to 9.77°. Lite raised the same two errors to 23.72° and 11.92°. Model rank changed by view. The live, paced comparison counted 0 and 1 reps in the two views using Full. The 5 fps fixture produced two reps with all CPU variants; the software GPU variants processed fewer frames and counted one. These are app counts on short clips.
- **Raise the confidence threshold?** Keeping the top 89 of 99 frames by minimum hip/knee/ankle visibility and presence improved Auto agreement on Cam 0 from 12.75° to 10.64° left and 22.40° to 19.04° right. On Cam 1, it worsened from 11.54° to 11.77° left and 6.19° to 6.49° right. Use visibility as one candidate feature alongside view, limb size, and residuals. Report missing peaks and evaluate at common coverage.
- **Smooth the 2D landmarks more?** On the eight visually annotated frames, Full Direct raw and filtered right hip/knee/ankle mean distances were 21.03 px and 21.21 px in the 720 × 1280 image, with p95 of 36.79 px and 37.17 px. Filtered 2D knee angle MAE against the same projected visual marks was 14.75°. In this clip, filtering made little difference to the visible spatial error. Add independent annotation or projected mocap data before tuning raw landmark accuracy.
- **Strengthen anatomical constraints or calibrate the camera?** Current bone correction improved proxy agreement on three of four camera/leg pairs versus smoothed 3D alone. The near/far and 2D/3D results support evaluating view guidance and a soft constraint by joint and side. This study did not collect camera intrinsics, a pose reference with known asymmetry, or comparable raw and calibrated captures. Keep camera calibration, new inverse kinematics, stereo, and model replacements as gated trials.

## What if we change input, inference, or scheduling?

### Chromium timing

All durations are ms. The table gives ranges across repeated runs where available. SDK time excludes app staging. Draw-gap p95 measures the spacing between animation callbacks.

| Playback and configuration | Staging p95 | SDK p95 | Draw-gap p95 | Valid poses / analyzed |
| --- | ---: | ---: | ---: | ---: |
| 720 × 1280 fixture, Full CPU Direct | 0.0 | 73.2–75.5 | 50.0–66.6 | 64 / 64 each |
| 720 × 1280 fixture, Full CPU Adaptive | 9.8–10.9 | 40.9–44.0 | 33.4 | 64 / 64 each |
| 720 × 1280 fixture, Heavy CPU Direct | 0.0 | 168.8 | 166.7 | 63 / 63 |
| 720 × 1280 fixture, Lite CPU Direct | 0.0 | 51.5 | 33.4 | 64 / 64 |
| 720 × 1280 fixture, Full software GPU Direct | 0.0 | 398.2 | 400.0 | 31 / 31 |
| Cam 0, Full CPU Direct | 0.0 | 46.6 | 50.1 | 69 / 69 |
| Cam 0, Full CPU Adaptive | 0.1 | 44.4 | 50.1 | 71 / 71 |
| Cam 0, Lite CPU Adaptive | 0.0 | 34.7 | 33.4 | 95 / 95 |
| Cam 0, Heavy CPU Adaptive | 0.0 | 148.5 | 166.7 | 21 / 21 |

Adaptive saved SDK time at the larger source size. The 5 fps fixture still had about 200 ms p95 pose age at draw submission with either Full input preset. At 360 × 640, Adaptive quickly reverted to native size and offered little speed difference. On Cam 1, it was 0.9 ms slower at the SDK p95. For Full, preserve Adaptive and keep Direct as the control. Software WebGL results describe this VM, and hardware delegate ordering remains a device experiment.

**What if native resolution helps reacquire a distant subject?** Both views were composited into a 720 × 1280 canvas at scales 0.48 and 0.75, blanked between 1.0 and 1.7 s, and replayed at 15 Hz. Compare Direct, Adaptive, and Adaptive with native input on cold start and after two missed detections. At scale 0.75, all three delivered 38/38 valid knee frames per view, with detection on the first visible frame after blanking. At 0.48, Cam 0 delivered 23/38 for each. Cam 1 delivered 30/38 with Adaptive and 0/38 with Direct or the native retry. Adaptive detected Cam 1 after 400 ms on cold start and on the first visible frame after blanking. The other two first detected any pose at 2.67 s and had no valid knee result. Earlier stabilization at a smaller input is plausible on this transformed clip. Keep a bounded resolution sweep in the benchmark while avoiding a blanket native retry. This measures artificial size and dropout, with no new optics or real-world lighting.

**What if we move inference to a worker?** The experimental module worker boot failed with `ModuleFactory not set`. A classic worker bootstrap that imports the benchmark module initialized successfully. The Full CPU worker used native input on Cam 0 and rendered the filtered overlay. With one busy frame and no pending frame, ImageBitmap produced 47 results. With one replaceable pending frame, two runs produced 83 and 85. The queued worker's p95 render gap was 16.7 ms versus 50.1 ms for main-thread Direct, while its first new-pose draw age was about 84 ms. A queued VideoFrame run produced 73 results, with about the same draw-age p95. ImageBitmap extraction p95 was 2.2–2.5 ms versus 0.1 ms for VideoFrame. Its inference p95 was about 40 ms versus 45 ms for VideoFrame in these queued runs. Selection should be based on SDK plus transport and draw behavior. Keep the worker as a development spike with an age cutoff and a fallback.

**What if the browser is Firefox?** Firefox ESR 153 ran the Full CPU comparison and the classic ImageBitmap worker on an Xvfb display with software rendering. The source was Cam 0 re-encoded as VP8 WebM because the sandbox Firefox could not decode the original MP4. Direct/Adaptive SDK p95 was 45/44 ms and render-gap p95 was 51.3/34.2 ms. The queued worker drew at 17.1 ms p95 gaps with 87.8 ms first-pose draw age. On the same WebM, Chromium recorded 50.1 ms gaps for both main-thread presets and 16.7 ms gaps with 83.6 ms first-pose draw age for the worker. A raw-media-timestamp trial encountered a backwards timestamp and SDK failure. The reported reruns used KineLab's existing monotonic clock selector. Separate source identity from the SDK's monotonic time in the clip runner and worker. Headless Firefox in this VM could not initialize the SDK's graphics context.

**What if recording is on?** Ran the actual app for two 12 s phases using the synchronized clip as a looped MediaStream, with Full CPU and Adaptive. Recording off/on produced 223/212 inference samples. Inference p95 was 48.2/49.8 ms, presentation-to-first-overlay p95 was 59.8/61.6 ms, and render-gap p95 was 59.7/61.6 ms. The recording saved successfully. The sampled recording call itself was at or below 0.1 ms at p95 and excludes the separately calculated raw angles and browser encoding work. This short, fixed-order test does not characterize phone thermal behavior.

**What if the source cadence differs?** The existing 28 ms sampler accepted 24, 30, 20, 25, and 30 FPS on simulated stable 24, 30, 40, 50, and 60 FPS inputs. The non-divisor case is measurable. Defer a scheduler policy change until actual camera cadence and work budgets are available.

## What if we separate prediction from smoothing?

Used the actual interpolator on an exact synthetic landmark at 30 Hz, with display at 120 Hz and a fixed 25 ms delay. These are errors as a percentage of image width. Higher chase alone is set to λ=90. The reversal gate disables extrapolation for 60 ms after an observed velocity sign change or a sample gap.

| Variant | Smooth RMS | Reversal RMS | Reversal p95 / max | Reversal + drops p95 / max |
| --- | ---: | ---: | ---: | ---: |
| No prediction, λ=32 | 2.57 | 4.34 | 4.86 / 4.86 | 5.97 / 7.45 |
| Faster chase, no prediction | 1.80 | 3.15 | 3.73 / 3.73 | 5.41 / 7.20 |
| 20 ms prediction | 1.05 | 2.23 | 3.78 / 4.91 | 4.56 / 5.76 |
| 40 ms prediction | 0.56 | 1.89 | 4.18 / 6.23 | 4.18 / 6.23 |
| 40 ms with observed reversal gate | 0.56 | 2.00 | 4.18 / 6.23 | 5.37 / 6.90 |

The gate reacts after it observes the reversal, and it failed to reduce the worst overshoot. Keep fast chase and 20 ms prediction as separate A/B candidates. Test dropped frames, confidence, and motion reversals with the real paired clips before changing the default.

## Development scope and release evidence

1. Add a reproducible clip entry point that runs the existing live analysis, with per-frame landmarks, angles, phase, rep events, and timestamps. Accept known sync and reference conventions. Run projection checks for mirrored portrait and landscape inputs. Baseline and candidate must consume the same frame set in the quality run.
2. Add capture/presentation/callback clock labeling and separate staging, inference, analysis, draw, and recording metrics. Report fresh-pose latency, age on all draws, inter-pose gap, and missing draws together. Move percentile sorting to HUD/export cadence. Benchmark Direct/Adaptive with the same model and delegate before changing device policy.
3. Add opt-in tests for per-exercise angle source and side selection, fast chase versus 20 ms prediction, and a bounded worker. Upgrade a candidate only on participant-held-out matched references and target devices. Test squat and sit-to-stand first, then verify lunges, balance, shoulder, hip, and ankle before expanding the change. Record valid-frame/rep coverage, peak error and timing, pose age, and late draws together.
4. The outstanding release evidence is synchronized independent reference data for joints and exercise phases, low-end Android Chrome and iPhone Safari measurements, hardware GPU versus CPU, sustained phone recording with thermal load, and physical motion-to-overlay verification. Browser replay and synthetic controls completed here support starting development of the measurement tooling.

## Source fingerprints

The footage and pose trajectories are external assets. Match the following SHA-256 values to reproduce the comparisons.

| Asset | SHA-256 |
| --- | --- |
| TensorFlow.js squat MP4 | `ea9151e447b301985d5d65666551ef863b369a2e0f3a71ddd58abef2e722f96a` |
| OpenCap synchronized Cam 0 MP4 | `4625742809a09585046183a100d7dbc12ea91c233c3618c5af043d08f5048207` |
| OpenCap synchronized Cam 1 MP4 | `2a4d4ebb362cbd54a1e2b7bdd75cb55c2932392939d4e6993054361fdd24f6e6` |
| OpenCap `ik_results` MOT | `a9d90c607927c248cec642304e4c9e51cbf7b7b3fd786379c10c3e84605f7c23` |
