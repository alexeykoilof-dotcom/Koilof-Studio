import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from flask import Flask, Response, jsonify, request, send_from_directory

APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
OUTPUT_DIR = APP_DIR / "output"
JOBS_DIR = APP_DIR / "jobs"
UPLOADS_DIR = APP_DIR / "uploads"
OUTPUT_DIR.mkdir(exist_ok=True)
JOBS_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")
jobs: Dict[str, Dict] = {}
current_processes: Dict[str, subprocess.Popen] = {}

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
FONT_EXTS = {".ttf", ".otf"}
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")


def safe_filename(name: str, fallback: str = "file") -> str:
    name = Path(name or fallback).name
    name = re.sub(r"[^0-9A-Za-zА-Яа-я._ -]+", "_", name).strip(" ._")
    return name or fallback


def log(job_id: str, message: str) -> None:
    jobs.setdefault(job_id, {}).setdefault("logs", []).append(message)
    print(f"[{job_id}] {message}", flush=True)


def hex_to_ass_color(value: str, default: str = "#FFFFFF") -> str:
    value = (value or default).strip()
    if not re.match(r"^#[0-9a-fA-F]{6}$", value):
        value = default
    r = value[1:3]
    g = value[3:5]
    b = value[5:7]
    return f"&H00{b}{g}{r}"


def clamp_float(value, default: float, min_v: float, max_v: float) -> float:
    try:
        f = float(value)
    except Exception:
        f = default
    return max(min_v, min(max_v, f))


def clamp_int(value, default: int, min_v: int, max_v: int) -> int:
    try:
        i = int(float(value))
    except Exception:
        i = default
    return max(min_v, min(max_v, i))


def ass_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def wrap_text(text: str, max_chars: int) -> str:
    import textwrap
    text = (text or "").strip()
    if not text:
        return ""
    parts = []
    for raw in re.split(r"\n+", text):
        raw = raw.strip()
        if not raw:
            continue
        wrapped = textwrap.wrap(raw, width=max_chars, break_long_words=False, replace_whitespace=False)
        parts.extend(wrapped or [raw])
    return r"\N".join(parts)


def ass_escape_text(text: str) -> str:
    text = text.replace("{", "(").replace("}", ")")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def parse_font_family(font_path: Path) -> Optional[str]:
    """Small TTF/OTF name table parser. Returns a family name if possible."""
    try:
        data = font_path.read_bytes()
        if len(data) < 12:
            return None
        num_tables = int.from_bytes(data[4:6], "big")
        name_offset = name_length = None
        pos = 12
        for _ in range(num_tables):
            tag = data[pos:pos + 4].decode("latin1", "ignore")
            offset = int.from_bytes(data[pos + 8:pos + 12], "big")
            length = int.from_bytes(data[pos + 12:pos + 16], "big")
            if tag == "name":
                name_offset, name_length = offset, length
                break
            pos += 16
        if name_offset is None:
            return None
        table = data[name_offset:name_offset + name_length]
        if len(table) < 6:
            return None
        count = int.from_bytes(table[2:4], "big")
        string_offset = int.from_bytes(table[4:6], "big")
        candidates = []
        for i in range(count):
            rec = 6 + i * 12
            if rec + 12 > len(table):
                continue
            platform = int.from_bytes(table[rec:rec + 2], "big")
            encoding = int.from_bytes(table[rec + 2:rec + 4], "big")
            language = int.from_bytes(table[rec + 4:rec + 6], "big")
            name_id = int.from_bytes(table[rec + 6:rec + 8], "big")
            length = int.from_bytes(table[rec + 8:rec + 10], "big")
            offset = int.from_bytes(table[rec + 10:rec + 12], "big")
            if name_id not in (1, 4, 16):
                continue
            raw = table[string_offset + offset:string_offset + offset + length]
            if not raw:
                continue
            try:
                if platform == 3:
                    txt = raw.decode("utf-16-be", "ignore")
                else:
                    txt = raw.decode("utf-8", "ignore") or raw.decode("latin1", "ignore")
            except Exception:
                continue
            txt = txt.replace("\x00", "").strip()
            if txt:
                score = 0
                if name_id == 1:
                    score += 10
                if language in (0x0409, 0x0000):
                    score += 5
                if platform == 3:
                    score += 3
                candidates.append((score, txt))
        if not candidates:
            return None
        candidates.sort(reverse=True)
        return candidates[0][1]
    except Exception:
        return None


