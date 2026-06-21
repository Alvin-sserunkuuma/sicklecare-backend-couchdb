#!/bin/bash
set -uo pipefail
BASE="http://localhost:4001/api"
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS+1))
    echo "PASS: $desc (got $actual)"
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc (expected $expected, got $actual)"
  fi
}

echo "== health =="
code=$(curl -s -o /tmp/out.json -w "%{http_code}" "$BASE/health")
check "GET /health" 200 "$code"

echo "== register =="
EMAIL="patient_couch_$(date +%s)@example.com"
code=$(curl -s -o /tmp/reg.json -w "%{http_code}" -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"genotype\":\"HbSS\",\"display_name\":\"Couch Patient\"}")
check "POST /auth/register" 201 "$code"
cat /tmp/reg.json
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/reg.json','utf8')).token)")

echo "== duplicate register =="
code=$(curl -s -o /tmp/dup.json -w "%{http_code}" -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}")
check "POST /auth/register duplicate -> 409" 409 "$code"

echo "== login =="
code=$(curl -s -o /tmp/login.json -w "%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}")
check "POST /auth/login" 200 "$code"

echo "== auth/me =="
code=$(curl -s -o /tmp/me.json -w "%{http_code}" "$BASE/auth/me" -H "Authorization: Bearer $TOKEN")
check "GET /auth/me" 200 "$code"

echo "== auth 401 (no token) =="
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/patients/me")
check "GET /patients/me no auth -> 401" 401 "$code"

echo "== get patient profile =="
code=$(curl -s -o /tmp/patient.json -w "%{http_code}" "$BASE/patients/me" -H "Authorization: Bearer $TOKEN")
check "GET /patients/me" 200 "$code"
cat /tmp/patient.json

echo "== update patient profile (high risk) =="
code=$(curl -s -o /tmp/patient2.json -w "%{http_code}" -X PATCH "$BASE/patients/me" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"age":34,"sex":"female","on_hydroxyurea":false,"stroke_occurred":true,"splenic_sequestration_history":true,"acs_episodes_per_year":2,"penicillin_prophylaxis":false,"has_regular_pain_medications":true,"chronic_transfusions":true,"malaria_episodes_per_year":3}')
check "PATCH /patients/me" 200 "$code"
cat /tmp/patient2.json
node -e "
const p = JSON.parse(require('fs').readFileSync('/tmp/patient2.json','utf8'));
console.log('complication_score', p.complication_score, 'treatment_intensity', p.treatment_intensity);
if (p.complication_score !== 3) process.exit(1);
if (p.treatment_intensity !== 2) process.exit(1);
"
check "engineered features recomputed" 0 "$?"

echo "== create symptom log (manual, today) =="
code=$(curl -s -o /tmp/log1.json -w "%{http_code}" -X POST "$BASE/symptoms" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"pain_score":7,"fatigue_score":6,"water_intake_litres":1.2,"sleep_hours":5,"sleep_quality":0,"hydration_ok":false,"mood":0,"activity_level":0,"infection_present":false}')
check "POST /symptoms" 201 "$code"
cat /tmp/log1.json
LOG_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/log1.json','utf8')).id)")
echo "LOG_ID=$LOG_ID"

echo "== upsert same day (idempotent) =="
code=$(curl -s -o /tmp/log1b.json -w "%{http_code}" -X POST "$BASE/symptoms" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"pain_score":8}')
check "POST /symptoms upsert" 201 "$code"
node -e "
const a = JSON.parse(require('fs').readFileSync('/tmp/log1.json','utf8'));
const b = JSON.parse(require('fs').readFileSync('/tmp/log1b.json','utf8'));
if (a.id !== b.id) process.exit(1);
if (b.pain_score !== 8) process.exit(1);
"
check "upsert kept same _id and updated pain_score" 0 "$?"

echo "== list symptoms =="
code=$(curl -s -o /tmp/logs.json -w "%{http_code}" "$BASE/symptoms" -H "Authorization: Bearer $TOKEN")
check "GET /symptoms" 200 "$code"
cat /tmp/logs.json

echo "== get one symptom log =="
code=$(curl -s -o /tmp/log_one.json -w "%{http_code}" "$BASE/symptoms/$(node -e "console.log(encodeURIComponent('$LOG_ID'))")" -H "Authorization: Bearer $TOKEN")
check "GET /symptoms/:id" 200 "$code"

echo "== patch symptom log =="
code=$(curl -s -o /tmp/log_patch.json -w "%{http_code}" -X PATCH "$BASE/symptoms/$(node -e "console.log(encodeURIComponent('$LOG_ID'))")" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"pain_score":9}')
check "PATCH /symptoms/:id" 200 "$code"

