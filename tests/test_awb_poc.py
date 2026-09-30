import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "awb_correction_poc"))

from validate import validate_extraction
from cms_client import build_fwb_payload
from model import train_correction_model, predict_correction_risk, load_mawb_copies, build_training_record
from extract import extract_associated_awb_numbers


def test_validate_extraction_flags_weight_difference_when_override_detected():
    extraction = {
        "success": True,
        "confidence": 0.92,
        "manual_override": True,
        "fields": {"AWB Number": "0981234567", "Weight": "1400 kg"},
    }
    booking_row = {"AWB Number": "0981234567", "Weight": "1200", "Origin": "AMS", "Destination": "DXB"}

    result = validate_extraction(extraction, booking_row)

    assert result["status"] == "flagged"
    assert result["original_value"] == "1200"
    assert result["corrected_value"] == "1400 kg"


def test_validate_extraction_rejects_low_confidence():
    extraction = {"success": True, "confidence": 0.2, "manual_override": True, "fields": {"Weight": "1400 kg"}}

    result = validate_extraction(extraction, {"AWB Number": "123"})

    assert result["status"] == "rejected"
    assert "confidence" in result


def test_build_fwb_payload_contains_correction_values():
    extracted = {"AWB Number": "0981234567", "Weight": "1200 kg", "Pieces": "2", "Origin": "AMS", "Destination": "DXB"}
    corrected = {"AWB Number": "0981234567", "Weight": "1400 kg", "Pieces": "2", "Origin": "AMS", "Destination": "DXB"}

    payload = build_fwb_payload(extracted, corrected)

    assert payload["messageType"] == "FWB"
    assert payload["originalWeight"] == "1200 kg"
    assert payload["correctedWeight"] == "1400 kg"


def test_mawb_training_pipeline_builds_risk_for_override_examples():
    training_rows = load_mawb_copies("/Users/abdulsalambakrudeen/Desktop/AirCargo/awb_correction_poc/mawb_copies.csv")
    model = train_correction_model(training_rows)

    assert model["sample_count"] > 0
    high_risk = predict_correction_risk(model, {"observed_weight": 1400, "booked_weight": 1200, "has_handwritten_override": True})
    low_risk = predict_correction_risk(model, {"observed_weight": 2200, "booked_weight": 2200, "has_handwritten_override": False})

    assert high_risk > low_risk
    assert high_risk >= model["decision_threshold"] * 0.8


def test_build_training_record_tracks_label_and_override_values():
    record = build_training_record("0981234567", 1200, 1400, True, 1)

    assert record["awb_number"] == "0981234567"
    assert record["booked_weight"] == 1200
    assert record["observed_weight"] == 1400
    assert record["has_handwritten_override"] is True
    assert record["label"] == 1


def test_extract_associated_awb_numbers_detects_top_right_values():
    text = "MAWB 12345678\nAWB 123-4567891\nPILOT COPY"

    values = extract_associated_awb_numbers(text)

    assert "12345678" in values
    assert "123-4567891" in values
