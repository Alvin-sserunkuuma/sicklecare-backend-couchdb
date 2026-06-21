FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# NOTE: model artifacts (models/*.joblib, *.json) must be generated via
# `python app/train.py --csv <dataset>` before starting, or mounted in.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
