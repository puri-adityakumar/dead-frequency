#!/usr/bin/env python3
"""Replace the Dead Frequency demo soundtrack with Microsoft Edge neural narration.

WARNING: this script sends the non-personal narration text below to Microsoft's
online Edge speech service through the edge-tts library. There is no offline or
Azure fallback. Do not use it with personal data or secrets.

The video stream is copied with ffmpeg -c:v copy. The script verifies packet and
decoded-frame hashes before and after muxing, checks the audio for clipping and
silence, writes sentence-level captions from the actual synthesized timings, and
only then atomically replaces the deliverable.

Run:
    .venv/bin/python scripts/narrate-demo.py --yes
"""

from __future__ import annotations

import argparse
import array
import asyncio
import errno
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "blogs/assets/video/dead-frequency-demo.mp4"
DEFAULT_OUTPUT = DEFAULT_INPUT
DEFAULT_SRT = ROOT / "blogs/assets/video/dead-frequency-demo.srt"
DEFAULT_NARRATION = ROOT / "blogs/assets/video/narration.txt"
DEFAULT_WORKDIR = ROOT / "test-results/narration"
POSTER = ROOT / "blogs/assets/video/dead-frequency-demo-poster.png"
LIGHTING_DEMO = ROOT / "blogs/assets/video/lighting-demo.mp4"

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
SAMPLE_RATE = 48_000
CHANNELS = 2
SAMPLE_WIDTH = 2
SOURCE_DURATION = 46.4
EXPECTED_VIDEO = {"codec": "h264", "width": 1280, "height": 720, "fps": "25/1"}

DEFAULT_VOICE = "en-US-AndrewNeural"
FALLBACK_VOICES = (
    "en-US-GuyNeural",
    "en-US-BrianNeural",
    "en-US-ChristopherNeural",
    "en-US-SteffanNeural",
)
AUDIO_BITRATE = "192k"
AUDIO_HANDLER = "Microsoft Edge neural narration"

BASE_RATE = "+6%"
MAX_RATE = "+14%"
SENTENCE_GAP = 0.12
MIN_TAIL_GAP = 0.25
END_PAD = 0.50
TRIM_THRESHOLD_DBFS = -50.0
PRE_ROLL = 0.030
POST_ROLL = 0.100
FADE_IN = 0.005
FADE_OUT = 0.015
TARGET_LUFS = -16.0
TARGET_TP = -2.0
MAX_GAIN_DB = 6.0
REFERENCE_GAP = 0.10
SYNTH_ATTEMPTS = 3
SYNTH_TIMEOUT = 90.0

edge_tts: Any = None


class NarrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Cue:
    speech: str
    caption: str


@dataclass(frozen=True)
class Line:
    index: int
    anchor: float
    cues: tuple[Cue, ...]
    short_cues: tuple[Cue, ...]


@dataclass
class Clip:
    samples: array.array
    duration: float
    speech_start: float
    speech_end: float
    first_voiced_sample: int
    last_voiced_sample: int
    kept_start_sample: int
    kept_end_sample: int
    peak_dbfs: float | None
    boundaries: list[dict[str, Any]]
    rate: str
    source_text: str


@dataclass
class LineResult:
    line: Line
    clips: list[Clip]
    rate: str
    short_variant: bool
    used_cues: tuple[Cue, ...]
    span: float
    available: float
    synthesis_calls: int


def narration_lines() -> tuple[Line, ...]:
    return (
        Line(
            1,
            0.6,
            (
                Cue("Dead Frequency.", "Dead Frequency."),
                Cue(
                    "A two-and-a-half D survival horror prototype in Canvas 2D and Next JS.",
                    "A 2.5D survival horror prototype in Canvas 2D and Next.js.",
                ),
            ),
            (
                Cue("Dead Frequency.", "Dead Frequency."),
                Cue(
                    "A two-and-a-half D survival horror game in Canvas 2D and Next JS.",
                    "A 2.5D survival horror game in Canvas 2D and Next.js.",
                ),
            ),
        ),
        Line(
            2,
            7.1,
            (
                Cue("Three relays are dark.", "Three relays are dark."),
                Cue(
                    "The exit gate stays sealed until they're back.",
                    "The exit gate stays sealed until they're back.",
                ),
            ),
            (
                Cue("Three relays are dark.", "Three relays are dark."),
                Cue("The exit stays sealed until they're back.", "The exit stays sealed until they're back."),
            ),
        ),
        Line(
            3,
            11.7,
            (
                Cue("You start in reception.", "You start in reception."),
                Cue(
                    "The HUD shows integrity, stamina, threat, and relay pips.",
                    "The HUD shows integrity, stamina, threat, and relay pips.",
                ),
            ),
            (
                Cue("You start in reception.", "You start in reception."),
                Cue("The HUD shows integrity, stamina, threat, and relays.", "The HUD shows integrity, stamina, threat, and relays."),
            ),
        ),
        Line(
            4,
            18.0,
            (
                Cue("The director speaks only at milestones.", "The director speaks only at milestones."),
                Cue(
                    "This build labels every scripted line as fallback.",
                    "This build labels every scripted line as fallback.",
                ),
            ),
            (
                Cue("The director speaks at milestones.", "The director speaks at milestones."),
                Cue("Every scripted line is labeled fallback.", "Every scripted line is labeled fallback."),
            ),
        ),
        Line(
            5,
            24.2,
            (
                Cue("Walk, sprint, listen.", "Walk, sprint, listen."),
                Cue(
                    "The creature follows the same walls and corridors you do.",
                    "The creature follows the same walls and corridors you do.",
                ),
            ),
            (
                Cue("Walk, sprint, listen.", "Walk, sprint, listen."),
                Cue("The creature follows the same walls you do.", "The creature follows the same walls you do."),
            ),
        ),
        Line(
            6,
            30.0,
            (
                Cue("The flashlight is real canvas lighting.", "The flashlight is real canvas lighting."),
                Cue(
                    "It also makes you easier for the creature to see.",
                    "It also makes you easier for the creature to see.",
                ),
            ),
            (
                Cue("The flashlight is real canvas lighting.", "The flashlight is real canvas lighting."),
                Cue("It also makes you easier to see.", "It also makes you easier to see."),
            ),
        ),
        Line(
            7,
            37.5,
            (
                Cue("Relay one online.", "Relay one online."),
                Cue(
                    "The radio feed tags the fallback response.",
                    "The radio feed tags the fallback response.",
                ),
            ),
            (
                Cue("Relay one online.", "Relay one online."),
                Cue("The radio feed tags the fallback.", "The radio feed tags the fallback."),
            ),
        ),
        Line(
            8,
            42.3,
            (
                Cue("Pause holds the run.", "Pause holds the run."),
                Cue("This is not a full playthrough.", "This is not a full playthrough."),
            ),
            (
                Cue("Pause holds the run.", "Pause holds the run."),
                Cue("This is not a full playthrough.", "This is not a full playthrough."),
            ),
        ),
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replace the demo soundtrack with Microsoft Edge neural narration.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--srt", type=Path, default=DEFAULT_SRT)
    parser.add_argument("--narration", type=Path, default=DEFAULT_NARRATION)
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    parser.add_argument("--voice", default=None, help=f"Microsoft neural voice (default {DEFAULT_VOICE})")
    parser.add_argument("--base-rate", default=BASE_RATE, help="edge-tts speaking rate (default +6%%)")
    parser.add_argument("--max-rate", default=MAX_RATE, help="maximum adaptive rate (default +14%%)")
    parser.add_argument("--target-lufs", type=float, default=TARGET_LUFS)
    parser.add_argument("--target-tp", type=float, default=TARGET_TP)
    parser.add_argument("--attempts", type=int, default=SYNTH_ATTEMPTS)
    parser.add_argument("--sentence-gap", type=float, default=SENTENCE_GAP)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Acknowledge that narration text is sent to Microsoft's online speech service.",
    )
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(argv)