def find_system_font() -> Tuple[str, Optional[Path]]:
    candidates = []
    if os.name == "nt":
        win = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        candidates += [win / "arial.ttf", win / "segoeui.ttf", win / "calibri.ttf", win / "tahoma.ttf"]
    else:
        candidates += [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"),
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/Library/Fonts/Arial.ttf"),
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        ]
    for p in candidates:
        if p.exists():
            fam = parse_font_family(p) or ("Arial" if os.name == "nt" else "DejaVu Sans")
            return fam, p
    return "Arial", None


def ffprobe_duration(path: Path) -> float:
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="ignore")
        return float(out.strip())
    except Exception:
        return 0.0


def ffprobe_has_audio(path: Path) -> bool:
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="ignore")
        return "audio" in out.lower()
    except Exception:
        return False


def create_auto_timings(text: str, duration: float, mode: str, start_pad: float, end_pad: float, min_sec: float) -> List[Dict]:
    lines = [x.strip() for x in re.split(r"\n+", text or "") if x.strip()]
    if not lines:
        return []
    usable = max(0.5, duration - start_pad - end_pad)
    starts_at = max(0.0, start_pad)
    mode = mode or "by_length"
    if mode == "even":
        weights = [1.0 for _ in lines]
    else:
        weights = [max(1.0, len(x)) for x in lines]
    total = sum(weights) or 1.0
    raw_durs = [usable * w / total for w in weights]
    # If min_sec makes the total too large, reduce gracefully.
    if min_sec * len(lines) > usable:
        min_sec = max(0.1, usable / len(lines))
    durs = [max(min_sec, d) for d in raw_durs]
    scale = usable / sum(durs)
    durs = [d * scale for d in durs]
    timings = []
    t = starts_at
    for line, d in zip(lines, durs):
        end = min(duration, t + d)
        timings.append({"start": round(t, 3), "end": round(end, 3), "text": line})
        t = end
    if timings:
        timings[-1]["end"] = round(max(timings[-1]["start"] + 0.2, duration - end_pad), 3)
    return timings


