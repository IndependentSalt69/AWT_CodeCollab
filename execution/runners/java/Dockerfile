FROM eclipse-temurin:17-jdk-jammy
RUN sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list && apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 sandbox && useradd -u 1000 -g sandbox -M sandbox
WORKDIR /app
COPY compiled_runner.py /app/runner.py
RUN chmod -R 555 /app && mkdir /work && chown sandbox:sandbox /work
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER sandbox
ENTRYPOINT ["python3", "-u", "/app/runner.py", "java"]
