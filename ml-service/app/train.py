"""
Training script for the SickleCare two-layer VOC risk model.

Re-implements the pipeline from VOC_PREDICTION2.ipynb as a standalone
script so it can be run during deployment / CI to (re)produce the
artifacts the FastAPI service loads at startup:

    models/model.joblib        - trained HistGradientBoostingClassifier
    models/label_encoder.joblib - genotype LabelEncoder
    models/class_rates.json    - mean crises/year per risk class
    models/meta.json           - feature list, threshold, genotype mapping

Usage:
    python app/train.py --csv /path/to/sickle_cell_africa_extra_large_10000.csv
"""
import argparse
import json
import math
import os
import warnings

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.preprocessing import LabelEncoder

try:
    from imblearn.over_sampling import SMOTE
    SMOTE_AVAILABLE = True
except ImportError:
    SMOTE_AVAILABLE = False

warnings.filterwarnings("ignore")

TARGET = "crises_per_year"
HIGH_THRESHOLD = 0.30

PROFILE_FEATURES = [
    "genotype",
    "on_hydroxyurea",
    "stroke_occurred",
    "splenic_sequestration_history",
    "acs_episodes_per_year",
    "penicillin_prophylaxis",
    "has_regular_pain_medications",
    "chronic_transfusions",
    "malaria_episodes_per_year",
    "complication_score",
    "treatment_intensity",
]

BOOL_COLS = [
    "stroke_occurred", "splenic_sequestration_history",
    "on_hydroxyurea", "penicillin_prophylaxis",
    "has_regular_pain_medications", "chronic_transfusions",
]


def make_risk_label(n):
    if n == 0:
        return "LOW"
    elif n <= 3:
        return "MEDIUM"
    return "HIGH"


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = df.columns.str.strip()
    for col in df.select_dtypes(include="object").columns:
        df[col] = df[col].astype(str).str.strip()
    df = df[df["has_scd"] == "True"].copy()
    return df


def engineer_features(df: pd.DataFrame):
    df = df.copy()
    for col in BOOL_COLS:
        df[col] = df[col].map({"True": 1, "False": 0, "1": 1, "0": 0}).fillna(0).astype(int)

    df["acs_episodes_per_year"] = pd.to_numeric(df["acs_episodes_per_year"], errors="coerce").fillna(0)
    df["malaria_episodes_per_year"] = pd.to_numeric(df["malaria_episodes_per_year"], errors="coerce").fillna(0)
    df[TARGET] = pd.to_numeric(df[TARGET], errors="coerce")

    df["complication_score"] = (
        df["stroke_occurred"]
        + df["splenic_sequestration_history"]
        + (df["acs_episodes_per_year"] > 0).astype(int)
    )
    df["treatment_intensity"] = (
        df["on_hydroxyurea"]
        + df["penicillin_prophylaxis"]
        + df["has_regular_pain_medications"]
        + df["chronic_transfusions"]
    )

    le = LabelEncoder()
    df["genotype"] = le.fit_transform(df["genotype"])
    df["risk"] = df[TARGET].apply(make_risk_label)

    df = df[PROFILE_FEATURES + [TARGET, "risk"]].dropna()
    return df, le


def train(csv_path: str, out_dir: str):
    df_raw = load_data(csv_path)
    df, le = engineer_features(df_raw)

    X_all = df[PROFILE_FEATURES]
    y_all = df["risk"]

    if SMOTE_AVAILABLE:
        min_class_count = y_all.value_counts().min()
        k = min(5, max(1, min_class_count - 1))
        sm = SMOTE(random_state=42, k_neighbors=k)
        X_res, y_res = sm.fit_resample(X_all, y_all)
    else:
        X_res, y_res = X_all, y_all

    model = HistGradientBoostingClassifier(
        max_iter=300,
        max_depth=5,
        learning_rate=0.05,
        class_weight="balanced",
        random_state=42,
    )

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    y_pred_cv = cross_val_predict(model, X_res, y_res, cv=cv)
    acc = accuracy_score(y_res, y_pred_cv)
    f1 = f1_score(y_res, y_pred_cv, average="macro")
    report = classification_report(y_res, y_pred_cv, output_dict=True)

    model.fit(X_res, y_res)

    class_rates = df.groupby("risk")[TARGET].mean().to_dict()

    os.makedirs(out_dir, exist_ok=True)
    joblib.dump(model, os.path.join(out_dir, "model.joblib"))
    joblib.dump(le, os.path.join(out_dir, "label_encoder.joblib"))

    with open(os.path.join(out_dir, "class_rates.json"), "w") as f:
        json.dump({k: float(v) for k, v in class_rates.items()}, f, indent=2)

    genotype_map = {cls: int(code) for code, cls in enumerate(le.classes_)}

    meta = {
        "profile_features": PROFILE_FEATURES,
        "high_threshold": HIGH_THRESHOLD,
        "genotype_map": genotype_map,
        "cv_accuracy": acc,
        "cv_macro_f1": f1,
        "cv_report": report,
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Trained on {len(df)} records (resampled to {len(X_res)})")
    print(f"CV accuracy: {acc:.1%}  Macro F1: {f1:.3f}")
    print(f"Artifacts written to {out_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="Path to sickle_cell_africa_extra_large_10000.csv")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "models"))
    args = parser.parse_args()
    train(args.csv, args.out)