def write_ass(path: Path, timings: List[Dict], project: Dict, font_family: str) -> None:
    width = clamp_int(project.get("width"), 1080, 240, 7680)
    height = clamp_int(project.get("height"), 1920, 240, 7680)
    font_size = clamp_int(project.get("font_size"), 76, 8, 420)
    outline = clamp_int(project.get("stroke_width"), 2, 0, 24)
    max_chars = clamp_int(project.get("max_chars"), 32, 8, 120)
    position = project.get("position", "center")
    animation = project.get("text_animation", "fade")
    text_color = hex_to_ass_color(project.get("text_color"), "#FFFFFF")
    stroke_color = hex_to_ass_color(project.get("stroke_color"), "#000000")

    if position == "top":
        align = 8
        margin_v = max(20, int(height * 0.11))
        y = int(height * 0.18)
    elif position == "bottom":
        align = 2
        margin_v = max(20, int(height * 0.13))
        y = int(height * 0.78)
    else:
        align = 5
        margin_v = 20
        y = int(height * 0.50)
    x = int(width * 0.5)

    style = (
        "Style: Default," +
        f"{font_family},{font_size},{text_color},{text_color},{stroke_color},&H99000000," +
        f"-1,0,0,0,100,100,0,0,1,{outline},0,{align},40,40,{margin_v},1"
    )

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        style,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for item in timings:
        try:
            s = max(0.0, float(item.get("start", 0)))
            e = max(s + 0.05, float(item.get("end", s + 1)))
        except Exception:
            continue
        text = ass_escape_text(str(item.get("text", "")).strip())
        if not text:
            continue
        item_max_chars = clamp_int(item.get("max_chars"), max_chars, 8, 120)
        text = wrap_text(text.upper() if item.get("uppercase") else text, item_max_chars)
        item_animation = item.get("text_animation", animation)
        item_x = int(width * clamp_float(item.get("x"), 50, 0, 100) / 100)
        item_y = int(height * clamp_float(item.get("y"), 50, 0, 100) / 100)
        item_size = clamp_int(item.get("font_size"), font_size, 8, 420)
        item_outline = clamp_int(item.get("stroke_width"), outline, 0, 24)
        item_color = hex_to_ass_color(item.get("text_color"), project.get("text_color", "#FFFFFF"))
        item_stroke = hex_to_ass_color(item.get("stroke_color"), project.get("stroke_color", "#000000"))
        weight = -1 if clamp_int(item.get("weight"), 800, 100, 1000) >= 650 else 0
        base = rf"\an5\pos({item_x},{item_y})\fs{item_size}\c{item_color}\3c{item_stroke}\bord{item_outline}\b{weight}"
        if item_animation in ("rise", "slide_up"):
            override = rf"{{{base}\move({item_x},{item_y + 100},{item_x},{item_y},0,380)\fad(150,180)}}"
        elif item_animation == "slide_left":
            override = rf"{{{base}\move({item_x - 180},{item_y},{item_x},{item_y},0,380)\fad(140,180)}}"
        elif item_animation == "zoom":
            override = rf"{{{base}\fad(100,180)\fscx70\fscy70\blur3\t(0,420,\fscx100\fscy100\blur0)}}"
        elif item_animation == "pop":
            override = rf"{{{base}\fad(80,160)\fscx70\fscy70\t(0,230,\fscx112\fscy112)\t(230,430,\fscx100\fscy100)}}"
        elif item_animation in ("blur", "glow"):
            override = rf"{{{base}\fad(120,190)\blur8\t(0,440,\blur0)}}"
        elif item_animation == "flicker":
            override = rf"{{{base}\fad(40,160)\alpha&H80&\t(0,80,\alpha&H00&)\t(100,170,\alpha&H90&)\t(190,300,\alpha&H00&)}}"
        elif item_animation == "word_fill":
            words = text.replace(r"\N", " ").split()
            centiseconds = max(1, int((e - s) * 100 / max(1, len(words))))
            karaoke = " ".join(rf"{{\kf{centiseconds}}}{word}" for word in words)
            override = rf"{{{base}\2c&H006DFF&}}{karaoke}"
            text = ""
        elif item_animation == "typewriter":
            chars = max(1, len(text))
            centiseconds = max(1, int((e - s) * 100 / chars))
            typed = "".join(rf"{{\k{centiseconds}}}{char}" for char in text)
            override = rf"{{{base}}}{typed}"
            text = ""
        elif item_animation == "none":
            override = rf"{{{base}}}"
        else:
            override = rf"{{{base}\fad(180,180)}}"
        lines.append(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Default,,0,0,0,,{override}{text}")

    path.write_text("\n".join(lines), encoding="utf-8-sig")


def create_filter(project: Dict, bg_kind: str, duration: float, fps: int) -> str:
    width = clamp_int(project.get("width"), 1080, 240, 7680)
    height = clamp_int(project.get("height"), 1920, 240, 7680)
    bg_animation = project.get("bg_animation", "kenburns")
    frames = max(1, int(duration * fps))
    blur = clamp_int(project.get("background_blur"), 0, 0, 60)

    def add_tail(chain: str) -> str:
        if blur > 0:
            chain += f",boxblur={blur}:1"
        chain += ",format=yuv420p"
        chain += ",subtitles=subtitles.ass:fontsdir=fonts[v]"
        return chain

    if bg_kind == "image" and bg_animation != "static":
        # Image backgrounds are animated with zoompan; this is much faster than rendering PNG frames in Python.
        scale = (
            f"[0:v]scale={width*2}:{height*2}:force_original_aspect_ratio=increase,"
            f"crop={width*2}:{height*2}"
        )
        if bg_animation == "zoom_out":
            zp = f"zoompan=z='max(1.12-0.12*on/{frames},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps}"
        elif bg_animation == "pan_left":
            zp = f"zoompan=z='1.12':x='(iw-iw/zoom)*on/{frames}':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps}"
        elif bg_animation == "pan_right":
            zp = f"zoompan=z='1.12':x='(iw-iw/zoom)*(1-on/{frames})':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps}"
        elif bg_animation == "pan_up":
            zp = f"zoompan=z='1.12':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/{frames}':d={frames}:s={width}x{height}:fps={fps}"
        elif bg_animation == "pan_down":
            zp = f"zoompan=z='1.12':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/{frames})':d={frames}:s={width}x{height}:fps={fps}"
        else:
            zp = f"zoompan=z='min(1+0.12*on/{frames},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps}"
        return add_tail(scale + "," + zp)

    if bg_kind == "video" and bg_animation != "static":
        # Video backgrounds get animated crops/pans. For slow zoom we use a subtle fixed zoom to keep it reliable.
        sw = int(width * 1.14)
        sh = int(height * 1.14)
        base = f"[0:v]scale={sw}:{sh}:force_original_aspect_ratio=increase"
        if bg_animation == "pan_left":
            crop = f",crop={width}:{height}:x='(in_w-out_w)*n/{frames}':y='(in_h-out_h)/2'"
        elif bg_animation == "pan_right":
            crop = f",crop={width}:{height}:x='(in_w-out_w)*(1-n/{frames})':y='(in_h-out_h)/2'"
        elif bg_animation == "pan_up":
            crop = f",crop={width}:{height}:x='(in_w-out_w)/2':y='(in_h-out_h)*n/{frames}'"
        elif bg_animation == "pan_down":
            crop = f",crop={width}:{height}:x='(in_w-out_w)/2':y='(in_h-out_h)*(1-n/{frames})'"
        else:
            crop = f",crop={width}:{height}:x='(in_w-out_w)/2':y='(in_h-out_h)/2'"
        return add_tail(base + crop + f",fps={fps}")

    base = f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},fps={fps}"
    return add_tail(base)

