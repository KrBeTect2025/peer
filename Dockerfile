FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY config.py .
COPY core ./core
COPY db ./db
COPY services ./services
COPY routers ./routers
COPY static ./static
RUN chmod -R a+rX /app && useradd --system --no-create-home app
USER app
EXPOSE 8000
# One worker only: rooms live in memory (services/rooms.py).
# PORT is set by hosts like Koyeb; --proxy-headers trusts their HTTPS proxy;
# the 20 s WebSocket pings keep a waiting sender's socket from being cut as idle.
CMD exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 \
    --proxy-headers --forwarded-allow-ips "*" \
    --ws-ping-interval 20 --ws-ping-timeout 20
