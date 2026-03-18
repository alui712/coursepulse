import asyncio
import base64
import json
import os
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from io import BytesIO
from pathlib import Path

from dateutil import parser as date_parser
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from icalendar import Calendar, Event
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import google.generativeai as genai
from PIL import Image
from PyPDF2 import PdfReader
from docx import Document
import fitz  # PyMuPDF
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

_load_env = Path(__file__).parent
load_dotenv(_load_env / ".env")
load_dotenv(_load_env / "venv" / ".env")

genai.configure(api_key=os.getenv("GEMINI_API_KEY") or "YOUR_GEMINI_API_KEY")

# Helpful startup warning if key looks wrong (won't crash the server).
_gemini_key = os.getenv("GEMINI_API_KEY") or ""
if _gemini_key and not _gemini_key.startswith("AIza"):
    print("[CoursePulse] WARNING: GEMINI_API_KEY does not start with 'AIza'. Double-check the key value.")

app = FastAPI()

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

def _coursepulse_rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Daily limit reached (2 uploads/day). Please try again tomorrow."},
    )

app.add_exception_handler(RateLimitExceeded, _coursepulse_rate_limit_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_CURRENT_YEAR = datetime.now().year

EXTRACTION_PROMPT = f"""You are a data extractor. Extract all assignments, exams, and schedule events from the syllabus text below.

Return ONLY a JSON array. Each object must have exactly these fields:
- course_name: string (infer from context if not explicit)
- assignment_name: string
- due_date: string or null
- tentative_date_text: string or null
- weight_or_importance: one of "Low", "Medium", or "High"

CRITICAL RULES:
- If an assignment has a specific exact date, output it in YYYY-MM-DD format in the due_date field and set tentative_date_text to null.
- If the date is vague, a range, or TBD (e.g., "Final Exam Period", "Finals Week", "Week 4", "TBA"), you MUST set due_date to null
  and put the exact raw text into tentative_date_text. Do NOT guess an exact date.
- If the document provides a schedule table with week numbers + a specific month/day (e.g., "Week 3 — Jan. 21") and an assigned reading/quiz/test/topic,
  treat that row as a dated deliverable and set due_date to that class date. Use the class date as the due date.
- If only month/day is shown and no year is provided, infer the most likely year from the term; if unclear, use {_CURRENT_YEAR}.
- INCLUDE schedule markers like "Reading Week", "Break Week", "Spring Break", "No Class", and holidays if they have a specific date in the schedule.
  For these, set weight_or_importance to "Low". If there is no exact date, set due_date to null and put the phrase in tentative_date_text.
- Return ONLY the JSON array, no markdown and no extra text.

Syllabus text:
"""

VISION_EXTRACTION_PROMPT = f"""You are a data extractor. The user uploaded an image of a course schedule/syllabus.

Extract all assignments, exams, and schedule events you can see.

Return ONLY a JSON array. Each object must have exactly these fields:
- course_name: string (infer from context if not explicit)
- assignment_name: string
- due_date: string or null
- tentative_date_text: string or null
- weight_or_importance: one of "Low", "Medium", or "High"

CRITICAL RULES:
- If an assignment has a specific exact date, output it in YYYY-MM-DD format in the due_date field and set tentative_date_text to null.
- If the date is vague, a range, or TBD (e.g., "Final Exam Period", "Finals Week", "Week 4", "TBA"), you MUST set due_date to null
  and put the exact raw text into tentative_date_text. Do NOT guess an exact date.
- If the image shows a schedule table with week numbers + a specific month/day (e.g., "Week 3 — Jan. 21") and an assigned reading/quiz/test/topic,
  treat that row as a dated deliverable and set due_date to that class date.
- If only month/day is shown and no year is provided, infer the most likely year from the term; if unclear, use {_CURRENT_YEAR}.
- INCLUDE schedule markers like "Reading Week", "Break Week", "Spring Break", "No Class", and holidays if they have a specific date in the schedule.
  For these, set weight_or_importance to "Low". If there is no exact date, set due_date to null and put the phrase in tentative_date_text.
- Return ONLY the JSON array, no markdown and no extra text.
"""


def calculate_danger_weeks(assignments: list[dict]) -> list[dict]:
    """Group assignments by calendar week. Flag weeks with 2+ High-importance items or >4 total assignments."""
    by_week: dict[tuple[int, int], list[dict]] = defaultdict(list)

    for a in assignments:
        try:
            d = date.fromisoformat(a.get("due_date", ""))
            key = (d.year, d.isocalendar().week)
            by_week[key].append(a)
        except (ValueError, TypeError):
            continue

    danger_weeks: list[dict] = []
    for (year, week), items in by_week.items():
        high_count = sum(1 for a in items if (a.get("weight_or_importance") or "").strip() == "High")
        is_danger = high_count >= 2 or len(items) > 4

        if is_danger:
            danger_weeks.append({
                "year": year,
                "week": week,
                "assignments": items,
            })

    return sorted(danger_weeks, key=lambda w: (w["year"], w["week"]))


def generate_ics(assignments: list[dict]) -> bytes:
    """Generate an in-memory .ics file with all due dates as all-day events."""
    cal = Calendar()
    cal.add("prodid", "-//CoursePulse//Syllabus Calendar//EN")
    cal.add("version", "2.0")

    for a in assignments:
        try:
            due = date.fromisoformat(a.get("due_date", ""))
        except (ValueError, TypeError):
            continue

        event = Event()
        event.add("summary", f"{a.get('course_name', 'Course')}: {a.get('assignment_name', 'Assignment')}")
        event.add("dtstart", due)
        event.add("dtend", due + timedelta(days=1))

        cal.add_component(event)

    return cal.to_ical()


def _extract_json_array(text: str) -> list:
    """Parse JSON array from LLM response, stripping markdown code blocks if present."""
    stripped = text.strip()
    # Remove markdown code block if present
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", stripped)
    if match:
        stripped = match.group(1).strip()
    return json.loads(stripped)

def _normalize_weight(value: object) -> str:
    v = str(value or "").strip().lower()
    if v == "high":
        return "High"
    if v == "medium":
        return "Medium"
    return "Low"


def _normalize_due_date(value: object) -> str | None:
    """
    Normalize various date strings into YYYY-MM-DD.
    Returns None if parsing fails.
    """
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Already ISO date
    try:
        return date.fromisoformat(s).isoformat()
    except Exception:
        pass

    # Try flexible parsing (e.g., "Mar 24, 2026", "3/24/26", "March 24")
    try:
        default = datetime(datetime.now().year, 1, 1)
        dt = date_parser.parse(s, default=default, fuzzy=True)
        return dt.date().isoformat()
    except Exception:
        return None


def _normalize_assignments(items: list) -> list[dict]:
    normalized: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        due = _normalize_due_date(item.get("due_date"))
        tentative = str(item.get("tentative_date_text") or "").strip() or None

        # If due date is missing/unparseable, keep it only if tentative text exists.
        if not due and not tentative:
            continue
        normalized.append(
            {
                "course_name": str(item.get("course_name") or "").strip() or "Unknown",
                "assignment_name": str(item.get("assignment_name") or "").strip() or "Unnamed",
                "due_date": due,
                "tentative_date_text": tentative,
                "weight_or_importance": _normalize_weight(item.get("weight_or_importance")),
            }
        )
    return normalized


def _is_schedule_marker(name: str) -> bool:
    n = (name or "").strip().lower()
    if not n:
        return False
    markers = [
        "reading week",
        "break week",
        "spring break",
        "no class",
        "holiday",
        "reading week (no class)",
        "study week",
        "exam period",
        "finals week",
    ]
    return any(m in n for m in markers)

def _render_pdf_pages_as_images(
    pdf_bytes: bytes,
    max_pages: int = 8,
    page_indices: list[int] | None = None,
) -> list[Image.Image]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    images: list[Image.Image] = []
    try:
        if page_indices is None:
            page_indices = list(range(min(len(doc), max_pages)))
        else:
            page_indices = [i for i in page_indices if 0 <= i < len(doc)][:max_pages]

        for i in page_indices:
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=200)
            img = Image.open(BytesIO(pix.tobytes("png"))).convert("RGB")
            images.append(img)
    finally:
        doc.close()
    return images

