FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["bun", "run", "src/index.ts"]
