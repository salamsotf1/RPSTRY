"""Streamlit POC for detecting and reviewing handwritten AWB corrections.

This version covers the full workflow through the approval step:
- upload AWB image
- OCR extraction
- validation against mock booking data
- dashboard of flagged records
- human review form with editable values
- mock API submission in IATA FWB message format
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import streamlit as st
from PIL import Image

from cms_client import build_fwb_payload, post_mock_correction
from dashboard import build_flagged_dashboard_rows
from extract import extract_awb_fields
from model import build_training_record, load_mawb_copies, predict_correction_risk, train_correction_model
from validate import find_booking_row, load_booking_data, validate_extraction


BOOKINGS_PATH = Path(__file__).with_name("mock_bookings.csv")
MAWB_PATH = Path(__file__).with_name("mawb_copies.csv")

# Session state stores the review queue, extracted OCR data, training examples,
# and the current model. This keeps the POC simple while still letting the user
# train the model during the same browser session without a database.
if "flagged_rows" not in st.session_state:
    st.session_state.flagged_rows = []
if "selected_flag_index" not in st.session_state:
    st.session_state.selected_flag_index = None
if "validation_result" not in st.session_state:
    st.session_state.validation_result = None
if "extraction_result" not in st.session_state:
    st.session_state.extraction_result = None
if "training_rows" not in st.session_state:
    st.session_state.training_rows = load_mawb_copies(MAWB_PATH)
if "mawb_model" not in st.session_state:
    st.session_state.mawb_model = train_correction_model(st.session_state.training_rows)

st.set_page_config(
    page_title="AWB Correction Review",
    page_icon="✈️",
    layout="wide",
)

st.markdown(
    """
    <style>
    .stApp {
        background: linear-gradient(180deg, #f6f9ff 0%, #eef4ff 100%);
    }
    .main .block-container {
        padding-top: 2rem;
        padding-bottom: 2rem;
        max-width: 1400px;
    }
    div[data-testid="stAlert"] {
        border-radius: 12px;
    }
    .review-card {
        background: white;
        border: 1px solid #dfe8f7;
        border-radius: 14px;
        padding: 1rem 1.2rem;
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("AWB Correction Review")
st.caption("Upload an AWB, validate the OCR result, and route real handwritten corrections for human approval.")

# The warning/approval model is lightweight and explainable: it learns from prior
# examples and then checks whether a new AWB looks like a likely handwritten correction.
model = st.session_state.mawb_model
st.success(f"Model trained on {model['sample_count']} MAWB copies with a decision threshold of {model['decision_threshold']:.2f}.")

# Main upload for the current document being reviewed.
uploaded_file = st.file_uploader(
    "Upload AWB image",
    type=["png", "jpg", "jpeg"],
    help="Use a clear JPG or PNG scan of an air waybill with a handwritten correction.",
)

# This block teaches the model from multiple real-world-ish AWB copies. Each upload
# is treated like a new training example so the risk model can improve over time.
st.subheader("Train the model from uploaded AWB copies")
training_files = st.file_uploader(
    "Upload multiple AWB copies for training",
    type=["png", "jpg", "jpeg"],
    accept_multiple_files=True,
    help="Each uploaded image can be labeled as a correction or non-correction and added to the training set.",
)

if training_files:
    for file_index, uploaded_training_file in enumerate(training_files):
        # Read each uploaded copy and extract the same AWB fields used in the review flow.
        image = Image.open(uploaded_training_file)
        extracted = extract_awb_fields(image)
        if not extracted.get("success"):
            continue
        st.markdown(f"### Training sample {file_index + 1}")
        st.image(image, use_container_width=True)
        st.json(extracted.get("fields", {}))

        # Human labels become the teaching signal for the model.
        label_value = st.radio(
            f"Label this upload",
            ["Correction present", "No correction"],
            key=f"training_label_{file_index}",
            horizontal=True,
        )
        if st.button(f"Add sample {file_index + 1} to training set", key=f"add_training_{file_index}"):
            # Match the extracted AWB to the local booking file to estimate the original
            # booked weight, then compare it with the observed OCR weight.
            booked_weight = 0.0
            booking_rows = load_booking_data(BOOKINGS_PATH)
            awb_number = str(extracted.get("fields", {}).get("AWB Number", "")).strip()
            if awb_number and awb_number != "Not found":
                match = find_booking_row(awb_number, booking_rows)
                if match:
                    booked_weight = float(str(match.get("Weight", "0")).replace("kg", "").strip())
            observed_weight = 0.0
            weight_str = str(extracted.get("fields", {}).get("Weight", "0"))
            if weight_str and weight_str != "Not found":
                observed_weight = float(weight_str.split()[0])

            # Convert the human decision into a single training row that the model can learn from.
            training_record = build_training_record(
                awb_number or f"TRAIN-{file_index + 1}",
                booked_weight,
                observed_weight,
                bool(extracted.get("manual_override", False)),
                1 if label_value == "Correction present" else 0,
            )
            st.session_state.training_rows.append(training_record)
            # Retrain immediately so the new example is reflected in the current model.
            st.session_state.mawb_model = train_correction_model(st.session_state.training_rows)
            st.success(f"Sample {file_index + 1} added to the training set.")

    # This optional button rebuilds the model from the full current dataset, which is useful
    # when several uploads have been labeled in one session.
    if st.button("Retrain model from all uploaded examples"):
        st.session_state.mawb_model = train_correction_model(st.session_state.training_rows)
        st.success("Model retrained from the current training dataset.")

    st.write(f"Current training set size: {len(st.session_state.training_rows)}")
    st.dataframe(st.session_state.training_rows, use_container_width=True)

if uploaded_file is None:
    st.info("No image uploaded yet. Add an AWB photo to start the review workflow.")
    st.stop()

# Once a document is uploaded, run OCR and store the result so the rest of the page can
# read the same extracted values without reprocessing the image multiple times.
image = Image.open(uploaded_file)
st.session_state.extraction_result = extract_awb_fields(image)
extraction_result = st.session_state.extraction_result

st.subheader("Uploaded image")
st.image(image, use_container_width=True)

if not extraction_result.get("success"):
    st.error("No readable AWB text was detected. Please upload a clearer image.")
    st.stop()

left_col, right_col = st.columns([1.5, 1])

with left_col:
    st.markdown("### Extracted fields")
    field_rows = [
        {"Field": "AWB Number", "Value": extraction_result.get("fields", {}).get("AWB Number", "-")},
        {"Field": "Associated AWB Numbers", "Value": ", ".join(extraction_result.get("fields", {}).get("Associated AWB Numbers", [])) if extraction_result.get("fields", {}).get("Associated AWB Numbers") else "-"},
        {"Field": "Weight", "Value": extraction_result.get("fields", {}).get("Weight", "-")},
        {"Field": "Pieces", "Value": extraction_result.get("fields", {}).get("Pieces", "-")},
        {"Field": "Origin", "Value": extraction_result.get("fields", {}).get("Origin", "-")},
        {"Field": "Destination", "Value": extraction_result.get("fields", {}).get("Destination", "-")},
    ]
    st.dataframe(field_rows, hide_index=True, use_container_width=True)

with right_col:
    st.markdown("### Review signals")
    st.metric("OCR confidence", f"{extraction_result.get('confidence', 0.0):.0%}")
    if extraction_result.get("manual_override"):
        st.warning("Likely handwritten correction detected near the weight field.")
    else:
        st.info("No obvious override signal was detected in the OCR output.")

st.markdown("### Raw OCR text")
st.text_area("OCR output", extraction_result.get("raw_text", ""), height=180)

booking_rows = load_booking_data(BOOKINGS_PATH)
awb_number = str(extraction_result.get("fields", {}).get("AWB Number", "")).strip()
matching_row = find_booking_row(awb_number, booking_rows) if awb_number and awb_number != "Not found" else None
# The model makes a simple judgment using two signals:
# 1) whether a handwritten override was detected, and
# 2) how far the OCR weight differs from the booked weight.
risk_input = {
    "observed_weight": float(str(extraction_result.get("fields", {}).get("Weight", "0")).split()[0]) if str(extraction_result.get("fields", {}).get("Weight", "0")).split()[0].replace('.', '', 1).isdigit() else 0.0,
    "booked_weight": float(str(matching_row.get("Weight", "0"))) if matching_row and str(matching_row.get("Weight", "0")).replace('.', '', 1).isdigit() else 0.0,
    "has_handwritten_override": bool(extraction_result.get("manual_override", False)),
}
correction_risk = predict_correction_risk(model, risk_input)

st.metric("MAWB correction risk", f"{correction_risk:.0%}")

edi_rows = [
    {"EDI Field": "FWB", "OCR Value": "FWB", "Booking Value": "FWB", "Reviewed Value": "FWB"},
    {"EDI Field": "AWB Number", "OCR Value": extraction_result.get("fields", {}).get("AWB Number", "-"), "Booking Value": "-", "Reviewed Value": extraction_result.get("fields", {}).get("AWB Number", "-")},
    {"EDI Field": "Associated AWB Numbers", "OCR Value": ", ".join(extraction_result.get("fields", {}).get("Associated AWB Numbers", [])) if extraction_result.get("fields", {}).get("Associated AWB Numbers") else "-", "Booking Value": "-", "Reviewed Value": ", ".join(extraction_result.get("fields", {}).get("Associated AWB Numbers", [])) if extraction_result.get("fields", {}).get("Associated AWB Numbers") else "-"},
    {"EDI Field": "Weight", "OCR Value": extraction_result.get("fields", {}).get("Weight", "-"), "Booking Value": "-", "Reviewed Value": extraction_result.get("fields", {}).get("Weight", "-")},
    {"EDI Field": "Pieces", "OCR Value": extraction_result.get("fields", {}).get("Pieces", "-"), "Booking Value": "-", "Reviewed Value": extraction_result.get("fields", {}).get("Pieces", "-")},
    {"EDI Field": "Origin", "OCR Value": extraction_result.get("fields", {}).get("Origin", "-"), "Booking Value": "-", "Reviewed Value": extraction_result.get("fields", {}).get("Origin", "-")},
    {"EDI Field": "Destination", "OCR Value": extraction_result.get("fields", {}).get("Destination", "-"), "Booking Value": "-", "Reviewed Value": extraction_result.get("fields", {}).get("Destination", "-")},
]

st.markdown("### FWB EDI extraction grid")
st.dataframe(edi_rows, hide_index=True, use_container_width=True)

validate_button = st.button("Validate against mock booking data")

if validate_button:
    booking_rows = load_booking_data(BOOKINGS_PATH)
    awb_number = str(extraction_result.get("fields", {}).get("AWB Number", "")).strip()
    matching_row = find_booking_row(awb_number, booking_rows) if awb_number and awb_number != "Not found" else None
    validation_result = validate_extraction(extraction_result, matching_row)
    st.session_state.validation_result = validation_result

    if validation_result.get("status") == "flagged":
        new_flag = {
            "AWB Number": validation_result.get("awb_number") or awb_number,
            "Original Value": validation_result.get("original_value") or "-",
            "Corrected Value": validation_result.get("corrected_value") or "-",
            "Status": "flagged",
        }
        if new_flag not in st.session_state.flagged_rows:
            st.session_state.flagged_rows.append(new_flag)

if st.session_state.validation_result:
    validation_result = st.session_state.validation_result
    st.subheader("Validation result")
    status_color = "warning" if validation_result.get("status") == "flagged" else "info"
    if validation_result.get("status") == "rejected":
        st.error(validation_result.get("reason", "Validation failed."))
    elif validation_result.get("status") == "flagged":
        st.warning(validation_result.get("reason", "Correction flagged for review."))
    else:
        st.info(validation_result.get("reason", "No correction flagged."))

    st.json({
        "status": validation_result.get("status"),
        "confidence": validation_result.get("confidence"),
        "awb_number": validation_result.get("awb_number"),
        "original_value": validation_result.get("original_value"),
        "corrected_value": validation_result.get("corrected_value"),
    })

if st.session_state.flagged_rows:
    st.subheader("Flagged AWB dashboard")
    dashboard_rows = build_flagged_dashboard_rows(st.session_state.flagged_rows)

    for index, row in enumerate(dashboard_rows):
        cols = st.columns([3, 2, 2, 1])
        with cols[0]:
            st.write(row["AWB Number"])
        with cols[1]:
            st.write(row["Original Value"])
        with cols[2]:
            st.write(row["Corrected Value"])
        with cols[3]:
            if st.button("Open", key=f"open_row_{index}"):
                st.session_state.selected_flag_index = index

    if st.session_state.selected_flag_index is not None:
        selected_row = dashboard_rows[st.session_state.selected_flag_index]
        st.subheader(f"Review record: {selected_row['AWB Number']}")

        review_col, form_col = st.columns([1.2, 1.3])

        with review_col:
            st.markdown("### Full image")
            st.image(image, use_container_width=True)

        with form_col:
            st.markdown("### Editable extraction form")
            fields = extraction_result.get("fields", {})
            with st.form("review_form"):
                awb_value = st.text_input("AWB Number", value=fields.get("AWB Number", selected_row["AWB Number"]))
                weight_value = st.text_input("Weight", value=fields.get("Weight", selected_row["Corrected Value"]))
                pieces_value = st.text_input("Pieces", value=fields.get("Pieces", "Not found"))
                origin_value = st.text_input("Origin", value=fields.get("Origin", "Not found"))
                destination_value = st.text_input("Destination", value=fields.get("Destination", "Not found"))

                decision_col_1, decision_col_2 = st.columns(2)
                with decision_col_1:
                    approve_button = st.form_submit_button("Approve", use_container_width=True)
                with decision_col_2:
                    reject_button = st.form_submit_button("Reject", type="secondary", use_container_width=True)

                if approve_button:
                    corrected_fields = {
                        "AWB Number": awb_value,
                        "Weight": weight_value,
                        "Pieces": pieces_value,
                        "Origin": origin_value,
                        "Destination": destination_value,
                    }
                    payload = build_fwb_payload(fields, corrected_fields)
                    mock_response = post_mock_correction(payload, session_token="mock-session-token")

                    st.success("Correction approved and sent to the mock API.")
                    st.markdown("### Request payload")
                    st.json(payload)
                    st.markdown("### API response")
                    st.json(mock_response)

                if reject_button:
                    st.warning("Correction rejected for manual follow-up.")
                    st.info("The AWB remains in the queue for a human review decision without POSTing the FWB correction.")

        st.markdown("### EDI review grid")
        review_grid = [
            {"EDI Field": "AWB Number", "OCR Value": awb_value, "Original": selected_row["Original Value"], "Reviewed": awb_value},
            {"EDI Field": "Weight", "OCR Value": weight_value, "Original": selected_row["Original Value"], "Reviewed": weight_value},
            {"EDI Field": "Pieces", "OCR Value": pieces_value, "Original": fields.get("Pieces", "-"), "Reviewed": pieces_value},
            {"EDI Field": "Origin", "OCR Value": origin_value, "Original": fields.get("Origin", "-"), "Reviewed": origin_value},
            {"EDI Field": "Destination", "OCR Value": destination_value, "Original": fields.get("Destination", "-"), "Reviewed": destination_value},
        ]
        st.dataframe(review_grid, hide_index=True, use_container_width=True)

        st.markdown("### API CCA request out to the CMS")
        api_request = {
            "api": {
                "endpoint": "https://cms-mock.example.com/api/v1/awb/corrections",
                "method": "POST",
                "auth": {
                    "type": "Bearer",
                    "token": "mock-session-token",
                    "user": "ops-agent-01",
                    "role": "AWB_REVIEWER",
                },
                "headers": {
                    "Content-Type": "application/json",
                    "X-Session-Id": "CMS-SESSION-12345",
                    "X-Trace-Id": "TRACE-AWB-78910",
                },
            },
            "payload": {
                "messageType": "FWB",
                "awbNumber": awb_value,
                "associatedAwbNumbers": extraction_result.get("fields", {}).get("Associated AWB Numbers", []),
                "originalWeight": fields.get("Weight", "0"),
                "correctedWeight": weight_value,
                "pieces": pieces_value,
                "origin": origin_value,
                "destination": destination_value,
                "correctionReason": "handwritten_override_detected",
                "manualReview": True,
                "status": "pending_cms_acceptance",
            },
        }
        st.dataframe([
            {"Field": "Endpoint", "Value": api_request["api"]["endpoint"]},
            {"Field": "Method", "Value": api_request["api"]["method"]},
            {"Field": "Auth Token", "Value": api_request["api"]["auth"]["token"]},
            {"Field": "Session ID", "Value": api_request["api"]["headers"]["X-Session-Id"]},
            {"Field": "Trace ID", "Value": api_request["api"]["headers"]["X-Trace-Id"]},
        ], hide_index=True, use_container_width=True)
        st.json(api_request)

with st.expander("Advanced OCR debug"):
    st.json({
        "manual_override": extraction_result.get("manual_override", False),
        "confidence": extraction_result.get("confidence", 0.0),
        "fields": extraction_result.get("fields", {}),
    })
