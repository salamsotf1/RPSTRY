# AWB Correction Review POC

This project demonstrates a Streamlit proof of concept for detecting handwritten AWB corrections in uploaded images.

## Current phase

- Upload page
- OCR extraction of AWB fields
- Heuristic override detection near the weight field

## Planned future phases

- Validation against mock booking data
- Dashboard of flagged AWBs
- Human review form and approval flow
- Mock API submission in IATA FWB format

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Note: `pytesseract` requires a local Tesseract binary installation.