def _extract_pdf_text_pymupdf(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        parts: list[str] = []
        for page in doc:
            parts.append(page.get_text("text") or "")
        return "\n".join(parts)
    finally:
        doc.close()

_MONTHS_RE = re.compile(r"\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b", re.I)
_MD_RE = re.compile(r"\b\d{1,2}\s*/\s*\d{1,2}\b")
_WEEK_RE = re.compile(r"\bweek\s*\d+\b", re.I)
_SCHEDULE_MARKER_RE = re.compile(r"\b(reading week|no class|midterm|test|quiz|exam)\b", re.I)

def _pick_schedule_like_pdf_pages(pdf_bytes: bytes, max_pages: int = 8) -> list[int]:
    """
    Heuristic: pick pages most likely to contain a schedule table.
    This helps when the schedule is late in the PDF.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        scores: list[tuple[int, int]] = []
        for i, page in enumerate(doc):
            t = (page.get_text("text") or "").lower()
            if not t.strip():
                scores.append((0, i))
                continue
            score = 0
            score += 3 * len(_WEEK_RE.findall(t))
            score += 2 * len(_MONTHS_RE.findall(t))
            score += 2 * len(_MD_RE.findall(t))
            score += 4 * len(_SCHEDULE_MARKER_RE.findall(t))
            # Bonus if it looks like a table-ish schedule page
            if "assigned" in t and "week" in t:
                score += 6
            scores.append((score, i))

        scores.sort(key=lambda x: (-x[0], x[1]))
        picked = [i for score, i in scores if score > 0][:max_pages]
        if not picked:
            picked = list(range(min(len(doc), max_pages)))
        return picked
    finally:
        doc.close()

def _extract_pdf_page_texts(pdf_bytes: bytes) -> list[str]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return [(page.get_text("text") or "") for page in doc]
    finally:
        doc.close()

def _dedupe_assignments(items: list[dict]) -> list[dict]:
    seen: set[tuple[str, str, str]] = set()
    out: list[dict] = []
    for a in items or []:
        if not isinstance(a, dict):
            continue
        key = (
            str(a.get("course_name") or "").strip().lower(),
            str(a.get("assignment_name") or "").strip().lower(),
            str(a.get("due_date") or "").strip(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(a)
    return out


@app.post("/upload-syllabi/")
@limiter.limit("2/day")
async def upload_syllabi(request: Request, files: list[UploadFile] = File(...)):
    """Accept multiple PDF/image uploads, extract text, and return structured assignment data via Gemini."""
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    model = genai.GenerativeModel(
        "gemini-flash-latest",
        generation_config={"response_mime_type": "application/json"},
    )

    supported_image_types = {
        "image/png",
        "image/jpg",
        "image/jpeg",
        "image/webp",
    }
    docx_content_types = {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }

    all_extracted_assignments: list = []

    for idx, file in enumerate(files):
        filename = file.filename or "upload"
        content_type = (file.content_type or "").lower()
        ext = (Path(filename).suffix or "").lower()

        content = await file.read()

        is_pdf = content_type == "application/pdf" or ext == ".pdf"
        is_image = content_type in supported_image_types or ext in {".png", ".jpg", ".jpeg", ".webp"}
        is_docx = content_type in docx_content_types or ext == ".docx"

        extracted_for_file: list = []
        gemini_failed = False
        gemini_error_text: str | None = None
        if is_pdf:
            try:
                # PyPDF2 can miss table-heavy syllabi; use it first, then fall back to PyMuPDF.
                reader = PdfReader(BytesIO(content))
                pypdf_text = "".join(page.extract_text() or "" for page in reader.pages)
                mupdf_text = _extract_pdf_text_pymupdf(content)
                file_text = mupdf_text if len(mupdf_text.strip()) > len(pypdf_text.strip()) else pypdf_text
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Failed to extract text from '{filename}': {str(e)}",
                )

            text_prompt = (
                "Extract assignments/exams/schedule events from the syllabus text. "
                "Return ONLY a JSON array of objects, each with: course_name, assignment_name, "
                "due_date (YYYY-MM-DD or null), tentative_date_text (string or null), "
                'weight_or_importance ("Low"|"Medium"|"High"). '
                "Do not add any extra text or markdown.\n\n"
                + EXTRACTION_PROMPT
            )
            vision_prompt = (
                "Extract assignments/exams/schedule events from this syllabus PDF page image. "
                "Return ONLY a JSON array of objects, each with: course_name, assignment_name, "
                "due_date (YYYY-MM-DD or null), tentative_date_text (string or null), "
                'weight_or_importance ("Low"|"Medium"|"High"). '
                "Do not add any extra text or markdown.\n\n"
                + VISION_EXTRACTION_PROMPT
            )

            # First: text-based pass (fast).
            if file_text.strip():
                try:
                    response = await asyncio.to_thread(model.generate_content, text_prompt + "\n\n" + file_text)
                    raw = getattr(response, "text", "") or ""
                    extracted_for_file = _extract_json_array(raw) if raw.strip() else []
                except json.JSONDecodeError as e:
                    raise HTTPException(status_code=500, detail=f"Failed to parse LLM response as JSON for '{filename}': {e}")
                except Exception as e:
                    gemini_failed = True
                    gemini_error_text = str(e)
                    print(f"[CoursePulse] Gemini API error for '{filename}': {gemini_error_text}")

            # Second: schedule-page pass (always run on the most schedule-like pages).
            # This fixes cases where the overall PDF produces many other items but still misses the schedule table.
            if not gemini_failed:
                try:
                    page_indices = _pick_schedule_like_pdf_pages(content, max_pages=3)
                    page_texts = _extract_pdf_page_texts(content)
                    combined: list = list(extracted_for_file)

                    # Text pass on the schedule pages (cheap and often sufficient).
                    for i in page_indices:
                        pt = (page_texts[i] or "").strip()
                        if not pt:
                            continue
                        response = await asyncio.to_thread(model.generate_content, text_prompt + "\n\n" + pt)
                        raw = getattr(response, "text", "") or ""
                        if raw.strip():
                            combined.extend(_extract_json_array(raw))

                    # Vision pass on the same schedule pages (best for table layout).
                    imgs = _render_pdf_pages_as_images(content, max_pages=3, page_indices=page_indices)
                    for img in imgs:
                        response = await asyncio.to_thread(model.generate_content, [vision_prompt, img])
                        raw = getattr(response, "text", "") or ""
                        if raw.strip():
                            combined.extend(_extract_json_array(raw))

                    extracted_for_file = _dedupe_assignments(combined)
                except json.JSONDecodeError as e:
                    raise HTTPException(status_code=500, detail=f"Failed to parse vision LLM JSON for '{filename}': {e}")
                except Exception as e:
                    gemini_failed = True
                    gemini_error_text = str(e)
                    print(f"[CoursePulse] Gemini vision API error for '{filename}': {gemini_error_text}")

        elif is_image:
            prompt = (
                "Extract assignments/exams/schedule events from this syllabus image. "
                "Return ONLY a JSON array of objects, each with: course_name, assignment_name, "
                "due_date (YYYY-MM-DD or null), tentative_date_text (string or null), "
                'weight_or_importance ("Low"|"Medium"|"High"). '
                "Do not add any extra text or markdown.\n\n"
                + VISION_EXTRACTION_PROMPT
            )
            try:
                img = Image.open(BytesIO(content)).convert("RGB")
                response = await asyncio.to_thread(model.generate_content, [prompt, img])
                raw = getattr(response, "text", "") or ""
                extracted_for_file = _extract_json_array(raw) if raw.strip() else []
            except json.JSONDecodeError as e:
                raise HTTPException(status_code=500, detail=f"Failed to parse vision LLM JSON for '{filename}': {e}")
            except Exception as e:
                gemini_failed = True
                gemini_error_text = str(e)
                print(f"[CoursePulse] Gemini vision API error for '{filename}': {gemini_error_text}")

        elif is_docx:
            try:
                doc = Document(BytesIO(content))
                doc_text = "\n".join([p.text for p in doc.paragraphs])
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Failed to extract text from '{filename}': {str(e)}",
                )

            if not doc_text.strip():
                extracted_for_file = []
            else:
                prompt = (
                    "Extract assignments/exams/schedule events from the syllabus text. "
                    "Return ONLY a JSON array of objects, each with: course_name, assignment_name, "
                    "due_date (YYYY-MM-DD or null), tentative_date_text (string or null), "
                    'weight_or_importance ("Low"|"Medium"|"High"). '
                    "Do not add any extra text or markdown.\n\n"
                    + EXTRACTION_PROMPT
                )
                try:
                    response = await asyncio.to_thread(model.generate_content, prompt + "\n\n" + doc_text)
                    raw = getattr(response, "text", "") or ""
                    extracted_for_file = _extract_json_array(raw) if raw.strip() else []
                except json.JSONDecodeError as e:
                    raise HTTPException(status_code=500, detail=f"Failed to parse LLM response as JSON for '{filename}': {e}")
                except Exception as e:
                    gemini_failed = True
                    gemini_error_text = str(e)
                    print(f"[CoursePulse] Gemini API error for '{filename}': {gemini_error_text}")

        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type for '{filename}'. Upload PDFs, DOCX, or images (PNG, JPG, JPEG, WEBP).",
            )

        if gemini_failed:
            detail = (gemini_error_text or "Gemini API error").strip()
            if len(detail) > 300:
                detail = detail[:300] + "…"
            all_extracted_assignments.append(
                {
                    "course_name": filename,
                    "assignment_name": "API Error - Could not parse",
                    "due_date": None,
                    "tentative_date_text": detail,
                    "weight_or_importance": "Low",
                }
            )
        elif isinstance(extracted_for_file, list):
            all_extracted_assignments.extend(extracted_for_file)

    assignments = _normalize_assignments(all_extracted_assignments)
    dated_assignments = [a for a in assignments if a.get("due_date")]
    # Don't let schedule-only markers trigger danger weeks.
    danger_input = [a for a in dated_assignments if not _is_schedule_marker(a.get("assignment_name", ""))]
    danger_weeks = calculate_danger_weeks(danger_input)
    # Keep schedule markers in calendar export if they have real dates.
    ics_bytes = generate_ics(dated_assignments)

    return {
        "assignments": assignments,
        "danger_weeks": danger_weeks,
        "ics_base64": base64.b64encode(ics_bytes).decode(),
    }
