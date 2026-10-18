FROM gcc:13-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 sandbox && useradd -u 1000 -g sandbox -M sandbox
WORKDIR /app
COPY compiled_runner.py /app/runner.py
RUN chmod -R 555 /app && mkdir /work && chown sandbox:sandbox /work
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER sandbox
ENTRYPOINT ["python3", "-u", "/app/runner.py", "cpp"]
