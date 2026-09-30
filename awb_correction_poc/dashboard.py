"""Dashboard helpers for the AWB correction review workflow.

The dashboard presents a list of flagged AWBs and prepares the metadata used by the
review form and approval flow.
"""

from __future__ import annotations

from typing import Any, Dict, List


def build_flagged_dashboard_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return a UI-ready list of flagged AWB records."""
    dashboard_rows: List[Dict[str, Any]] = []
    for row in rows:
        dashboard_rows.append(
            {
                "AWB Number": row.get("AWB Number", "N/A"),
                "Original Value": row.get("Original Value", "-"),
                "Corrected Value": row.get("Corrected Value", "-"),
                "Status": row.get("Status", "flagged"),
            }
        )
    return dashboard_rows