def create_editor_filter(project: Dict, bg_paths: List[Path], duration: float, fps: int, with_subtitles: bool = True) -> str:
    width = clamp_int(project.get("width"), 1080, 240, 7680)
    height = clamp_int(project.get("height"), 1920, 240, 7680)
    bg_color = project.get("background_color", "#161316")
    if not re.match(r"^#[0-9A-Fa-f]{6}$", bg_color or ""):
        bg_color = "#161316"
    clips = sorted(project.get("background_clips") or [], key=lambda item: float(item.get("start", 0)))
    segments = []
    cursor = 0.0
    for clip in clips:
        file_index = int(clip.get("file_index", -1))
        start = clamp_float(clip.get("start"), cursor, 0, duration)
        end = clamp_float(clip.get("end"), start + 1, 0, duration)
        if file_index not in range(len(bg_paths)) or end <= start:
            continue
        if start > cursor + 0.01:
            segments.append({"kind": "color", "duration": start - cursor})
        visible_start = max(cursor, start)
        if end > visible_start:
            segments.append({
                "kind": "file", "duration": end - visible_start, "file_index": file_index,
                "transition": clip.get("transition", "fade"),
                "blur": clamp_int(clip.get("blur"), 0, 0, 40),
                "remove_mode": str(clip.get("remove_mode") or "none"),
                "key_color": str(clip.get("key_color") or "#00ff00"),
                "key_strength": clamp_float(clip.get("key_strength"), 0.18, 0.01, 0.8),
            })
            cursor = end
    if cursor < duration:
        segments.append({"kind": "color", "duration": duration - cursor})
    if not segments:
        segments = [{"kind": "color", "duration": duration}]

    filters, labels = [], []
    for index, segment in enumerate(segments):
        label = f"s{index}"
        seg_duration = max(0.05, float(segment["duration"]))
        if segment["kind"] == "color":
            chain = f"color=c={bg_color}:s={width}x{height}:r={fps}:d={seg_duration:.3f},format=yuv420p"
        else:
            file_index = int(segment["file_index"])
            chain = (
                f"[{file_index}:v]trim=duration={seg_duration:.3f},setpts=PTS-STARTPTS,"
                f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},fps={fps}"
            )
            blur = int(segment["blur"])
            if blur > 0:
                chain += f",boxblur={blur}:1"
            remove_mode = segment.get("remove_mode", "none")
            if remove_mode != "none":
                key_color = segment.get("key_color", "#00ff00")
                if not re.match(r"^#[0-9A-Fa-f]{6}$", key_color or ""):
                    key_color = "#00ff00"
                if remove_mode == "luma_dark":
                    key_color = "#000000"
                elif remove_mode == "luma_light":
                    key_color = "#ffffff"
                ff_key = "0x" + key_color.lstrip("#")
                strength = float(segment.get("key_strength", 0.18))
                base_label = f"kb{index}"
                fg_label = f"fg{index}"
                filters.append(f"color=c={bg_color}:s={width}x{height}:r={fps}:d={seg_duration:.3f},format=rgba[{base_label}]")
                filters.append(f"{chain},chromakey={ff_key}:{strength:.3f}:0.08,format=yuva420p[{fg_label}]")
                chain = f"[{base_label}][{fg_label}]overlay=format=auto"
            if segment.get("transition") != "none" and seg_duration > 0.6:
                chain += f",fade=t=in:st=0:d=.22,fade=t=out:st={max(0, seg_duration-.22):.3f}:d=.22"
            chain += ",format=yuv420p"
        filters.append(f"{chain}[{label}]")
        labels.append(f"[{label}]")
    if len(labels) == 1:
        filters.append(f"{labels[0]}null[base]")
    else:
        filters.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[base]")
    if with_subtitles:
        filters.append("[base]subtitles=subtitles.ass:fontsdir=fonts[v]")
    else:
        filters.append("[base]null[v]")
    return ";".join(filters)


