"""Mock CMS client for posting a corrected AWB payload.

This is a placeholder for the later workflow where a human reviewer approves the
change and a JSON FWB payload is sent to a mock API endpoint with a session/auth token.
"""

from __future__ import annotations

import json
from typing import Any, Dict


def build_fwb_payload(extracted_fields: Dict[str, Any], corrected_fields: Dict[str, Any]) -> Dict[str, Any]:
    """Construct a mock IATA FWB-style payload for a correction approval event."""
    return {
        "messageType": "FWB",
        "awbNumber": extracted_fields.get("AWB Number", "UNKNOWN"),
        "originalWeight": extracted_fields.get("Weight", "0"),
        "correctedWeight": corrected_fields.get("Weight", extracted_fields.get("Weight", "0")),
        "correctionReason": "handwritten_override_detected",
        "pieces": extracted_fields.get("Pieces", "0"),
        "origin": extracted_fields.get("Origin", "UNK"),
        "destination": extracted_fields.get("Destination", "UNK"),
        "status": "pending_review",
    }


def post_mock_correction(payload: Dict[str, Any], session_token: str = "mock-session-token") -> Dict[str, Any]:
    """Return a mocked API response to simulate an authenticated CMS submission."""
    headers = {
        "Authorization": f"Bearer {session_token}",
        "Content-Type": "application/json",
    }

    response = {
        "status": "accepted",
        "message": "Correction payload accepted by mock CMS endpoint.",
        "request": payload,
        "headers": headers,
        "request_id": "mock-request-001",
    }

    return response
