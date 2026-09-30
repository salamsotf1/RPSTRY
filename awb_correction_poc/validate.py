"""Validation agent logic for AWB OCR results.

The validation phase re-checks OCR confidence and compares extracted values against
mock booking data. A record is only flagged when a likely handwritten override is
present and the corrected value differs from the stored booking record.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text.replace("kg", "").replace("kgs", "").replace("lb", "").replace("lbs", "").strip()


def load_booking_data(csv_path: str | Path) -> List[Dict[str, Any]]:
    """Load mock booking data from a CSV file."""
    data: List[Dict[str, Any]] = []
    with open(csv_path, newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            cleaned_row = {key: (value.strip() if isinstance(value, str) else value) for key, value in row.items()}
            data.append(cleaned_row)
    return data


def find_booking_row(awb_number: str, booking_rows: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Find the matching mock booking row by AWB number, if present."""
    if not awb_number:
        return None
    normalized_target = str(awb_number).strip()
    for row in booking_rows:
        if str(row.get("AWB Number", "")).strip() == normalized_target:
            return row
    return None


def validate_extraction(extraction_result: Dict[str, Any], booking_row: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Validate OCR output and flag a real correction when it differs from mock booking data."""
    if not extraction_result.get("success"):
        return {
            "status": "rejected",
            "reason": "Extraction failed or OCR text is unreadable.",
            "confidence": 0.0,
        }

    confidence = float(extraction_result.get("confidence", 0.0))
    if confidence < 0.6:
        return {
            "status": "rejected",
            "reason": "OCR confidence is too low to continue.",
            "confidence": confidence,
        }

    fields = extraction_result.get("fields", {})
    awb_number = str(fields.get("AWB Number", "")).strip()
    extracted_weight = fields.get("Weight", "")
    booking_weight = booking_row.get("Weight") if booking_row else None

    # Real corrections are only meaningful when the OCR sees an override and the value differs
    # from the stored booking record.
    has_override = bool(extraction_result.get("manual_override", False))
    normalized_extracted = _normalize_text(extracted_weight)
    normalized_booking = _normalize_text(booking_weight)

    if booking_row and has_override and normalized_extracted and normalized_extracted != normalized_booking:
        return {
            "status": "flagged",
            "reason": "Likely handwritten correction differs from the stored booking value.",
            "confidence": confidence,
            "awb_number": awb_number,
            "original_value": normalized_booking,
            "corrected_value": str(extracted_weight).strip(),
            "booking_row": booking_row,
            "fields": fields,
        }

    if booking_row and normalized_extracted and normalized_extracted == normalized_booking:
        return {
            "status": "no_change",
            "reason": "Extracted value matches the booking data.",
            "confidence": confidence,
            "awb_number": awb_number,
            "original_value": normalized_booking,
            "corrected_value": str(extracted_weight).strip(),
            "booking_row": booking_row,
        }

    return {
        "status": "pending_review",
        "reason": "Validation passed basic checks, but no direct booking mismatch was confirmed.",
        "confidence": confidence,
        "awb_number": awb_number,
        "original_value": normalized_booking,
        "corrected_value": str(extracted_weight).strip(),
        "booking_row": booking_row,
        "fields": fields,
    }
