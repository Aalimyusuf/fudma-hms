# FUDMA Health Center: Hospital Management System

Node.js + Express + MySQL/MariaDB. Plain HTML/JS frontend served by the same app.

## Run locally
1. Start MySQL (XAMPP is fine). In phpMyAdmin create a database `fudma_health_center` and import `fudma_health_center.sql` (your dump).
2. `cp .env.example .env` and fill in DB details and passwords.
3. `npm install && npm start`, then open http://localhost:3000

On first start the app creates the extra tables (`users`, `duty_roster`), adds `test_time` to `lab_results`, and seeds logins:
- Admin: `admin` / ADMIN_PASSWORD
- Admin registers doctors, lab attendants and nurses, and sets doctor and nurse duty days.
- Lab staff: `lab` / LAB_PASSWORD
- Each existing doctor: their email / DOCTOR_DEFAULT_PASSWORD (e.g. `ibrahim@example.com`)
- Patients register themselves and get an ID like `HMS-2026-002`.

## Rules built in
Bookings up to 30 days ahead, 30-minute doctor slots inside the admin's duty hours, no double booking, lab capacity 50 tests/day, lab hours from the `laboratories` table.

## Putting it online
GitHub stores the code. GitHub Pages cannot run Node or MySQL, so deploy the repo to Render or Railway (connect the GitHub repo, build `npm install`, start `npm start`) with a hosted MySQL (Railway MySQL, Aiven free tier). Set the `.env` values as environment variables there; add `DB_SSL=1` if the database requires SSL.
Never commit `.env`.