def run_generation(job_id: str, job_dir: Path, project: Dict, audio_path: Optional[Path], bg_paths: List[Path], font_path: Optional[Path]) -> None:
    try:
        jobs[job_id]["status"] = "running"
        log(job_id, "Проверяю ffmpeg...")
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("ffmpeg не найден. Установи ffmpeg или запусти START_WINDOWS.cmd, он попробует поставить его через winget.")

        audio_duration = ffprobe_duration(audio_path) if audio_path else 0
        raw_audio_clips = project.get("audio_clips") or []
        clip_start = clamp_float(project.get("clip_start"), 0, 0, 24 * 3600)
        clip_end = clamp_float(project.get("clip_end"), audio_duration if audio_duration else 30, 0, 24 * 3600)
        if audio_duration and not raw_audio_clips and (clip_end <= 0 or clip_end > audio_duration):
            clip_end = audio_duration
        if clip_end <= clip_start:
            raise RuntimeError("Финиш должен быть больше старта. Например: старт 9, финиш 30.")
        duration = clip_end - clip_start
        if duration <= 0:
            raise RuntimeError("Нулевая длительность фрагмента.")

        fps = clamp_int(project.get("fps"), 30, 1, 120)
        width = clamp_int(project.get("width"), 1080, 240, 7680)
        height = clamp_int(project.get("height"), 1920, 240, 7680)
        bg_color = project.get("background_color", "#080A10")
        if not re.match(r"^#[0-9A-Fa-f]{6}$", bg_color or ""):
            bg_color = "#080A10"

        timings = project.get("timings") or []
        if not timings:
            timings = create_auto_timings(
                project.get("lyrics_text", ""),
                duration,
                project.get("timing_mode", "by_length"),
                clamp_float(project.get("start_pad"), 0.0, 0, duration),
                clamp_float(project.get("end_pad"), 0.0, 0, duration),
                clamp_float(project.get("min_line_sec"), 1.0, 0.1, 60),
            )
        has_subtitles = bool(timings)

        fonts_dir = job_dir / "fonts"
        fonts_dir.mkdir(exist_ok=True)
        if font_path and font_path.exists():
            copied_font = fonts_dir / safe_filename(font_path.name, "font.ttf")
            shutil.copy2(font_path, copied_font)
            font_family = parse_font_family(copied_font) or "Arial"
        else:
            font_family, sys_font = find_system_font()
            if sys_font and sys_font.exists():
                try:
                    shutil.copy2(sys_font, fonts_dir / sys_font.name)
                except Exception:
                    pass
        log(job_id, f"Шрифт: {font_family}")

        if has_subtitles:
            ass_path = job_dir / "subtitles.ass"
            write_ass(ass_path, timings, project, font_family)
        log(job_id, f"Сегмент: {clip_start:.2f}–{clip_end:.2f} сек. Итоговая длина: {duration:.2f} сек.")
        log(job_id, f"Строк текста: {len(timings)}")

        out_name = safe_filename(project.get("output_name", "output_video.mp4"), "output_video.mp4")
        if not out_name.lower().endswith(".mp4"):
            out_name += ".mp4"
        stamp = time.strftime("%Y%m%d_%H%M%S")
        output_path = OUTPUT_DIR / f"{Path(out_name).stem}_{stamp}.mp4"

        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning"]
        for bg_path in bg_paths:
            if bg_path.suffix.lower() in IMAGE_EXTS:
                cmd += ["-loop", "1", "-i", str(bg_path)]
            elif bg_path.suffix.lower() in VIDEO_EXTS:
                cmd += ["-stream_loop", "-1", "-i", str(bg_path)]
        audio_input_index = len(bg_paths)
        audio_parts = []
        labels = []
        if raw_audio_clips and audio_path:
            cmd += ["-i", str(audio_path)]
            for idx, item in enumerate(raw_audio_clips):
                start = clamp_float(item.get("start"), 0, 0, duration)
                end = clamp_float(item.get("end"), start, start + 0.1, duration)
                source_start = clamp_float(item.get("source_start"), 0, 0, audio_duration or 24 * 3600)
                source_end = clamp_float(item.get("source_end"), source_start + (end - start), source_start + 0.1, audio_duration or 24 * 3600)
                if end <= start or source_end <= source_start:
                    continue
                gain = clamp_float(item.get("gain"), 1.0, 0.0, 2.0)
                fade_in = clamp_float(item.get("fade_in"), 0.0, 0.0, min(10.0, end - start))
                fade_out = clamp_float(item.get("fade_out"), 0.0, 0.0, min(10.0, end - start))
                delay = int(round(start * 1000))
                label = f"ma{idx}"
                chain = f"[{audio_input_index}:a:0]atrim=start={source_start:.3f}:end={source_end:.3f},asetpts=PTS-STARTPTS,volume={gain:.3f}"
                if fade_in > 0:
                    chain += f",afade=t=in:st=0:d={fade_in:.3f}"
                if fade_out > 0:
                    chain += f",afade=t=out:st={max(0.0, (end - start) - fade_out):.3f}:d={fade_out:.3f}"
                chain += f",adelay={delay}:all=1[{label}]"
                audio_parts.append(chain)
                labels.append(f"[{label}]")
        elif audio_path:
            cmd += ["-ss", f"{clip_start:.3f}", "-t", f"{duration:.3f}", "-i", str(audio_path)]
            audio_gain = clamp_float(project.get("audio_gain"), 1.0, 0.0, 2.0)
            audio_fade_in = clamp_float(project.get("audio_fade_in"), 0.0, 0.0, min(10.0, duration))
            audio_fade_out = clamp_float(project.get("audio_fade_out"), 0.0, 0.0, min(10.0, duration))
            label = "maina"
            chain = f"[{audio_input_index}:a:0]volume={audio_gain:.3f}"
            if audio_fade_in > 0:
                chain += f",afade=t=in:st=0:d={audio_fade_in:.3f}"
            if audio_fade_out > 0:
                chain += f",afade=t=out:st={max(0.0, duration - audio_fade_out):.3f}:d={audio_fade_out:.3f}"
            chain += f"[{label}]"
            audio_parts.append(chain)
            labels.append(f"[{label}]")

        video_audio_count = 0
        for item in project.get("background_clips") or []:
            file_index = int(item.get("file_index", -1))
            if file_index not in range(len(bg_paths)):
                continue
            if bg_paths[file_index].suffix.lower() not in VIDEO_EXTS or not ffprobe_has_audio(bg_paths[file_index]):
                continue
            if item.get("include_audio") is False:
                continue
            start = clamp_float(item.get("start"), 0, 0, duration)
            end = clamp_float(item.get("end"), start, start + 0.1, duration)
            if end <= start:
                continue
            gain = clamp_float(item.get("audio_gain"), 1.0, 0.0, 1.0)
            delay = int(round(start * 1000))
            label = f"va{video_audio_count}"
            video_audio_count += 1
            chain = f"[{file_index}:a:0]atrim=0:{(end - start):.3f},asetpts=PTS-STARTPTS,volume={gain:.3f},adelay={delay}:all=1[{label}]"
            audio_parts.append(chain)
            labels.append(f"[{label}]")

        if labels:
            if len(labels) == 1:
                audio_filter = ";".join(audio_parts) + f";{labels[0]}atrim=0:{duration:.3f}[a]"
            else:
                audio_filter = ";".join(audio_parts) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0,atrim=0:{duration:.3f}[a]"
        else:
            audio_filter = f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{duration:.3f}[a]"
        filter_complex = create_editor_filter(project, bg_paths, duration, fps, has_subtitles) + ";" + audio_filter
        cmd += [
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "[a]",
            "-shortest",
            "-r", str(fps),
            "-c:v", "libx264",
            "-preset", project.get("preset", "veryfast"),
            "-crf", str(clamp_int(project.get("crf"), 23, 12, 35)),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(output_path),
        ]

        log(job_id, "Запускаю ffmpeg. В новой версии старт/финиш реально обрезают итоговое видео.")
        proc = subprocess.Popen(cmd, cwd=str(job_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="ignore")
        current_processes[job_id] = proc
        collected = []
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if line:
                collected.append(line)
                if len(collected) % 10 == 0:
                    log(job_id, line[-500:])
        code = proc.wait()
        current_processes.pop(job_id, None)
        if code != 0:
            tail = "\n".join(collected[-20:])
            raise RuntimeError("ffmpeg завершился с ошибкой.\n" + tail)

        jobs[job_id]["status"] = "done"
        jobs[job_id]["output"] = output_path.name
        log(job_id, f"Готово: output/{output_path.name}")
    except Exception as exc:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)
        log(job_id, "ОШИБКА: " + str(exc))
    finally:
        current_processes.pop(job_id, None)


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/web/<path:path>")
def web_files(path):
    return send_from_directory(WEB_DIR, path)


