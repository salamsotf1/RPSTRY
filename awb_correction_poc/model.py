"""Training helpers for a lightweight correction-risk model.

This project uses a small, explainable "model" trained on mock MAWB copies. The goal
is not to replace a production OCR AI, but to demonstrate how historical AWB copies
can be used to learn judgment thresholds for likely handwritten corrections.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, List


def _safe_float(value: Any) -> float:
    if value is None or str(value).strip() == "":
        return 0.0
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return 0.0


def load_mawb_copies(csv_path: str | Path) -> List[Dict[str, Any]]:
    """Load mock MAWB training examples from a CSV file.

    A training example is just a historical AWB record with a human label:
    - 1 = a handwritten correction was present
    - 0 = no correction was present
    """
    rows: List[Dict[str, Any]] = []
    with open(csv_path, newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            rows.append(
                {
                    "awb_number": row.get("awb_number", "").strip(),
                    "booked_weight": _safe_float(row.get("booked_weight", 0)),
                    "observed_weight": _safe_float(row.get("observed_weight", 0)),
                    "has_handwritten_override": str(row.get("has_handwritten_override", "0")).strip() in {"1", "true", "True"},
                    "override_type": row.get("override_type", "").strip(),
                    "label": int(row.get("label", 0) or 0),
                }
            )
    return rows


def build_training_record(awb_number: str, booked_weight: float | int, observed_weight: float | int, has_handwritten_override: bool, label: int) -> Dict[str, Any]:
    """Create a standardized training row from a user-labeled upload.

    This function keeps every uploaded sample in the same structure so the trainer
    can work with a consistent schema no matter where the data came from.
    """
    return {
        "awb_number": str(awb_number).strip(),
        "booked_weight": _safe_float(booked_weight),
        "observed_weight": _safe_float(observed_weight),
        "has_handwritten_override": bool(has_handwritten_override),
        "override_type": "manual_override" if has_handwritten_override else "none",
        "label": int(label),
    }


def train_correction_model(training_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Learn a small risk score from MAWB examples.

    The model keeps the logic simple and transparent:
    - handwritten overrides increase risk
    - larger weight discrepancies increase risk
    - the learned threshold is derived from the ratio of flagged examples in the dataset

    In plain English, the algorithm is just looking for the pattern that "abnormal
    handwritten AWB corrections usually have a bigger weight mismatch and a visible
    override signal".
    """
    if not training_rows:
        return {
            "sample_count": 0,
            "decision_threshold": 0.65,
            "weights": {
                "override": 0.0,
                "weight_delta": 0.0,
                "label_bias": 0.0,
            },
            "positive_examples": 0,
        }

    positive_examples = sum(1 for row in training_rows if int(row.get("label", 0)) == 1)
    total_rows = len(training_rows)

    weight_deltas = [abs(_safe_float(row.get("observed_weight", 0)) - _safe_float(row.get("booked_weight", 0))) for row in training_rows]
    avg_delta = sum(weight_deltas) / total_rows
    avg_positive_delta = sum(
        abs(_safe_float(row.get("observed_weight", 0)) - _safe_float(row.get("booked_weight", 0)))
        for row in training_rows
        if int(row.get("label", 0)) == 1
    ) / max(positive_examples, 1)

    override_rate = sum(1 for row in training_rows if row.get("has_handwritten_override", False)) / total_rows
    positive_override_rate = sum(
        1 for row in training_rows if row.get("has_handwritten_override", False) and int(row.get("label", 0)) == 1
    ) / max(positive_examples, 1)

    threshold = max(0.35, min(0.9, (positive_examples / total_rows) + 0.1))

    model = {
        "sample_count": total_rows,
        "decision_threshold": threshold,
        "weights": {
            "override": positive_override_rate - override_rate,
            "weight_delta": max(0.0, (avg_positive_delta - avg_delta) / max(avg_delta, 1.0)),
            "label_bias": positive_examples / total_rows,
        },
        "positive_examples": positive_examples,
    }
    return model


def predict_correction_risk(model: Dict[str, Any], record: Dict[str, Any]) -> float:
    """Estimate how likely a record is a true handwritten correction using the trained weights.

    The score is kept between 0 and 1 so we can compare it with the learned threshold.
    A record is considered risky when it combines a visible override marker with a large
    difference between the OCR weight and the booking weight.
    """
    observed_weight = _safe_float(record.get("observed_weight", 0))
    booked_weight = _safe_float(record.get("booked_weight", 0))
    weight_delta = abs(observed_weight - booked_weight)
    override_value = 1.0 if record.get("has_handwritten_override", False) else 0.0

    score = (
        model.get("weights", {}).get("label_bias", 0.0)
        + (model.get("weights", {}).get("override", 0.0) * override_value)
        + (model.get("weights", {}).get("weight_delta", 0.0) * min(weight_delta / max(booked_weight, 1.0), 1.0))
    )
    return max(0.0, min(1.0, score))
