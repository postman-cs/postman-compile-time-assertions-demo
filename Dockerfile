FROM python:3.12-slim

WORKDIR /app

COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./

EXPOSE 8080

# flask run is fine for a concept demo; no production WSGI server needed.
CMD ["flask", "--app", "app", "run", "--host=0.0.0.0", "--port=8080"]
