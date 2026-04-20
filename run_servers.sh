#!/bin/bash
set -e

# Start PostgreSQL
pg_ctlcluster 16 main start || true

# Wait until postgres is ready
for i in {1..60}; do
  if pg_isready -U postgres > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "PostgreSQL is ready"

# Install and start backend (Express)
cd /app/backend
npm install
node server.js &

# Install and start frontend (Vite + React)
cd /app/frontend
npm install
npm run dev &
