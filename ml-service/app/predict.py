"""
Two-layer VOC risk prediction logic (report section 4.7).

Layer 1: HistGradientBoostingClassifier over the patient's static profile
         -> baseline risk class (LOW / MEDIUM / HIGH) and class probabilities.
Layer 2: A daily multiplier derived from either wearable readings (Google Fit)
         or a manual symptom log, applied to the baseline annual crisis rate
         to produce a 30-day VOC probability via a Poisson-style formula.
"""
import json
import math
import os

import joblib
import numpy as np
import pandas as pd

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


class VOCModel:
    def __init__(self, models_dir: str = MODELS_DIR):
        self.model = joblib.load(os.path.join(models_dir, "model.joblib"))
        self.label_encoder = joblib.load(os.path.join(models_dir, "label_encoder.joblib"))
        with open(os.path.join(models_dir, "class_rates.json")) as f:
            self.class_rates = json.load(f)
        with open(os.path.join(models_dir, "meta.json")) as f:
            self.meta = json.load(f)
        self.profile_features = self.meta["profile_features"]
        self.high_threshold = self.meta["high_threshold"]
        self.genotype_map = self.meta["genotype_map"]

    def encode_genotype(self, genotype: str) -> int:
        """Map a genotype label (e.g. 'HbSS') to the encoded value the model expects."""
        if genotype in self.genotype_map:
            return self.genotype_map[genotype]
        # Unknown genotype label -> fall back to the most common encoded class
        return 0

    def _prepare_profile(self, profile: dict) -> dict:
        profile = dict(profile)

        if isinstance(profile.get("genotype"), str):
            profile["genotype"] = self.encode_genotype(profile["genotype"])

        for key in [
            "on_hydroxyurea", "stroke_occurred", "splenic_sequestration_history",
            "penicillin_prophylaxis", "has_regular_pain_medications", "chronic_transfusions",
        ]:
            profile[key] = int(bool(profile.get(key, 0)))

        profile["acs_episodes_per_year"] = float(profile.get("acs_episodes_per_year", 0))
        profile["malaria_episodes_per_year"] = float(profile.get("malaria_episodes_per_year", 0))

        if "complication_score" not in profile:
            profile["complication_score"] = (
                profile["stroke_occurred"]
                + profile["splenic_sequestration_history"]
                + int(profile["acs_episodes_per_year"] > 0)
            )
        if "treatment_intensity" not in profile:
            profile["treatment_intensity"] = (
                profile["on_hydroxyurea"]
                + profile["penicillin_prophylaxis"]
                + profile["has_regular_pain_medications"]
                + profile["chronic_transfusions"]
            )

        return profile

    @staticmethod
    def daily_modifier_wearable(wearable: dict) -> float:
        m = 1.0

        spo2 = wearable.get("avg_spo2", 98)
        if spo2 < 92:
            m *= 3.0
        elif spo2 < 95:
            m *= 2.0
        elif spo2 < 97:
            m *= 1.3
        else:
            m *= 0.85

        hr = wearable.get("avg_heart_rate", 75)
        if hr > 110:
            m *= 2.0
        elif hr > 95:
            m *= 1.4
        elif hr > 85:
            m *= 1.1
        else:
            m *= 0.9

        temp = wearable.get("skin_temp_c", 36.5)
        if temp > 38.5:
            m *= 2.5
        elif temp > 37.5:
            m *= 1.5
        else:
            m *= 0.9

        steps = wearable.get("steps_today", 5000)
        if steps < 1000:
            m *= 1.4
        elif steps < 3000:
            m *= 1.1
        elif steps > 8000:
            m *= 0.8

        sleep = wearable.get("sleep_hours", 7)
        if sleep < 4:
            m *= 1.5
        elif sleep < 6:
            m *= 1.2
        elif sleep > 8:
            m *= 0.85

        return m

    @staticmethod
    def daily_modifier_manual(pain_today, sleep_quality, hydration_ok, mood, activity_level) -> float:
        m = 1.0
        if pain_today >= 7:
            m *= 2.5
        elif pain_today >= 4:
            m *= 1.4
        else:
            m *= 0.7
        m *= 1.4 if not hydration_ok else 0.9
        m *= {0: 1.3, 1: 1.0, 2: 0.8}.get(int(sleep_quality), 1.0)
        m *= {0: 1.2, 1: 1.0, 2: 0.85}.get(int(mood), 1.0)
        m *= {0: 1.3, 1: 1.0, 2: 0.7}.get(int(activity_level), 1.0)
        return m

    def predict(self, profile: dict, wearable: dict = None, manual_log: dict = None) -> dict:
        profile = self._prepare_profile(profile)

        X = pd.DataFrame([profile])[self.profile_features]
        proba = self.model.predict_proba(X)[0]
        classes = list(self.model.classes_)

        baseline_rate = sum(p * self.class_rates.get(cls, 0.0) for cls, p in zip(classes, proba))

        if wearable:
            modifier = self.daily_modifier_wearable(wearable)
            data_source = "wearable"
        elif manual_log:
            modifier = self.daily_modifier_manual(
                manual_log["pain_today"], manual_log["sleep_quality"],
                manual_log["hydration_ok"], manual_log["mood"], manual_log["activity_level"],
            )
            data_source = "manual"
        else:
            modifier = 1.0
            data_source = "profile_only"

        adjusted_rate = baseline_rate * modifier
        prob_30d = float(min(1 - math.exp(-adjusted_rate / 365 * 30), 0.95))

        high_idx = classes.index("HIGH")
        risk_class = "HIGH" if proba[high_idx] >= self.high_threshold else classes[int(np.argmax(proba))]

        if prob_30d >= 0.35:
            advice = "HIGH RISK - contact your care team today"
        elif prob_30d >= 0.15:
            advice = "MODERATE - stay hydrated, rest, and monitor closely"
        else:
            advice = "LOW RISK - keep up the good habits"

        return {
            "risk_class": risk_class,
            "class_proba": {cls: float(p) for cls, p in zip(classes, proba)},
            "baseline_annual_rate": float(baseline_rate),
            "daily_modifier": float(modifier),
            "voc_probability_30d": prob_30d,
            "data_source": data_source,
            "advice": advice,
        }
