"""Extraction module for OCR-based AWB parsing.

This module is responsible for:
1. OCR-ing the uploaded AWB image
2. Pulling likely key fields such as AWB number, weight, destination, and pieces
3. Detecting a possible handwritten override or strikethrough near the weight field

The logic is intentionally heuristic and aimed at a proof-of-concept workflow.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

import pytesseract
from PIL import Image, ImageFilter, ImageOps
from pytesseract import Output


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    text = text.replace(",", "")
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return None
    return float(match.group(0))


def _extract_lines_from_ocr(image: Image.Image) -> Dict[str, Any]:
    """Return OCR output with word-level confidence metadata."""
    grayscale = ImageOps.grayscale(image)
    grayscale = grayscale.resize((grayscale.width * 2, grayscale.height * 2))
    grayscale = grayscale.filter(ImageFilter.SHARPEN)

    data = pytesseract.image_to_data(
        grayscale,
        config="--psm 6",
        output_type=Output.DICT,
    )

    # Build a readable OCR string and keep confidence values for scoring.
    words = []
    words_meta = []
    confidences: List[float] = []
    for idx, text in enumerate(data["text"]):
        cleaned = text.strip()
        if not cleaned:
            continue
        words.append(cleaned)
        words_meta.append({
            "text": cleaned,
            "left": float(data["left"][idx]),
            "top": float(data["top"][idx]),
            "width": float(data["width"][idx]),
            "height": float(data["height"][idx]),
        })
        conf = data["conf"][idx]
        try:
            confidences.append(float(conf) / 100.0)
        except ValueError:
            confidences.append(0.0)

    raw_text = "\n".join(words)
    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    return {
        "raw_text": raw_text,
        "words": words,
        "words_meta": words_meta,
        "confidence": confidence,
        "image_size": grayscale.size,
    }


def _find_field_value(text: str, patterns: List[str]) -> str | None:
    """Find a value by checking a list of regex patterns for likely field labels."""
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            value = match.group(1).strip()
            if value:
                return value
    return None


def extract_associated_awb_numbers(raw_text: str, words_meta: List[Dict[str, Any]] | None = None) -> List[str]:
    """Detect associated AWB numbers printed in the top-right of the document.

    Typical examples include:
    - MAWB 12345678
    - AWB 123-4567891
    - 123-4567891
    """
    if not raw_text:
        return []

    candidates: List[str] = []
    seen = set()

    patterns = [
        r"(?:mawb|awb)\s*[:\-]?\s*([A-Z0-9]{8,15})",
        r"(?:mawb|awb)\s*[:\-]?\s*([0-9]{3}\s*[-\s]?\s*[0-9]{7,9})",
        r"\b([0-9]{3}\s*[-\s]?\s*[0-9]{7,9})\b",
        r"\b([0-9]{8,15})\b",
    ]

    for pattern in patterns:
        for match in re.finditer(pattern, raw_text, flags=re.IGNORECASE):
            candidate = match.group(1).strip()
            candidate = re.sub(r"\s+", "", candidate)
            if len(candidate) >= 8 and candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    if words_meta:
        width = max((item.get("left", 0) + item.get("width", 0)) for item in words_meta) if words_meta else 0
        max_top = max((item.get("top", 0) + item.get("height", 0)) for item in words_meta) if words_meta else 0
        right_side_tokens = [
            item for item in words_meta
            if item.get("left", 0) > width * 0.6 and item.get("top", 0) < max_top * 0.35
        ]
        for item in right_side_tokens:
            text = item.get("text", "").strip()
            if not text:
                continue
            for pattern in [r"(?:MAWB|AWB)\s*[:\-]?\s*([0-9]{3}\s*[-\s]?\s*[0-9]{7,9}|[0-9]{8,15})", r"([0-9]{3}\s*[-\s]?\s*[0-9]{7,9}|[0-9]{8,15})"]:
                match = re.search(pattern, text, flags=re.IGNORECASE)
                if match:
                    candidate = match.group(1).strip()
                    candidate = re.sub(r"\s+", "", candidate)
                    if len(candidate) >= 8 and candidate not in seen:
                        candidates.append(candidate)
                        seen.add(candidate)

    return candidates


def _detect_manual_override(raw_text: str, weight_value: str | None) -> bool:
    """Heuristic check for a likely strikeout or overwritten weight value.

