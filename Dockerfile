# Dockerfile for Fly.io deployment
# Replaces the previous AWS Lambda adapter version — Fly.io doesn't need it.

FROM denoland/deno:2.0.2

WORKDIR /app

# Copy everything
COPY . .

# Pre-cache all dependencies so the first request isn't slow
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", "-A", "main.ts"]