echo "== predictions (manual_log derived from today's log) =="
code=$(curl -s -o /tmp/pred1.json -w "%{http_code}" -X POST "$BASE/predictions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
echo "predictions status=$code"
cat /tmp/pred1.json
if [ "$code" = "201" ]; then
  PASS=$((PASS+1)); echo "PASS: POST /predictions -> 201"
elif [ "$code" = "503" ]; then
  PASS=$((PASS+1)); echo "PASS (expected, ML service not running): POST /predictions -> 503"
else
  FAIL=$((FAIL+1)); echo "FAIL: POST /predictions -> $code"
fi

echo "== predictions history =="
code=$(curl -s -o /tmp/predlist.json -w "%{http_code}" "$BASE/predictions" -H "Authorization: Bearer $TOKEN")
check "GET /predictions" 200 "$code"
cat /tmp/predlist.json

echo "== wearable status (not connected) =="
code=$(curl -s -o /tmp/wstatus0.json -w "%{http_code}" "$BASE/wearable/status" -H "Authorization: Bearer $TOKEN")
check "GET /wearable/status" 200 "$code"
cat /tmp/wstatus0.json

echo "== wearable sync (not connected -> 400) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/wearable/sync" -H "Authorization: Bearer $TOKEN")
check "POST /wearable/sync no connection -> 400" 400 "$code"

echo "== wearable connect =="
code=$(curl -s -o /tmp/wconnect.json -w "%{http_code}" -X POST "$BASE/wearable/connect" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"access_token":"fake-token","refresh_token":"fake-refresh","expires_in":3600,"provider":"google_fit"}')
check "POST /wearable/connect" 201 "$code"
cat /tmp/wconnect.json

echo "== wearable status (connected) =="
code=$(curl -s -o /tmp/wstatus1.json -w "%{http_code}" "$BASE/wearable/status" -H "Authorization: Bearer $TOKEN")
check "GET /wearable/status" 200 "$code"
cat /tmp/wstatus1.json

echo "== wearable sync (fake token -> 502) =="
code=$(curl -s -o /tmp/wsync.json -w "%{http_code}" -X POST "$BASE/wearable/sync" -H "Authorization: Bearer $TOKEN")
check "POST /wearable/sync fake token -> 502" 502 "$code"
cat /tmp/wsync.json

echo "== wearable disconnect =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/wearable/disconnect" -H "Authorization: Bearer $TOKEN")
check "DELETE /wearable/disconnect" 204 "$code"

echo "== batch sync =="
code=$(curl -s -o /tmp/sync1.json -w "%{http_code}" -X POST "$BASE/sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"records":[
    {"table_name":"symptom_logs","record_id":"local-1","payload":{"log_date":"2026-06-09","source":"manual","pain_score":3,"sleep_quality":1,"hydration_ok":true,"mood":1,"activity_level":1},"client_updated_at":"2026-06-09T12:00:00Z"},
    {"table_name":"patients","record_id":"local-profile","payload":{"on_hydroxyurea":true,"age":29},"client_updated_at":"2026-06-10T12:00:00Z"},
    {"table_name":"symptom_logs","record_id":"local-bad","payload":{"log_date":"2026-06-08"},"client_updated_at":"2026-06-08T12:00:00Z"}
  ]}')
check "POST /sync -> 207" 207 "$code"
cat /tmp/sync1.json

echo "== verify patient update applied via sync =="
code=$(curl -s -o /tmp/patient3.json -w "%{http_code}" "$BASE/patients/me" -H "Authorization: Bearer $TOKEN")
check "GET /patients/me after sync" 200 "$code"
node -e "
const p = JSON.parse(require('fs').readFileSync('/tmp/patient3.json','utf8'));
if (p.on_hydroxyurea !== true) process.exit(1);
if (p.age !== 29) process.exit(1);
if (p.treatment_intensity !== 3) process.exit(1);
"
check "sync applied patients update + recomputed treatment_intensity" 0 "$?"

echo "== sync status =="
code=$(curl -s -o /tmp/syncstatus.json -w "%{http_code}" "$BASE/sync/status" -H "Authorization: Bearer $TOKEN")
check "GET /sync/status" 200 "$code"
cat /tmp/syncstatus.json
node -e "
const s = JSON.parse(require('fs').readFileSync('/tmp/syncstatus.json','utf8'));
if (s.applied < 2) process.exit(1);
"
check "sync status counts >= 2 applied" 0 "$?"

echo "== sync changes feed =="
code=$(curl -s -o /tmp/changes.json -w "%{http_code}" "$BASE/sync/changes" -H "Authorization: Bearer $TOKEN")
check "GET /sync/changes" 200 "$code"
cat /tmp/changes.json

echo "== validation: bad sync table_name -> 400 =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/sync" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"records":[{"table_name":"not_a_table","record_id":"x","payload":{},"client_updated_at":"2026-06-10T12:00:00Z"}]}')
check "POST /sync bad table_name -> 400" 400 "$code"

echo "== delete symptom log =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/symptoms/$(node -e "console.log(encodeURIComponent('$LOG_ID'))")" -H "Authorization: Bearer $TOKEN")
check "DELETE /symptoms/:id" 204 "$code"

echo
echo "===== RESULTS: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
