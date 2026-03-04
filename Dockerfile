FROM alpine:3.19
RUN apk add --no-cache bash git openssh-client curl coreutils ca-certificates strace libcap
# Give strace the ptrace file capability so unprivileged users can use it.
# no-new-privileges is NOT set on the container so this file cap takes effect on exec.
RUN setcap cap_sys_ptrace+eip /usr/bin/strace
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash 2>/dev/null
LABEL opencode-sandbox="true"
RUN adduser -D -h /home/sandbox sandbox
USER sandbox
WORKDIR /workspace
