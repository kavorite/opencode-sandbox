FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git openssh-client curl ca-certificates strace libcap2-bin coreutils \
      gnupg lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*
# Give strace the ptrace file capability so unprivileged users can use it.
# no-new-privileges is NOT set on the container so this file cap takes effect on exec.
RUN setcap cap_sys_ptrace+eip /usr/bin/strace
LABEL opencode-sandbox="true"
RUN useradd -m -d /home/sandbox sandbox
USER sandbox
WORKDIR /workspace
