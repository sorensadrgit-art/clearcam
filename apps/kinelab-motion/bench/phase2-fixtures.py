"""Build Phase 2 public demo fixtures and browser-run manifests in a local directory.

Place the two synchronized OpenCap MP4s (cam0.mp4, cam1.mp4), its IK output
(proxy.mot), and the TensorFlow.js squat fixture (squat.mp4) in that directory.
Usage: python3 phase2-fixtures.py FIXTURE_DIRECTORY [FFMPEG]
"""
import json
from pathlib import Path
import subprocess
import sys

if not 2 <= len(sys.argv) <= 3:
    sys.exit("Usage: python3 phase2-fixtures.py FIXTURE_DIRECTORY [FFMPEG]")
root = Path(sys.argv[1]).resolve()
ffmpeg = sys.argv[2] if len(sys.argv) > 2 else "ffmpeg"

variants = [
    ("cam0.mp4", "fps=60", "cam0.webm"),
    ("cam1.mp4", "fps=60", "cam1.webm"),
    ("cam0.mp4", "fps=60,eq=brightness=-0.30:contrast=0.70", "dark.webm"),
    ("cam0.mp4", "fps=60,drawbox=x=0:y=310:w=iw:h=ih-310:color=black:t=fill:enable='between(t,1,1.65)'",
     "occluded.webm"),
    ("cam0.mp4", "setpts=0.5*PTS,fps=60", "fast.webm"),
    ("cam0.mp4", "fps=60,scale=720:1280", "live.webm"),
    ("squat.mp4", "fps=5", "fixture.webm"),
]
for source, filters, output in variants:
    subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1",
         "-i", str(root / source), "-vf", filters, "-an", "-c:v", "libvpx", "-threads", "1",
         "-pix_fmt", "yuv420p", "-crf", "12", "-b:v", "0", "-deadline", "good", "-cpu-used", "4",
         "-y", str(root / output)],
        check=True,
    )

header, *mot = (root / "proxy.mot").read_text().split("endheader", 1)[1].strip().splitlines()
columns = header.split()
samples = [list(map(float, line.split())) for line in mot]
knee_columns = {side: columns.index("knee_angle_" + side[0]) for side in ("left", "right")}


def reference(count, fps, speed):
    rows = []
    for i in range(count):
        timestamp = i / fps * speed
        row = min(samples, key=lambda sample: abs(sample[0] - timestamp))
        if abs(row[0] - timestamp) > .009:
            raise ValueError(f"No reference within 9 ms of {timestamp}")
        rows.append({side: row[index] for side, index in knee_columns.items()})
    return rows


cases = []
for case_id, file, fps, count, speed, reverse in [
    ("view0", "cam0.webm", 30, 96, 1, False),
    ("view0-reversed", "cam0.webm", 30, 96, 1, True),
    ("view1", "cam1.webm", 30, 96, 1, False),
    ("dark", "dark.webm", 30, 96, 1, True),
    ("occluded", "occluded.webm", 30, 96, 1, False),
    ("2x-speed", "fast.webm", 30, 48, 2, True),
    ("fixture-squat", "fixture.webm", 5, 65, None, False),
    ("fixture-lunge-negative", "fixture.webm", 5, 65, None, True),
    ("fixture-shoulder-abduction-negative", "fixture.webm", 5, 65, None, False),
]:
    exercise = {
        "fixture-lunge-negative": "lunge",
        "fixture-shoulder-abduction-negative": "shoulder_abduction",
    }.get(case_id, "squat")
    cases.append(dict(
        id=case_id, file=file, mime="video/webm", sampleFps=fps, durationSec=count / fps,
        reverseOrder=reverse, exerciseId=exercise,
        expectedReps=0 if exercise != "squat" else 2 if case_id == "fixture-squat" else 1,
        occlusion=[1, 1.65] if case_id == "occluded" else None,
        reference=reference(count, fps, speed) if speed else None,
    ))
(root / "clip.json").write_text(json.dumps(cases))
(root / "live.json").write_text(json.dumps([
    dict(id=f"{i + 1}-{preset}", file="live.webm", mime="video/webm", preset=preset, observeMs=6200)
    for i, preset in enumerate(("adaptive", "direct", "direct", "adaptive"))
]))