def load_edge_tts() -> Any:
    global edge_tts
    if edge_tts is not None:
        return edge_tts
    try:
        import edge_tts as module  # type: ignore
    except ImportError as exc:
        raise NarrationError(
            "edge-tts is not installed. Run: uv venv .venv && "
            "uv pip install --python .venv/bin/python edge-tts"
        ) from exc
    edge_tts = module
    return module


def resolve_path(value: Path) -> Path:
    return value if value.is_absolute() else (ROOT / value).resolve()


def rate_percent(value: str) -> int:
    match = re.fullmatch(r"\+?(-?\d+)%", value.strip())
    if not match:
        raise NarrationError(f"invalid rate {value!r}; expected a value like +6%")
    return int(match.group(1))


def rate_tag(value: str) -> str:
    return value.strip().replace("+", "p").replace("-", "m").replace("%", "")


def fmt_timecode(seconds: float) -> str:
    minutes = int(seconds // 60)
    return f"{minutes:02d}:{seconds % 60:06.3f}"


def fmt_srt_time(seconds: float) -> str:
    milliseconds = int(round(max(0.0, seconds) * 1000))
    hours, rem = divmod(milliseconds, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def db_value(value: float | None, digits: int = 3) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def dbfs(peak: int | float) -> float | None:
    if peak <= 0:
        return None
    return 20.0 * math.log10(float(peak) / 32768.0)


def run_cmd(cmd: Sequence[Any], timeout: float = 180.0, binary: bool = False) -> subprocess.CompletedProcess:
    args = [str(part) for part in cmd]
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise NarrationError(f"required executable not found: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise NarrationError(f"command timed out after {timeout:.0f}s: {args[0]}") from exc
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace")[-4000:]
        raise NarrationError(f"command failed ({proc.returncode}): {' '.join(args)}\n{stderr}")
    if binary:
        return proc
    return proc


def run_stdout(cmd: Sequence[Any], timeout: float = 180.0) -> str:
    proc = run_cmd(cmd, timeout=timeout)
    return proc.stdout.decode("utf-8", "replace")


def run_stderr(cmd: Sequence[Any], timeout: float = 180.0) -> str:
    proc = run_cmd(cmd, timeout=timeout)
    return proc.stderr.decode("utf-8", "replace")


def ensure_tools() -> None:
    for name, path in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)):
        found = shutil.which(path) or shutil.which(name)
        if not found:
            raise NarrationError(f"{name} not found; expected {path} or on PATH")
        globals()[name.upper()] = found


def probe(path: Path) -> dict[str, Any]:
    raw = run_stdout([FFPROBE, "-v", "error", "-show_format", "-show_streams", "-of", "json", path])
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise NarrationError(f"ffprobe returned invalid JSON for {path}") from exc


def first_stream(info: dict[str, Any], codec_type: str) -> dict[str, Any] | None:
    for stream in info.get("streams", []):
        if stream.get("codec_type") == codec_type:
            return stream
    return None


def verify_source(info: dict[str, Any], path: Path) -> float:
    video = first_stream(info, "video")
    audio = first_stream(info, "audio")
    if not video:
        raise NarrationError(f"{path} has no video stream")
    if not audio:
        raise NarrationError(f"{path} has no audio stream to replace")
    if video.get("codec_name") != EXPECTED_VIDEO["codec"]:
        raise NarrationError(f"unexpected video codec: {video.get('codec_name')}")
    if video.get("width") != EXPECTED_VIDEO["width"] or video.get("height") != EXPECTED_VIDEO["height"]:
        raise NarrationError(f"unexpected video size: {video.get('width')}x{video.get('height')}")
    if video.get("avg_frame_rate") != EXPECTED_VIDEO["fps"]:
        raise NarrationError(f"unexpected frame rate: {video.get('avg_frame_rate')}")
    duration = float(info.get("format", {}).get("duration", 0.0))
    if abs(duration - SOURCE_DURATION) > 0.01:
        raise NarrationError(f"unexpected source duration {duration:.3f}s; expected {SOURCE_DURATION:.1f}s")
    return duration


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def video_hashes(path: Path) -> dict[str, Any]:
    packet_line = run_stdout(
        [FFMPEG, "-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"]
    ).strip()
    frame_line = run_stdout(
        [FFMPEG, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "hash", "-hash", "sha256", "-"]
    ).strip()
    counts_raw = run_stdout(
        [
            FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_packets,nb_read_frames",
            "-of",
            "json",
            path,
        ]
    )
    counts = json.loads(counts_raw)["streams"][0]
    return {
        "packet_sha256": packet_line.split("=", 1)[-1],
        "frame_sha256": frame_line.split("=", 1)[-1],
        "packets": int(counts["nb_read_packets"]),
        "frames": int(counts["nb_read_frames"]),
    }


def preserve_source(input_path: Path, workdir: Path, run_id: str, packet_hash: str) -> Path:
    backup = workdir / "source-before.mp4"
    if backup.exists():
        try:
            if video_hashes(backup)["packet_sha256"] == packet_hash:
                return backup
        except NarrationError:
            pass
        backup = workdir / f"source-before-{run_id}.mp4"
    if input_path.resolve() == backup.resolve():
        return backup
    shutil.copy2(input_path, backup)
    return backup


def list_voices(attempts: int) -> tuple[list[dict[str, Any]] | None, str | None, int]:
    module = load_edge_tts()
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            voices = asyncio.run(asyncio.wait_for(module.list_voices(), timeout=30.0))
            return list(voices), None, attempt
        except Exception as exc:  # noqa: BLE001 - service errors are heterogeneous
            last_error = exc
            if attempt < attempts:
                time.sleep(1.5 * attempt)
    assert last_error is not None
    return None, f"{type(last_error).__name__}: {last_error}", attempts


def resolve_voice(requested: str | None, explicit: bool, attempts: int) -> tuple[str, dict[str, Any] | None, str | None, int, bool]:
    requested = requested or DEFAULT_VOICE
    voices, error, tries = list_voices(attempts)
    if voices is None:
        if explicit:
            raise NarrationError(
                f"could not verify Microsoft voice {requested!r} and the voice list is unavailable: {error}"
            )
        print(f"warning: could not list Microsoft voices ({error}); trying {requested} anyway", file=sys.stderr)
        return requested, None, error, tries, False
    by_name = {voice["ShortName"]: voice for voice in voices}
    if requested in by_name:
        return requested, by_name[requested], None, tries, False
    if explicit:
        raise NarrationError(f"Microsoft voice {requested!r} is not available")
    for candidate in FALLBACK_VOICES:
        if candidate in by_name:
            print(f"warning: {requested} unavailable; using {candidate}", file=sys.stderr)
            return candidate, by_name[candidate], None, tries, True
    raise NarrationError(f"no suitable Microsoft en-US neural voice found; requested {requested!r}")


async def synthesize_async(text: str, voice: str, rate: str, destination: Path) -> list[dict[str, Any]]:
    module = load_edge_tts()
    audio = bytearray()
    boundaries: list[dict[str, Any]] = []
    communicate = module.Communicate(
        text,
        voice,
        rate=rate,
        volume="+0%",
        pitch="+0Hz",
        boundary="WordBoundary",
        connect_timeout=10,
        receive_timeout=45,
    )
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            boundaries.append(
                {
                    "text": chunk["text"],
                    "offset_seconds": round(chunk["offset"] / 1e7, 4),
                    "duration_seconds": round(chunk["duration"] / 1e7, 4),
                }
            )
    if not audio:
        raise NarrationError("Microsoft Edge speech service returned no audio")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(destination.name + ".part")
    temp.write_bytes(bytes(audio))
    os.replace(temp, destination)
    return boundaries


def synthesize(text: str, voice: str, rate: str, destination: Path, attempts: int) -> tuple[list[dict[str, Any]], int]:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            boundaries = asyncio.run(
                asyncio.wait_for(synthesize_async(text, voice, rate, destination), timeout=SYNTH_TIMEOUT)
            )
            return boundaries, attempt
        except Exception as exc:  # noqa: BLE001 - service errors are heterogeneous
            last_error = exc
            if attempt < attempts:
                delay = 1.5 * attempt
                print(
                    f"    retry {attempt}/{attempts - 1} in {delay:.1f}s "
                    f"({type(exc).__name__}: {exc})",
                    file=sys.stderr,
                )
                time.sleep(delay)
    assert last_error is not None
    raise NarrationError(
        f"Microsoft Edge speech service failed after {attempts} bounded attempts: "
        f"{type(last_error).__name__}: {last_error}"
    )


def decode_audio(path: Path) -> array.array:
    proc = run_cmd(
        [FFMPEG, "-v", "error", "-i", path, "-map", "0:a:0", "-ac", CHANNELS, "-ar", SAMPLE_RATE, "-f", "s16le", "-"],
        timeout=120.0,
        binary=True,
    )
    samples = array.array("h")
    samples.frombytes(proc.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    if len(samples) < CHANNELS:
        raise NarrationError(f"decoded audio is empty: {path}")
    return samples


def pcm_bytes(samples: array.array) -> bytes:
    if sys.byteorder == "little":
        return samples.tobytes()
    copy = array.array("h", samples)
    copy.byteswap()
    return copy.tobytes()


def analyze_clip(
    samples: array.array,
    boundaries: list[dict[str, Any]],
    rate: str,
    source_text: str,
) -> Clip:
    frames = len(samples) // CHANNELS
    threshold = int(round(32768 * 10 ** (TRIM_THRESHOLD_DBFS / 20.0)))
    first: int | None = None
    last: int | None = None
    for index in range(frames):
        left = samples[index * CHANNELS]
        right = samples[index * CHANNELS + 1]
        if left < 0:
            left = -left
        if right < 0:
            right = -right
        if left > threshold or right > threshold:
            if first is None:
                first = index
            last = index
    if first is None or last is None:
        raise NarrationError(f"synthesized clip is silent: {source_text!r}")
    pre = int(PRE_ROLL * SAMPLE_RATE)
    post = int(POST_ROLL * SAMPLE_RATE)
    kept_start = max(0, first - pre)
    kept_end = min(frames, last + 1 + post)
    trimmed = array.array("h", samples[kept_start * CHANNELS : kept_end * CHANNELS])
    kept_frames = len(trimmed) // CHANNELS
    fade_in = min(int(FADE_IN * SAMPLE_RATE), kept_frames)
    for index in range(fade_in):
        gain = index / fade_in
        trimmed[index * CHANNELS] = int(trimmed[index * CHANNELS] * gain)
        trimmed[index * CHANNELS + 1] = int(trimmed[index * CHANNELS + 1] * gain)
    fade_out = min(int(FADE_OUT * SAMPLE_RATE), kept_frames)
    for index in range(fade_out):
        gain = index / fade_out
        pos = kept_frames - 1 - index
        trimmed[pos * CHANNELS] = int(trimmed[pos * CHANNELS] * gain)
        trimmed[pos * CHANNELS + 1] = int(trimmed[pos * CHANNELS + 1] * gain)
    peak = 0
    for value in trimmed:
        magnitude = abs(value)
        if magnitude > peak:
            peak = magnitude
    return Clip(
        samples=trimmed,
        duration=kept_frames / SAMPLE_RATE,
        speech_start=(first - kept_start) / SAMPLE_RATE,
        speech_end=(last + 1 - kept_start) / SAMPLE_RATE,
        first_voiced_sample=first,
        last_voiced_sample=last,
        kept_start_sample=kept_start,
        kept_end_sample=kept_end,
        peak_dbfs=dbfs(peak),
        boundaries=boundaries,
        rate=rate,
        source_text=source_text,
    )


def synthesize_line(line: Line, cues: tuple[Cue, ...], rate: str, voice: str, tts_dir: Path, attempts: int) -> tuple[list[Clip], int]:
    clips: list[Clip] = []
    calls = 0
    for index, cue in enumerate(cues, start=1):
        mp3 = tts_dir / f"line{line.index:02d}_cue{index:02d}_{rate_tag(rate)}.mp3"
        boundaries, used_attempts = synthesize(cue.speech, voice, rate, mp3, attempts)
        calls += used_attempts
        clips.append(analyze_clip(decode_audio(mp3), boundaries, rate, cue.speech))
    return clips, calls


def span_for(clips: Sequence[Clip], gap: float) -> float:
    return sum(clip.duration for clip in clips) + gap * max(0, len(clips) - 1)


def available_for(line: Line, lines: Sequence[Line], duration: float) -> float:
    position = list(lines).index(line)
    if position + 1 < len(lines):
        return lines[position + 1].anchor - line.anchor - MIN_TAIL_GAP
    return duration - line.anchor - END_PAD


def required_rate(current_rate: str, span: float, available: float, maximum: str) -> int:
    current = rate_percent(current_rate)
    factor = span / max(available, 0.001)
    needed = math.ceil(((1.0 + current / 100.0) * factor - 1.0) * 100.0) + 1
    return max(current + 1, min(rate_percent(maximum), needed))


def fit_line(
    line: Line,
    lines: Sequence[Line],
    duration: float,
    voice: str,
    base_rate: str,
    maximum_rate: str,
    gap: float,
    tts_dir: Path,
    attempts: int,
) -> LineResult:
    available = available_for(line, lines, duration)
    if available <= 0.5:
        raise NarrationError(f"line {line.index} has no usable window ({available:.2f}s)")
    clips, calls = synthesize_line(line, line.cues, base_rate, voice, tts_dir, attempts)
    span = span_for(clips, gap)
    if span <= available:
        return LineResult(line, clips, base_rate, False, line.cues, span, available, calls)
    target = required_rate(base_rate, span, available, maximum_rate)
    print(
        f"  line {line.index}: {span:.2f}s at {base_rate} exceeds {available:.2f}s; "
        f"retrying at +{target}%"
    )
    retry_clips, retry_calls = synthesize_line(line, line.cues, f"+{target}%", voice, tts_dir, attempts)
    retry_span = span_for(retry_clips, gap)
    calls += retry_calls
    if retry_span <= available:
        return LineResult(line, retry_clips, f"+{target}%", False, line.cues, retry_span, available, calls)
    if line.short_cues != line.cues:
        print(f"  line {line.index}: shortening copy to fit the scene window")
        short_clips, short_calls = synthesize_line(line, line.short_cues, base_rate, voice, tts_dir, attempts)
        short_span = span_for(short_clips, gap)
        calls += short_calls
        if short_span <= available:
            return LineResult(line, short_clips, base_rate, True, line.short_cues, short_span, available, calls)
        short_max_clips, short_max_calls = synthesize_line(
            line, line.short_cues, maximum_rate, voice, tts_dir, attempts
        )
        short_max_span = span_for(short_max_clips, gap)
        calls += short_max_calls
        if short_max_span <= available:
            return LineResult(
                line, short_max_clips, maximum_rate, True, line.short_cues, short_max_span, available, calls
            )
    raise NarrationError(
        f"line {line.index} cannot fit naturally: {span:.2f}s in {available:.2f}s "
        f"even at {maximum_rate}; refusing to force an unnatural rate"
    )


def place_line(result: LineResult, gap: float) -> tuple[list[dict[str, Any]], float]:
    cursor = result.line.anchor
    placed: list[dict[str, Any]] = []
    for cue, clip in zip(result.used_cues, result.clips):
        start = cursor + clip.speech_start
        end = cursor + clip.speech_end
        placed.append(
            {
                "line": result.line.index,
                "text": cue.caption,
                "speech": cue.speech,
                "start": start,
                "end": end,
                "placement_start": cursor,
                "placement_end": cursor + clip.duration,
                "rate": result.rate,
                "clip": clip,
            }
        )
        cursor += clip.duration + gap
    return placed, cursor - gap


def write_wav(path: Path, samples: array.array) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(SAMPLE_WIDTH)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm_bytes(samples))


def build_reference(results: Sequence[LineResult], path: Path) -> None:
    samples = array.array("h")
    gap_frames = int(REFERENCE_GAP * SAMPLE_RATE)
    for result in results:
        for clip in result.clips:
            samples.extend(clip.samples)
            samples.extend([0] * (gap_frames * CHANNELS))
    write_wav(path, samples)


def measure_loudness(path: Path, target_lufs: float, target_tp: float) -> dict[str, Any]:
    stderr = run_stderr(
        [
            FFMPEG,
            "-hide_banner",
            "-nostats",
            "-i",
            path,
            "-map",
            "0:a:0",
            "-af",
            f"loudnorm=I={target_lufs}:TP={target_tp}:LRA=7:print_format=json",
            "-f",
            "null",
            "-",
        ],
        timeout=120.0,
    )
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not blocks:
        raise NarrationError("could not parse loudnorm output")
    data = json.loads(blocks[-1])
    parsed: dict[str, Any] = {}
    for key in ("input_i", "input_tp", "input_lra", "input_thresh", "output_i", "output_tp"):
        try:
            parsed[key] = float(data[key])
        except (KeyError, TypeError, ValueError):
            parsed[key] = None
    return parsed


def pcm_stats(samples: array.array) -> dict[str, Any]:
    peak = 0
    sum_squares = 0
    clipping = 0
    for value in samples:
        magnitude = abs(value)
        if magnitude > peak:
            peak = magnitude
        if magnitude >= 32767:
            clipping += 1
        sum_squares += value * value
    count = len(samples)
    rms = math.sqrt(sum_squares / count) if count else 0.0
    return {
        "peak": peak,
        "peak_dbfs": db_value(dbfs(peak)),
        "rms_dbfs": db_value(dbfs(rms)),
        "clipping_samples": clipping,
    }


def apply_gain(samples: array.array, gain_db: float) -> array.array:
    factor = 10 ** (gain_db / 20.0)
    output = array.array("h", [0]) * len(samples)
    for index, value in enumerate(samples):
        scaled = int(round(value * factor))
        if scaled > 32767:
            scaled = 32767
        elif scaled < -32768:
            scaled = -32768
        output[index] = scaled
    return output


def gap_intervals(placed: Sequence[dict[str, Any]], duration: float) -> list[tuple[float, float]]:
    cursor = 0.0
    intervals: list[tuple[float, float]] = []
    for item in sorted(placed, key=lambda entry: entry["placement_start"]):
        start = float(item["placement_start"])
        end = float(item["placement_end"])
        if start > cursor + 0.05:
            intervals.append((cursor, start))
        cursor = max(cursor, end)
    if duration > cursor + 0.05:
        intervals.append((cursor, duration))
    return intervals


def gap_peak_dbfs(samples: array.array, intervals: Sequence[tuple[float, float]]) -> tuple[float | None, int]:
    peak = 0
    total = 0
    for start, end in intervals:
        first = max(0, int(round(start * SAMPLE_RATE)))
        last = min(len(samples) // CHANNELS, int(round(end * SAMPLE_RATE)))
        total += max(0, last - first)
        for index in range(first * CHANNELS, last * CHANNELS):
            magnitude = abs(samples[index])
            if magnitude > peak:
                peak = magnitude
    return db_value(dbfs(peak)), total


def build_mix(duration: float, placed: Sequence[dict[str, Any]], gain_db: float) -> array.array:
    total_frames = int(round(duration * SAMPLE_RATE))
    mix = array.array("h", [0]) * (total_frames * CHANNELS)
    last_end = 0
    for item in sorted(placed, key=lambda entry: entry["placement_start"]):
        clip: Clip = item["clip"]
        start = int(round(float(item["placement_start"]) * SAMPLE_RATE))
        scaled = apply_gain(clip.samples, gain_db)
        end = start + len(scaled) // CHANNELS
        if start < 0 or end > total_frames:
            raise NarrationError(f"audio placement out of range for line {item['line']}")
        if start < last_end:
            raise NarrationError(f"audio overlap detected at line {item['line']}")
        mix[start * CHANNELS : end * CHANNELS] = scaled
        last_end = end
    return mix


def srt_text(cues: Sequence[dict[str, Any]]) -> str:
    blocks: list[str] = []
    previous_start = -1.0
    for index, cue in enumerate(sorted(cues, key=lambda entry: entry["start"]), start=1):
        start = max(float(cue["start"]), previous_start + 0.001)
        end = max(float(cue["end"]), start + 0.05)
        previous_start = start
        blocks.append(f"{index}\n{fmt_srt_time(start)} --> {fmt_srt_time(end)}\n{cue['text']}\n")
    return "\n".join(blocks)


def narration_text(
    lines: Sequence[Line],
    results: Sequence[LineResult],
    cues: Sequence[dict[str, Any]],
    voice: str,
    base_rate: str,
    maximum_rate: str,
    duration: float,
) -> str:
    rates = sorted({result.rate for result in results}, key=rate_percent)
    if rates == [base_rate]:
        rate_description = base_rate
    else:
        rate_description = f"{base_rate} base, per-line fit up to {maximum_rate}"
    rows = []
    for line, result in zip(lines, results):
        transcript = " ".join(cue.caption for cue in result.used_cues)
        rows.append(f"{fmt_timecode(line.anchor)}      {transcript}")
    return (
        "Dead Frequency: demo narration\n"
        f"Delivered video: dead-frequency-demo.mp4 ({duration:.1f} s, 1280x720, 25 fps, H.264/AAC)\n"
        f"Voice: Microsoft Edge neural TTS, {voice} (en-US), rate {rate_description}, generated online.\n"
        "Warning: every synthesis run sends this nonpersonal narration text to Microsoft's Edge speech service.\n"
        "No background music, room tone, or synthetic bed was mixed; gaps are digital silence.\n"
        "Timing is relative to the delivered MP4. The final ~7.9 s is the real pause overlay; the simulation is paused, so those pixels are still by design.\n"
        f"Captions: {len(cues)} sentence-level cues in dead-frequency-demo.srt, timed from the synthesized speech.\n"
        "\n"
        "TIMECODE     TRANSCRIPT\n"
        + "\n".join(rows)
        + "\n\n"
        "Coverage note: this is a demo walkthrough, not a full playthrough. It shows one of three relays, "
        "the scripted fallback line, and the pause overlay.\n"
    )


def mux_video(source: Path, wav: Path, candidate: Path, duration: float) -> None:
    candidate.parent.mkdir(parents=True, exist_ok=True)
    run_cmd(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            source,
            "-i",
            wav,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            AUDIO_BITRATE,
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            f"handler_name={AUDIO_HANDLER}",
            "-t",
            f"{duration:.6f}",
            candidate,
        ],
        timeout=300.0,
    )


def audio_summary(path: Path, target_lufs: float, target_tp: float) -> dict[str, Any]:
    info = probe(path)
    stream = first_stream(info, "audio")
    if not stream:
        raise NarrationError(f"no audio stream in {path}")
    samples = decode_audio(path)
    stats = pcm_stats(samples)
    loudness = measure_loudness(path, target_lufs, target_tp)
    return {
        "stream": {
            "codec": stream.get("codec_name"),
            "profile": stream.get("profile"),
            "sample_rate": int(stream.get("sample_rate", 0)),
            "channels": int(stream.get("channels", 0)),
            "channel_layout": stream.get("channel_layout"),
            "bit_rate": int(stream.get("bit_rate", 0)),
            "duration": float(stream.get("duration", 0.0)),
        },
        "decoded_samples": len(samples) // CHANNELS,
        "decoded_peak_dbfs": stats["peak_dbfs"],
        "decoded_rms_dbfs": stats["rms_dbfs"],
        "decoded_clipping_samples": stats["clipping_samples"],
        "loudness": {key: db_value(value) for key, value in loudness.items()},
    }


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def replace_candidate(candidate: Path, output: Path) -> None:
    try:
        os.replace(candidate, output)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        temp = output.with_name(f".{output.name}.tmp-{os.getpid()}")
        shutil.copy2(candidate, temp)
        os.replace(temp, output)
        candidate.unlink(missing_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.yes:
        print(
            "WARNING: this script sends non-personal narration text to Microsoft's online Edge speech service.\n"
            "         Every run synthesizes the narration again. No offline or other-provider fallback is used.\n"
            "Refusing to run without --yes.",
            file=sys.stderr,
        )
        return 2

    try:
        return run(args)
    except NarrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        if args.debug:
            raise
        return 1
    except KeyboardInterrupt:
        print("Interrupted; deliverable was not replaced.", file=sys.stderr)
        return 130


def run(args: argparse.Namespace) -> int:
    ensure_tools()
    load_edge_tts()
    input_path = resolve_path(args.input)
    output_path = resolve_path(args.output)
    srt_path = resolve_path(args.srt)
    narration_path = resolve_path(args.narration)
    workdir = resolve_path(args.workdir)
    base_rate = args.base_rate
    maximum_rate = args.max_rate
    base_pct = rate_percent(base_rate)
    max_pct = rate_percent(maximum_rate)
    if base_pct < 0 or max_pct > 25 or base_pct > max_pct:
        raise NarrationError("rates must satisfy 0 <= base <= max <= 25%")
    if args.attempts < 1 or args.attempts > 5:
        raise NarrationError("--attempts must be between 1 and 5")
    if not 0.05 <= args.sentence_gap <= 0.5:
        raise NarrationError("--sentence-gap must be between 0.05 and 0.5 seconds")
    if not input_path.is_file():
        raise NarrationError(f"input video not found: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    narration_path.parent.mkdir(parents=True, exist_ok=True)
    workdir.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    tts_dir = workdir / "tts" / run_id
    tts_dir.mkdir(parents=True, exist_ok=True)

    print("WARNING: narration text goes to Microsoft's online Edge speech service on this run.")
    print("         No Azure credentials, paid API, or other TTS provider is used.")
    print(f"Input:  {input_path}")
    print(f"Output: {output_path}")
    if output_path.exists():
        print("         Existing deliverable will be replaced only after all verification passes.")

    started = time.monotonic()
    source_info = probe(input_path)
    duration = verify_source(source_info, input_path)
    source_sha = sha256_file(input_path)
    source_size = input_path.stat().st_size
    source_video = video_hashes(input_path)
    source_audio = first_stream(source_info, "audio")
    print(
        f"Source: {duration:.3f}s, {source_video['frames']} video frames, "
        f"{source_size} bytes, video packet {source_video['packet_sha256'][:12]}..."
    )

    backup = preserve_source(input_path, workdir, run_id, source_video["packet_sha256"])
    print(f"Preserved prior file: {backup}")
    protected_before = {
        "poster_sha256": sha256_file(POSTER) if POSTER.exists() else None,
        "lighting_demo_sha256": sha256_file(LIGHTING_DEMO) if LIGHTING_DEMO.exists() else None,
    }

    requested = args.voice or DEFAULT_VOICE
    voice, voice_meta, voice_error, voice_tries, fallback_used = resolve_voice(
        args.voice, args.voice is not None, args.attempts
    )
    print(f"Voice: {voice}" + (" (fallback)" if fallback_used else ""))

    lines = narration_lines()
    anchors = [line.anchor for line in lines]
    if anchors != sorted(anchors) or len(set(anchors)) != len(anchors):
        raise NarrationError("narration anchors must be unique and increasing")
    if anchors[-1] + 0.5 >= duration:
        raise NarrationError("last narration anchor does not fit inside the source duration")

    results: list[LineResult] = []
    all_placed: list[dict[str, Any]] = []
    synthesis_started = time.monotonic()
    for line in lines:
        result = fit_line(
            line,
            lines,
            duration,
            voice,
            base_rate,
            maximum_rate,
            args.sentence_gap,
            tts_dir,
            args.attempts,
        )
        placed, line_end = place_line(result, args.sentence_gap)
        if line_end > line.anchor + result.available:
            raise NarrationError(f"line {line.index} exceeded its scene window after placement")
        results.append(result)
        all_placed.extend(placed)
        print(
            f"[{line.index}/{len(lines)}] {fmt_timecode(line.anchor)}  {result.span:.2f}s "
            f"of {result.available:.2f}s at {result.rate}"
            + (" (short copy)" if result.short_variant else "")
        )
        for item in placed:
            print(f"    {fmt_srt_time(item['start'])} -> {fmt_srt_time(item['end'])}  {item['text']}")
    synthesis_elapsed = time.monotonic() - synthesis_started

    reference_wav = workdir / f"speech-reference-{run_id}.wav"
    build_reference(results, reference_wav)
    reference_loudness = measure_loudness(reference_wav, args.target_lufs, args.target_tp)
    reference_samples = decode_audio(reference_wav)
    reference_stats = pcm_stats(reference_samples)
    if reference_loudness["input_i"] is None or reference_stats["peak_dbfs"] is None:
        raise NarrationError("speech reference is silent; refusing to build a silent track")
    gain_i = args.target_lufs - reference_loudness["input_i"]
    gain_peak = args.target_tp - reference_stats["peak_dbfs"]
    gain = min(gain_i, gain_peak)
    limited_by_peak = gain_peak < gain_i
    capped = False
    if gain > MAX_GAIN_DB:
        gain = MAX_GAIN_DB
        capped = True
    print(
        f"Speech reference: {reference_loudness['input_i']:.2f} LUFS, "
        f"peak {reference_stats['peak_dbfs']:.2f} dBFS; applying {gain:+.2f} dB"
    )

    mix = build_mix(duration, all_placed, gain)
    wav_path = workdir / f"narration-mix-{run_id}.wav"
    write_wav(wav_path, mix)
    mix_stats = pcm_stats(mix)
    gaps = gap_intervals(all_placed, duration)
    mix_gap_peak, gap_samples = gap_peak_dbfs(mix, gaps)
    if mix_stats["clipping_samples"]:
        raise NarrationError(f"mix contains {mix_stats['clipping_samples']} full-scale samples")
    if mix_gap_peak is not None and mix_gap_peak > -60.0:
        raise NarrationError(f"unexpected audio in gaps: {mix_gap_peak:.1f} dBFS")
    print(
        f"Mix: peak {mix_stats['peak_dbfs']:.2f} dBFS, RMS {mix_stats['rms_dbfs']:.2f} dBFS, "
        f"gaps {'digital silence' if mix_gap_peak is None else f'{mix_gap_peak:.1f} dBFS'}"
    )

    srt = srt_text(all_placed)
    narration = narration_text(
        lines, results, all_placed, voice, base_rate, maximum_rate, duration
    )
    srt_temp = workdir / f"dead-frequency-demo-{run_id}.srt"
    narration_temp = workdir / f"narration-{run_id}.txt"
    atomic_write(srt_temp, srt.encode("utf-8"))
    atomic_write(narration_temp, narration.encode("utf-8"))

    candidate = workdir / f"candidate-{run_id}.mp4"
    mux_video(input_path, wav_path, candidate, duration)
    output_info = probe(candidate)
    output_video = video_hashes(candidate)
    output_duration = float(output_info.get("format", {}).get("duration", 0.0))
    output_audio = first_stream(output_info, "audio")
    if output_video["packet_sha256"] != source_video["packet_sha256"]:
        raise NarrationError("video packet hash changed; refusing to replace the deliverable")
    if output_video["frame_sha256"] != source_video["frame_sha256"]:
        raise NarrationError("decoded video frame hash changed; refusing to replace the deliverable")
    if output_video["frames"] != source_video["frames"]:
        raise NarrationError("video frame count changed; refusing to replace the deliverable")
    if abs(output_duration - duration) > 0.005:
        raise NarrationError(f"output duration changed to {output_duration:.3f}s; refusing to replace")
    if not output_audio or output_audio.get("codec_name") != "aac":
        raise NarrationError("output audio stream is not AAC")
    if int(output_audio.get("sample_rate", 0)) != SAMPLE_RATE or int(output_audio.get("channels", 0)) != CHANNELS:
        raise NarrationError("output audio is not 48 kHz stereo")

    final_audio = audio_summary(candidate, args.target_lufs, args.target_tp)
    final_samples = decode_audio(candidate)
    final_gap_peak, final_gap_samples = gap_peak_dbfs(final_samples, gaps)
    max_volume = final_audio["decoded_peak_dbfs"]
    if final_audio["decoded_clipping_samples"]:
        raise NarrationError("encoded output contains full-scale samples")
    if max_volume is None or max_volume > -1.0:
        raise NarrationError(f"encoded output peak is too high: {max_volume} dBFS")
    if max_volume < -30.0:
        raise NarrationError(f"encoded output is effectively silent: {max_volume} dBFS")
    if final_audio["decoded_samples"] < int(duration * SAMPLE_RATE) - 2:
        raise NarrationError("encoded audio is shorter than the video duration")
    if final_gap_peak is not None and final_gap_peak > -50.0:
        raise NarrationError(f"encoded gaps contain audible energy: {final_gap_peak:.1f} dBFS")
    candidate_sha = sha256_file(candidate)
    candidate_size = candidate.stat().st_size

    protected_after_mux = {
        "poster_sha256": sha256_file(POSTER) if POSTER.exists() else None,
        "lighting_demo_sha256": sha256_file(LIGHTING_DEMO) if LIGHTING_DEMO.exists() else None,
    }
    if protected_after_mux != protected_before:
        raise NarrationError("poster or lighting demo changed unexpectedly")

    print("Video stream hashes match. Replacing the deliverable atomically.")
    replace_candidate(candidate, output_path)
    if sha256_file(output_path) != candidate_sha:
        raise NarrationError("destination hash differs after atomic replace")
    os.replace(srt_temp, srt_path)
    os.replace(narration_temp, narration_path)

    output_info = probe(output_path)
    output_video = video_hashes(output_path)
    final_audio = audio_summary(output_path, args.target_lufs, args.target_tp)
    final_samples = decode_audio(output_path)
    final_gap_peak, final_gap_samples = gap_peak_dbfs(final_samples, gaps)
    protected_after = {
        "poster_sha256": sha256_file(POSTER) if POSTER.exists() else None,
        "lighting_demo_sha256": sha256_file(LIGHTING_DEMO) if LIGHTING_DEMO.exists() else None,
    }

    srt_cue_count = len(all_placed)
    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "warning": (
            "Narration text is sent to Microsoft's online Edge speech service on every synthesis run. "
            "No Azure credentials or paid API are used, and there is no other-provider fallback."
        ),
        "service": {
            "provider": "Microsoft Edge online neural TTS via edge-tts",
            "voice": voice,
            "requested_voice": requested,
            "fallback_used": fallback_used,
            "voice_metadata": voice_meta,
            "voice_list_error": voice_error,
            "voice_list_attempts": voice_tries,
            "rate": base_rate,
            "adaptive_max_rate": maximum_rate,
            "rate_per_line": [result.rate for result in results],
            "volume": "+0%",
            "pitch": "+0Hz",
            "boundary": "WordBoundary",
            "azure_credentials_used": False,
        },
        "versions": {
            "edge_tts": importlib.metadata.version("edge-tts"),
            "aiohttp": importlib.metadata.version("aiohttp"),
            "python": platform.python_version(),
            "ffmpeg": run_stdout([FFMPEG, "-version"]).splitlines()[0],
            "ffprobe": run_stdout([FFPROBE, "-version"]).splitlines()[0],
            "platform": platform.platform(),
        },
        "paths": {
            "input": str(input_path),
            "output": str(output_path),
            "srt": str(srt_path),
            "narration": str(narration_path),
            "workdir": str(workdir),
            "preserved_prior": str(backup),
            "speech_reference_wav": str(reference_wav),
            "mix_wav": str(wav_path),
        },
        "source": {
            "duration_seconds": duration,
            "size_bytes": source_size,
            "sha256": source_sha,
            "video": source_video,
            "audio_stream": {
                "codec": source_audio.get("codec_name"),
                "sample_rate": int(source_audio.get("sample_rate", 0)),
                "channels": int(source_audio.get("channels", 0)),
                "bit_rate": int(source_audio.get("bit_rate", 0)),
            },
        },
        "timing": {
            "anchors_seconds": anchors,
            "sentence_gap_seconds": args.sentence_gap,
            "base_rate": base_rate,
            "maximum_rate": maximum_rate,
            "lines": [
                {
                    "index": result.line.index,
                    "anchor": result.line.anchor,
                    "rate": result.rate,
                    "short_variant_used": result.short_variant,
                    "span_seconds": round(result.span, 3),
                    "available_seconds": round(result.available, 3),
                    "synthesis_calls": result.synthesis_calls,
                    "cues": [
                        {
                            "text": item["text"],
                            "speech": item["speech"],
                            "start": round(item["start"], 3),
                            "end": round(item["end"], 3),
                            "duration": round(item["end"] - item["start"], 3),
                            "placement_start": round(item["placement_start"], 3),
                            "placement_end": round(item["placement_end"], 3),
                            "word_boundaries": item["clip"].boundaries,
                            "first_word_offset_seconds": (
                                item["clip"].boundaries[0]["offset_seconds"]
                                if item["clip"].boundaries
                                else None
                            ),
                            "last_word_end_seconds": (
                                item["clip"].boundaries[-1]["offset_seconds"]
                                + item["clip"].boundaries[-1]["duration_seconds"]
                                if item["clip"].boundaries
                                else None
                            ),
                        }
                        for item in all_placed
                        if item["line"] == result.line.index
                    ],
                }
                for result in results
            ],
            "cue_count": srt_cue_count,
            "speech_active_seconds": round(sum(result.span for result in results), 3),
            "synthesis_elapsed_seconds": round(synthesis_elapsed, 3),
        },
        "processing": {
            "trim_threshold_dbfs": TRIM_THRESHOLD_DBFS,
            "pre_roll_ms": PRE_ROLL * 1000,
            "post_roll_ms": POST_ROLL * 1000,
            "fade_in_ms": FADE_IN * 1000,
            "fade_out_ms": FADE_OUT * 1000,
            "target_lufs": args.target_lufs,
            "target_true_peak_dbfs": args.target_tp,
            "speech_reference_loudness": {
                key: db_value(value) for key, value in reference_loudness.items()
            },
            "speech_reference_peak_dbfs": reference_stats["peak_dbfs"],
            "applied_gain_db": round(gain, 3),
            "gain_limited_by_peak": limited_by_peak,
            "gain_capped_at_6db": capped,
            "mix_peak_dbfs": mix_stats["peak_dbfs"],
            "mix_rms_dbfs": mix_stats["rms_dbfs"],
            "mix_clipping_samples": mix_stats["clipping_samples"],
            "mix_gap_peak_dbfs": mix_gap_peak,
            "gap_samples_checked": gap_samples,
            "encoded_gap_peak_dbfs": final_gap_peak,
            "encoded_gap_samples_checked": final_gap_samples,
        },
        "audio": {
            "decoded_samples": final_audio["decoded_samples"],
            "decoded_peak_dbfs": final_audio["decoded_peak_dbfs"],
            "decoded_rms_dbfs": final_audio["decoded_rms_dbfs"],
            "decoded_clipping_samples": final_audio["decoded_clipping_samples"],
            "loudness": final_audio["loudness"],
            "stream": final_audio["stream"],
        },
        "srt": {
            "path": str(srt_path),
            "cue_count": srt_cue_count,
            "first_cue": srt.splitlines()[1] if srt else None,
            "last_cue": srt.splitlines()[-2] if srt else None,
        },
        "output": {
            "path": str(output_path),
            "duration_seconds": output_duration,
            "size_bytes": output_path.stat().st_size,
            "sha256": sha256_file(output_path),
            "format": output_info.get("format", {}),
            "streams": output_info.get("streams", []),
            "video": output_video,
        },
        "protected_files": {
            "poster": {
                "before_sha256": protected_before["poster_sha256"],
                "after_sha256": protected_after["poster_sha256"],
                "unchanged": protected_before["poster_sha256"] == protected_after["poster_sha256"],
            },
            "lighting_demo": {
                "before_sha256": protected_before["lighting_demo_sha256"],
                "after_sha256": protected_after["lighting_demo_sha256"],
                "unchanged": protected_before["lighting_demo_sha256"]
                == protected_after["lighting_demo_sha256"],
            },
        },
        "checks": {
            "duration_preserved": abs(output_duration - duration) <= 0.005,
            "video_packet_hash_equal": output_video["packet_sha256"] == source_video["packet_sha256"],
            "video_frame_hash_equal": output_video["frame_sha256"] == source_video["frame_sha256"],
            "video_frame_count_equal": output_video["frames"] == source_video["frames"],
            "audio_codec_aac": final_audio["stream"]["codec"] == "aac",
            "audio_stereo_48k": final_audio["stream"]["channels"] == CHANNELS
            and final_audio["stream"]["sample_rate"] == SAMPLE_RATE,
            "audio_not_silent": final_audio["decoded_peak_dbfs"] is not None
            and final_audio["decoded_peak_dbfs"] > -30.0,
            "audio_no_clipping": final_audio["decoded_clipping_samples"] == 0,
            "audio_peak_headroom": final_audio["decoded_peak_dbfs"] is not None
            and final_audio["decoded_peak_dbfs"] <= -1.0,
            "gaps_are_silent": final_gap_peak is None or final_gap_peak <= -50.0,
            "captions_from_audio": True,
            "protected_files_unchanged": protected_after == protected_before,
        },
        "known_limits": [
            "Automated checks only; no human listening or subjective quality approval was performed.",
            "Microsoft Edge online speech is a third-party service; exact rendering can change server-side.",
            "The video stream is copied bit-for-bit, but MP4 container metadata and the moov atom may change.",
            "AAC encoding can add very low-level coding noise; the underlying mix gaps are exact digital silence.",
            "Captions are timed from decoded speech edges, with word-boundary metadata included for diagnostics.",
        ],
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    report_path = workdir / "report.json"
    atomic_write(report_path, json.dumps(report, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")

    print("\nDone.")
    print(f"Voice: {voice} at {base_rate}" + (" (fallback)" if fallback_used else ""))
    print(f"Video: {output_video['frames']} frames, packet hash unchanged, duration {output_duration:.3f}s")
    print(
        f"Audio: {final_audio['stream']['codec']} {final_audio['stream']['sample_rate']} Hz "
        f"{final_audio['stream']['channels']} ch, peak {final_audio['decoded_peak_dbfs']:.2f} dBFS, "
        f"clipping samples {final_audio['decoded_clipping_samples']}"
    )
    print(
        f"Gaps: {'digital silence' if final_gap_peak is None else f'{final_gap_peak:.1f} dBFS'} "
        f"({final_gap_samples} samples checked)"
    )
    print(f"Size: {candidate_size} -> {output_path.stat().st_size} bytes")
    print(f"Captions: {srt_cue_count} cues in {srt_path}")
    print(f"Report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