@app.route("/assets/<path:path>")
def asset_files(path):
    return send_from_directory(APP_DIR / "assets", path)


@app.route("/output/<path:path>")
def output_file(path):
    return send_from_directory(OUTPUT_DIR, path, as_attachment=False)


def fetch_json(url: str, data: Optional[Dict] = None, timeout: int = 12) -> Dict:
    payload = None if data is None else json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"User-Agent": "KoilofStudio/2.0", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


@app.get("/api/backgrounds/search")
def api_background_search():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"ok": False, "error": "Введите запрос."}), 400
    url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({
        "q": query,
        "page_size": 20,
        "license_type": "commercial",
    })
    try:
        data = fetch_json(url, timeout=15)
        results = []
        for item in data.get("results", []):
            image_url = item.get("url") or ""
            thumbnail = item.get("thumbnail") or image_url
            if not image_url.startswith(("http://", "https://")):
                continue
            creator = item.get("creator") or "Unknown"
            license_name = (item.get("license") or "").upper()
            results.append({
                "id": item.get("id"),
                "title": item.get("title") or query,
                "url": image_url,
                "thumbnail": thumbnail,
                "attribution": f"{creator} · {license_name} · Openverse",
            })
        return jsonify({"ok": True, "results": results})
    except Exception as exc:
        return jsonify({"ok": False, "error": f"Openverse временно недоступен: {exc}"}), 502


