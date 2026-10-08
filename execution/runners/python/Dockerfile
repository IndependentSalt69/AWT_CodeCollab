FROM python:3.11-slim

# Prevent Python from writing .pyc files and buffer stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Create unprivileged sandbox user
RUN useradd -m -u 1000 sandbox

WORKDIR /app

# Copy runner script and set ownership
COPY runner.py /app/runner.py
RUN chown -R sandbox:sandbox /app

# Execute as non-root user
USER sandbox

ENTRYPOINT ["python", "-u", "/app/runner.py"]
