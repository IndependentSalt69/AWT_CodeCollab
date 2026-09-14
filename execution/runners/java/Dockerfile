FROM openjdk:17-jdk-slim
WORKDIR /app
COPY . /app
RUN javac runner.java 2>/dev/null || true
CMD ["java", "Runner"]