@app.get("/api/backgrounds/fetch")
def api_background_fetch():
    url = (request.args.get("url") or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return jsonify({"ok": False, "error": "Некорректная ссылка."}), 400
    if parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return jsonify({"ok": False, "error": "Локальные адреса запрещены."}), 400
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "KoilofStudio/2.0"})
        with urllib.request.urlopen(req, timeout=20) as response:
            content_type = response.headers.get_content_type()
            if not content_type.startswith("image/"):
                return jsonify({"ok": False, "error": "Ссылка не ведёт на изображение."}), 400
            content = response.read(20 * 1024 * 1024 + 1)
            if len(content) > 20 * 1024 * 1024:
                return jsonify({"ok": False, "error": "Изображение больше 20 МБ."}), 413
        return Response(content, content_type=content_type)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"Не удалось скачать фон: {exc}"}), 502


@app.get("/api/ai/status")
def api_ai_status():
    try:
        data = fetch_json(f"{OLLAMA_URL}/api/tags", timeout=2)
        models = [item.get("name", "") for item in data.get("models", [])]
        model = OLLAMA_MODEL if OLLAMA_MODEL in models else (models[0] if models else OLLAMA_MODEL)
        return jsonify({"ok": True, "online": bool(models), "model": model})
    except Exception:
        return jsonify({"ok": True, "online": False, "model": OLLAMA_MODEL})


