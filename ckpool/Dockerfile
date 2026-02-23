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
# Pass CFLAGS explicitly to prevent configure.ac from using -march=native
# -march=native in QEMU emulation would use QEMU's CPU features, not the target device's
# configure.ac then appends -march=armv8-a for aarch64, giving a universally compatible binary
RUN chmod +x autogen.sh && \
    ./autogen.sh && \
    CFLAGS="-O2 -Wall" ./configure && \
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
