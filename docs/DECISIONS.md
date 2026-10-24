# Decisions log

Short record of confirmed decisions. Add a line whenever a decision changes.

| Date | Decision |
|---|---|
| 2026-10-24 | Modular monolith: FastAPI + PostgreSQL. No microservices at prototype stage. |
| 2026-10-24 | Cloudflare R2 is the first object-storage candidate (S3-compatible). Confirmed by owner. |
| 2026-10-24 | PayChangu is the first payment-gateway candidate, behind a provider interface. Sandbox only until the pre-payment gate in the blueprint is cleared. Confirmed by owner. |
| 2026-10-24 | Games target Godot 4.7.2 for now. The MAREC Game SDK is NOT built first; it comes at milestone M6, after the launcher prototype. |
| 2026-10-24 | A Windows PC is available (at least occasionally) for launcher testing. |
| 2026-10-24 | Launcher framework: Tauri 2 with Electron as fallback, decided after a one-week spike (milestone M5). |
