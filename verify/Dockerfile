FROM node:22-alpine
WORKDIR /app
COPY web/static/ ./web/
COPY verify/tests/ ./tests/
COPY verify/run.sh ./run.sh
RUN chmod +x ./run.sh
CMD ["./run.sh"]