def local_text_edit(text: str, prompt: str) -> str:
    prompt_lower = prompt.lower()
    lines = [line.strip() for line in re.split(r"\n+", text) if line.strip()]
    if "коротк" in prompt_lower or "разбей" in prompt_lower:
        result = []
        for line in lines:
            words = line.split()
            size = 5 if "5" in prompt_lower or "коротк" in prompt_lower else 7
            result.extend(" ".join(words[index:index + size]) for index in range(0, len(words), size))
        return "\n".join(result)
    if "исправ" in prompt_lower or "пунктуац" in prompt_lower or "русск" in prompt_lower:
        return "\n".join(line[:1].upper() + line[1:] for line in lines)
    return "\n".join(lines)


@app.post("/api/ai/edit")
def api_ai_edit():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text") or "").strip()
    prompt = str(data.get("prompt") or "").strip()
    if not text or not prompt:
        return jsonify({"ok": False, "error": "Нужны текст и задача."}), 400
    system = (
        "Ты редактор текста для lyric-видео. Отвечай только итоговым текстом на русском языке, "
        "без объяснений и Markdown. Сохраняй смысл автора. Каждая фраза должна быть на новой строке."
    )
    try:
        response = fetch_json(f"{OLLAMA_URL}/api/chat", {
            "model": OLLAMA_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": f"Задача: {prompt}\n\nТекст:\n{text}"},
            ],
            "options": {"temperature": 0.35},
        }, timeout=90)
        result = str(response.get("message", {}).get("content") or "").strip()
        if result:
            return jsonify({"ok": True, "text": result, "local": False})
    except Exception:
        pass
    return jsonify({"ok": True, "text": local_text_edit(text, prompt), "local": True})


@app.post("/api/generate")
def api_generate():
    try:
        project = json.loads(request.form.get("project", "{}"))
    except Exception:
        return jsonify({"ok": False, "error": "Не смог прочитать настройки проекта."}), 400

    audio = request.files.get("audio")

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_path = None
    if audio and audio.filename:
        audio_name = safe_filename(audio.filename, "audio")
        audio_path = job_dir / audio_name
        audio.save(audio_path)

    bg_paths: List[Path] = []
    backgrounds = request.files.getlist("backgrounds")
    if not backgrounds:
        legacy_bg = request.files.get("background")
        if legacy_bg:
            backgrounds = [legacy_bg]
    for index, bg in enumerate(backgrounds):
        if not bg or not bg.filename:
            continue
        bg_name = safe_filename(bg.filename, f"background_{index}")
        bg_path = job_dir / f"{index:03d}_{bg_name}"
        bg.save(bg_path)
        if bg_path.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS:
            bg_paths.append(bg_path)

    font_path = None
    font = request.files.get("font")
    if font and font.filename:
        font_name = safe_filename(font.filename, "font.ttf")
        font_path = job_dir / font_name
        font.save(font_path)

    jobs[job_id] = {"status": "queued", "logs": ["Задача создана."]}
    th = threading.Thread(target=run_generation, args=(job_id, job_dir, project, audio_path, bg_paths, font_path), daemon=True)
    th.start()
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/api/job/<job_id>")
def api_job(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"ok": False, "error": "Задача не найдена."}), 404
    return jsonify({"ok": True, **job})


@app.post("/api/stop/<job_id>")
def api_stop(job_id):
    proc = current_processes.get(job_id)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            jobs[job_id]["status"] = "stopped"
            log(job_id, "Остановлено пользователем.")
            return jsonify({"ok": True})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
    return jsonify({"ok": False, "error": "Активный процесс не найден."}), 404


@app.post("/api/open-output")
def api_open_output():
    try:
        if os.name == "nt":
            os.startfile(str(OUTPUT_DIR))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(OUTPUT_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(OUTPUT_DIR)])
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/outputs")
def api_outputs():
    files = sorted([p for p in OUTPUT_DIR.glob("*.mp4")], key=lambda p: p.stat().st_mtime, reverse=True)
    return jsonify({"ok": True, "files": [{"name": p.name, "size": p.stat().st_size} for p in files[:30]]})


def open_browser_later(port: int):
    time.sleep(1.0)
    try:
        webbrowser.open(f"http://127.0.0.1:{port}")
    except Exception:
        pass


if __name__ == "__main__":
    port = int(os.environ.get("LVS_PORT", "8765"))
    threading.Thread(target=open_browser_later, args=(port,), daemon=True).start()
    print(f"Lyrics Video Studio Ultra: http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
