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

    @staticmethod
    def explain_manual_factors(pain_today, sleep_quality, hydration_ok, mood, activity_level) -> list:
        """
        Mirrors the thresholds in daily_modifier_manual() and turns each one into a
        plain-language factor the patient can act on. Each factor records its
        multiplier so callers can rank/sort by impact (mult > 1 raises risk,
        mult < 1 lowers it).
        """
        factors = []

        if pain_today >= 7:
            factors.append({
                "mult": 2.5,
                "detail": f"Severe pain reported today ({pain_today}/10) is the biggest driver of your risk today.",
                "tip": "Take your prescribed pain medication, rest, and contact your care team if pain doesn't ease.",
            })
        elif pain_today >= 4:
            factors.append({
                "mult": 1.4,
                "detail": f"Moderate pain reported today ({pain_today}/10) raises your risk somewhat.",
                "tip": "Rest, stay hydrated, and monitor your pain levels closely.",
            })
        else:
            factors.append({
                "mult": 0.7,
                "detail": f"Pain levels were low today ({pain_today}/10), which helps lower your risk.",
                "tip": None,
            })

        if hydration_ok:
            factors.append({"mult": 0.9, "detail": "You stayed hydrated today, which helps reduce risk.", "tip": None})
        else:
            factors.append({
                "mult": 1.4,
                "detail": "Hydration was inadequate today - dehydration is a known crisis trigger.",
                "tip": "Drink water steadily through the day - aim for at least 8 glasses.",
            })

        sq = int(sleep_quality)
        if sq == 0:
            factors.append({
                "mult": 1.3,
                "detail": "Sleep quality was poor last night, which can increase crisis risk.",
                "tip": "Try to rest more today and prioritize sleep tonight.",
            })
        elif sq == 2:
            factors.append({"mult": 0.8, "detail": "You got good quality sleep, which helps lower your risk.", "tip": None})

        md = int(mood)
        if md == 0:
            factors.append({
                "mult": 1.2,
                "detail": "Low mood or stress today can contribute to crisis risk.",
                "tip": "Try a relaxation technique, and reach out to your support network if stress is high.",
            })
        elif md == 2:
            factors.append({"mult": 0.85, "detail": "Good mood today is a positive sign.", "tip": None})

        al = int(activity_level)
        if al == 0:
            factors.append({
                "mult": 1.3,
                "detail": "Low activity today may be your body signaling that you're not feeling your usual self.",
                "tip": "Take it easy today and avoid overexertion.",
            })
        elif al == 2:
            factors.append({"mult": 0.7, "detail": "Staying active today is a good sign.", "tip": None})

        return factors

    @staticmethod
    def explain_wearable_factors(wearable: dict) -> list:
        """Mirrors the thresholds in daily_modifier_wearable() as plain-language factors."""
        factors = []

        spo2 = wearable.get("avg_spo2", 98)
        if spo2 < 92:
            factors.append({
                "mult": 3.0,
                "detail": f"Blood oxygen was very low ({spo2:.0f}%) - this significantly increases your risk.",
                "tip": "Monitor your breathing closely. If it doesn't improve, seek medical attention now.",
            })
        elif spo2 < 95:
            factors.append({
                "mult": 2.0,
                "detail": f"Blood oxygen was below normal ({spo2:.0f}%), which raises your risk.",
                "tip": "Rest and monitor your breathing. Contact your care team if it doesn't improve.",
            })
        elif spo2 < 97:
            factors.append({"mult": 1.3, "detail": f"Blood oxygen was slightly low ({spo2:.0f}%).", "tip": None})
        else:
            factors.append({"mult": 0.85, "detail": f"Blood oxygen levels were healthy ({spo2:.0f}%).", "tip": None})

        hr = wearable.get("avg_heart_rate", 75)
        if hr > 110:
            factors.append({
                "mult": 2.0,
                "detail": f"Resting heart rate was very elevated ({hr:.0f} bpm), which raises your risk.",
                "tip": "Rest and avoid strenuous activity. Contact your care team if it stays elevated.",
            })
        elif hr > 95:
            factors.append({"mult": 1.4, "detail": f"Heart rate was elevated ({hr:.0f} bpm).", "tip": "Rest and stay calm today."})
        elif hr > 85:
            factors.append({"mult": 1.1, "detail": f"Heart rate was slightly elevated ({hr:.0f} bpm).", "tip": None})
        else:
            factors.append({"mult": 0.9, "detail": f"Heart rate was normal ({hr:.0f} bpm).", "tip": None})

        temp = wearable.get("skin_temp_c", 36.5)
        if temp > 38.5:
            factors.append({
                "mult": 2.5,
                "detail": f"Skin temperature was high ({temp:.1f}°C), suggesting possible fever - a major risk driver.",
                "tip": "Monitor your temperature closely. Infection can trigger crises - contact your care team.",
            })
        elif temp > 37.5:
            factors.append({"mult": 1.5, "detail": f"Skin temperature was mildly elevated ({temp:.1f}°C).", "tip": "Keep monitoring your temperature today."})
        else:
            factors.append({"mult": 0.9, "detail": f"Skin temperature was normal ({temp:.1f}°C).", "tip": None})

        steps = wearable.get("steps_today", 5000)
        if steps < 1000:
            factors.append({
                "mult": 1.4,
                "detail": f"Very low activity today ({int(steps)} steps) may indicate you're not feeling well.",
                "tip": "Rest today and monitor for any new symptoms.",
            })
        elif steps < 3000:
            factors.append({"mult": 1.1, "detail": f"Activity was below your usual level ({int(steps)} steps).", "tip": None})
        elif steps > 8000:
            factors.append({"mult": 0.8, "detail": f"Good activity level today ({int(steps)} steps).", "tip": None})

        sleep = wearable.get("sleep_hours", 7)
        if sleep < 4:
            factors.append({
                "mult": 1.5,
                "detail": f"Very little sleep last night ({sleep:.1f} hrs) significantly raises your risk.",
                "tip": "Prioritize rest today and aim for a full night's sleep tonight.",
            })
        elif sleep < 6:
            factors.append({"mult": 1.2, "detail": f"Sleep was below recommended levels ({sleep:.1f} hrs).", "tip": "Try to get extra rest tonight."})
        elif sleep > 8:
            factors.append({"mult": 0.85, "detail": f"You got plenty of rest ({sleep:.1f} hrs).", "tip": None})

        return factors

    @staticmethod
    def _compose_explanation(risk_class: str, prob_30d: float, data_source: str, factors: list) -> dict:
        """Turns a list of {mult, detail, tip} factors into (explanation, reasons, tips)."""
        pct = round(prob_30d * 100)

        if data_source == "profile_only":
            explanation = (
                f"Your 30-day VOC risk is {pct}% ({risk_class}), based on your medical profile only - "
                "no symptom log was available today. Log your symptoms for a more accurate daily prediction."
            )
            return {"explanation": explanation, "reasons": [], "tips": ["Log today's symptoms for a more accurate, personalised prediction."]}

        risk_factors = sorted([f for f in factors if f["mult"] > 1.0], key=lambda f: -f["mult"])
        protective_factors = [f for f in factors if f["mult"] <= 1.0]

        reasons = [f["detail"] for f in risk_factors] + [f["detail"] for f in protective_factors]

        if risk_factors:
            lead = risk_factors[0]["detail"]
            explanation = f"Your 30-day VOC risk is {pct}% ({risk_class}). {lead}"
            if len(risk_factors) > 1:
                explanation += f" {risk_factors[1]['detail']}"
        elif protective_factors:
            explanation = (
                f"Your 30-day VOC risk is {pct}% ({risk_class}). Today's symptoms look good overall - "
                f"{protective_factors[0]['detail'][0].lower()}{protective_factors[0]['detail'][1:]}"
            )
        else:
            explanation = f"Your 30-day VOC risk is {pct}% ({risk_class})."

        tips = []
        for f in risk_factors:
            if f["tip"] and f["tip"] not in tips:
                tips.append(f["tip"])
        tips = tips[:3]

        return {"explanation": explanation, "reasons": reasons, "tips": tips}

    def predict(self, profile: dict, wearable: dict = None, manual_log: dict = None) -> dict:
        profile = self._prepare_profile(profile)

        X = pd.DataFrame([profile])[self.profile_features]
        proba = self.model.predict_proba(X)[0]
        classes = list(self.model.classes_)

        baseline_rate = sum(p * self.class_rates.get(cls, 0.0) for cls, p in zip(classes, proba))

        if wearable:
            modifier = self.daily_modifier_wearable(wearable)
            data_source = "wearable"
            factors = self.explain_wearable_factors(wearable)
        elif manual_log:
            modifier = self.daily_modifier_manual(
                manual_log["pain_today"], manual_log["sleep_quality"],
                manual_log["hydration_ok"], manual_log["mood"], manual_log["activity_level"],
            )
            data_source = "manual"
            factors = self.explain_manual_factors(
                manual_log["pain_today"], manual_log["sleep_quality"],
                manual_log["hydration_ok"], manual_log["mood"], manual_log["activity_level"],
            )
        else:
            modifier = 1.0
            data_source = "profile_only"
            factors = []

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

        explained = self._compose_explanation(risk_class, prob_30d, data_source, factors)

        return {
            "risk_class": risk_class,
            "class_proba": {cls: float(p) for cls, p in zip(classes, proba)},
            "baseline_annual_rate": float(baseline_rate),
            "daily_modifier": float(modifier),
            "voc_probability_30d": prob_30d,
            "data_source": data_source,
            "advice": advice,
            "explanation": explained["explanation"],
            "reasons": explained["reasons"],
            "tips": explained["tips"],
        }
