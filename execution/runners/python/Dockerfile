FROM python:3.11-slim

# Prevent Python from writing .pyc files, buffer stdout/stderr, and direct bytecode cache to /tmp
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp

# Create unprivileged sandbox user
RUN useradd -m -u 1000 sandbox

WORKDIR /app

# Copy runner script and enforce read-only permissions for root ownership
COPY runner.py /app/runner.py
RUN chown -R root:root /app && chmod -R 555 /app

# Execute as non-root user
USER sandbox

ENTRYPOINT ["python", "-u", "/app/runner.py"]

