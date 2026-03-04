FROM archlinux:base
# Only install what cannot come from the host /usr bind-mount:
# strace (needs a file capability set on the binary) and libcap (provides setcap).
# Everything else — git, curl, gh, rg, docker CLI, ripgrep, etc. — is mounted
# read-only from the host at /host/usr so the container always has the same tools
# and glibc version as the host without ad-hoc installs.
RUN pacman -Sy --noconfirm --needed strace libcap \
    && pacman -Scc --noconfirm
# Give strace the ptrace file capability so unprivileged users can use it.
# no-new-privileges is NOT set on the container so this file cap takes effect on exec.
RUN setcap cap_sys_ptrace+eip /usr/bin/strace
LABEL opencode-sandbox="true"
RUN useradd -m -d /home/sandbox sandbox
USER sandbox
WORKDIR /workspace
