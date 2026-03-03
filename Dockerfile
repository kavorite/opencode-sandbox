FROM alpine:3.19
RUN apk add --no-cache bash git openssh-client curl coreutils ca-certificates
LABEL opencode-sandbox="true"
RUN adduser -D -h /home/sandbox sandbox
USER sandbox
WORKDIR /workspace
