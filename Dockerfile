# MyFlix: standard-library Python only, so the image is tiny and has nothing to keep patched.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 MYFLIX_HOST=0.0.0.0
RUN useradd --system --uid 10001 --create-home myflix
WORKDIR /app
COPY server.py local_auth.py netmon.py sso_guard.py ./
COPY static ./static
RUN mkdir -p /app/data && chown myflix:myflix /app/data
USER myflix
VOLUME /app/data
EXPOSE 8108
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD python -c "import os,urllib.request as u; u.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('MYFLIX_PORT','8108'), timeout=3)"
CMD ["python", "server.py"]
