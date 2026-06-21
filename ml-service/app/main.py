"""
SickleCare ML microservice (Layer 4 - Prediction Service).

Loads the pre-trained two-layer VOC risk model and exposes it over HTTP
so the Express backend (and, for fully-offline use, the React Native app
bundling the same model) can request predictions.

Run:
    uvicorn app.main:app --host 0.0.0.0 --port 8000

If models/model.joblib is missing, run app/train.py first:
    python app/train.py --csv /path/to/sickle_cell_africa_extra_large_10000.csv
"""
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from .predict import VOCModel, MODELS_DIR

app = FastAPI(
    title="SickleCare ML Service",
    description="Two-layer VOC crisis risk prediction",
    version="1.0.0",
)

_model: Optional[VOCModel] = None


def get_model() -> VOCModel:
    global _model
    if _model is None:
        if not os.path.exists(os.path.join(MODELS_DIR, "model.joblib")):
            raise HTTPException(
                status_code=503,
                detail="Model artifacts not found. Run app/train.py to generate them.",
            )
        _model = VOCModel()
    return _model


class PatientProfile(BaseModel):
    genotype: str = Field(..., description="HbSS, HbSC, HbS-β+ thalassemia, or HbS-β0 thalassemia")
    on_hydroxyurea: bool = False
    stroke_occurred: bool = False
    splenic_sequestration_history: bool = False
    acs_episodes_per_year: float = 0
    penicillin_prophylaxis: bool = False
    has_regular_pain_medications: bool = False
    chronic_transfusions: bool = False
    malaria_episodes_per_year: float = 0


class WearableReading(BaseModel):
    avg_spo2: float = 98
    avg_heart_rate: float = 75
    skin_temp_c: float = 36.5
    steps_today: int = 5000
    sleep_hours: float = 7


class ManualLog(BaseModel):
    pain_today: int = Field(..., ge=0, le=10)
    sleep_quality: int = Field(..., ge=0, le=2)
    hydration_ok: bool
    mood: int = Field(..., ge=0, le=2)
    activity_level: int = Field(..., ge=0, le=2)


class PredictionRequest(BaseModel):
    profile: PatientProfile
    wearable: Optional[WearableReading] = None
    manual_log: Optional[ManualLog] = None


class PredictionResponse(BaseModel):
    risk_class: str
    class_proba: dict
    baseline_annual_rate: float
    daily_modifier: float
    voc_probability_30d: float
    data_source: str
    advice: str


@app.get("/health")
def health():
    model_ready = os.path.exists(os.path.join(MODELS_DIR, "model.joblib"))
    return {"status": "ok", "model_ready": model_ready}


@app.post("/predict", response_model=PredictionResponse)
def predict(req: PredictionRequest):
    model = get_model()

    wearable = req.wearable.dict() if req.wearable else None
    manual_log = req.manual_log.dict() if req.manual_log else None

    result = model.predict(
        profile=req.profile.dict(),
        wearable=wearable,
        manual_log=manual_log,
    )
    return result


@app.get("/meta")
def meta():
    model = get_model()
    return {
        "profile_features": model.profile_features,
        "high_threshold": model.high_threshold,
        "genotype_map": model.genotype_map,
        "class_rates": model.class_rates,
        "cv_accuracy": model.meta.get("cv_accuracy"),
        "cv_macro_f1": model.meta.get("cv_macro_f1"),
    }