In a real production system, this would involve image analysis, stroke detection,
line segmentation, and handwriting classification. For the POC we use a practical
OCR heuristic: if a weight-like value is repeated or the OCR sees crossing marks,
we treat it as a likely handwritten override.
"""
    if not raw_text:
        return False

    weight_hint = "weight" in raw_text.lower() or "gross" in raw_text.lower()
    if not weight_hint:
        return False

    # A strong clue is the OCR text containing multiple numeric values near the weight label.
    weight_candidates = re.findall(r"(?:gross|net|weight)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?\s*(?:kg|kgs|lb|lbs)?)", raw_text, flags=re.IGNORECASE)

    if len(weight_candidates) > 1:
        return True

    override_markers = ["/", "\\", "~", "x", "override", "strik", "corr", "handw"]
    marker_hit = any(marker in raw_text.lower() for marker in override_markers)
    if marker_hit and weight_value:
        return True

    # If the same weight-like value appears multiple times in the same OCR block,
    # it could signal a strikeout/remnant and a later handwritten correction.
    number_count = len(re.findall(r"\d+(?:\.\d+)?", raw_text))
    if number_count > 3 and weight_value:
        return True

    return False


def extract_awb_fields(image: Image.Image) -> Dict[str, Any]:
    """OCR the image and return the main AWB fields plus override flag."""
    ocr_data = _extract_lines_from_ocr(image)
    raw_text = ocr_data["raw_text"]
    if not raw_text.strip():
        return {"success": False, "fields": {}, "confidence": 0.0, "raw_text": ""}

    associated_awb_numbers = extract_associated_awb_numbers(raw_text, ocr_data.get("words_meta"))

    awb_patterns = [
        r"\b(?:awb|airwaybill|waybill)\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Z0-9]{8,15})",
        r"\b([A-Z0-9]{8,15})\b(?:\s+.*)?\b(?:awb|waybill)\b",
    ]
    weight_patterns = [
        r"\b(?:gross|net|weight)\s*[:\-]?\s*([0-9]+(?:\.\d+)?)\s*(?:kg|kgs|kilograms|lb|lbs)",
        r"\b([0-9]+(?:\.\d+)?)\s*(?:kg|kgs|kilograms|lb|lbs)\b",
    ]
    piece_patterns = [
        r"\b(?:pcs|pieces|piece)\s*[:\-]?\s*(\d+)",
        r"\b(\d+)\s*(?:pcs|pieces|piece)\b",
    ]
    destination_patterns = [
        r"\b(?:dest|destination|to)\s*[:\-]?\s*([A-Z]{3})",
        r"\b([A-Z]{3})\b.*\b(?:dest|destination)\b",
    ]
    origin_patterns = [
        r"\b(?:origin|from)\s*[:\-]?\s*([A-Z]{3})",
        r"\b([A-Z]{3})\b.*\b(?:origin|from)\b",
    ]

    awb_value = _find_field_value(raw_text, awb_patterns)
    weight_value = _find_field_value(raw_text, weight_patterns)
    piece_count = _find_field_value(raw_text, piece_patterns)
    destination_value = _find_field_value(raw_text, destination_patterns)
    origin_value = _find_field_value(raw_text, origin_patterns)

    if associated_awb_numbers and (awb_value == "Not found" or awb_value is None):
        awb_value = associated_awb_numbers[0]

    fields = {
        "AWB Number": awb_value or "Not found",
        "Associated AWB Numbers": associated_awb_numbers if associated_awb_numbers else [],
        "Weight": weight_value or "Not found",
        "Pieces": piece_count or "Not found",
        "Origin": origin_value or "Not found",
        "Destination": destination_value or "Not found",
    }

    manual_override = _detect_manual_override(raw_text, weight_value)

    return {
        "success": True,
        "fields": fields,
        "confidence": float(ocr_data["confidence"]),
        "manual_override": manual_override,
        "raw_text": raw_text,
        "associated_awb_numbers": associated_awb_numbers,
    }
