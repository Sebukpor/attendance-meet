FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=7860
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies (including build tools for insightface)
# Note: Each line except the last must end with \ and NO trailing spaces/comments
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Optional: Remove build tools after installation to reduce image size
# RUN apt-get purge -y --auto-remove build-essential && rm -rf /var/lib/apt/lists/*

# Copy application code
COPY main.py .

EXPOSE 7860
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]