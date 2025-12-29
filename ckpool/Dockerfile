FROM debian:bookworm-slim

LABEL maintainer="ckpool-solo-webui"
LABEL description="CKPool Solo Mining Pool"

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    yasm \
    libzmq3-dev \
    autoconf \
    automake \
    libtool \
    pkgconf \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy source code
COPY src/ /opt/ckpool/

WORKDIR /opt/ckpool

# Build ckpool
RUN ./autogen.sh && \
    ./configure && \
    make -j$(nproc)

# Create directories for runtime
RUN mkdir -p /var/log/ckpool /tmp/ckpool /etc/ckpool

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose stratum port
EXPOSE 3333

# Volume for socket communication with webui
VOLUME ["/tmp/ckpool"]

# Use entrypoint to generate config from env vars and start ckpool
ENTRYPOINT ["/docker-entrypoint.sh"]
