FROM python:3.11-slim
WORKDIR /app
COPY app.py styles.css ./
RUN mkdir -p /data && chown nobody:nogroup /data
USER nobody:nogroup
EXPOSE 8080
CMD ["python", "app.py"]
