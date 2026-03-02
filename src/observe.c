/*
 * oc-observe — seccomp USER_NOTIF supervisor
 *
 * Intercepts connect() and sendto() syscalls in a child process via
 * seccomp user notification, injects AF_UNIX socketpairs via ADDFD,
 * and emits JSON lines to stdout describing network activity.
 *
 * Usage: oc-observe [--proxy ca.pem ca.key] <command> [args...]
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <time.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>

/* ---- Kernel compat defines ---- */

#ifndef SECCOMP_FILTER_FLAG_NEW_LISTENER
#define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3)
#endif
#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif
#ifndef SECCOMP_RET_USER_NOTIF
#define SECCOMP_RET_USER_NOTIF 0x7fc00000U
#endif
#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif
#ifndef SECCOMP_ADDFD_FLAG_SETFD
#define SECCOMP_ADDFD_FLAG_SETFD (1UL << 0)
#endif
#ifndef SECCOMP_IOCTL_NOTIF_RECV
#define SECCOMP_IOCTL_NOTIF_RECV    _IOWR('!', 0, struct seccomp_notif)
#define SECCOMP_IOCTL_NOTIF_SEND    _IOWR('!', 1, struct seccomp_notif_resp)
#define SECCOMP_IOCTL_NOTIF_ID_VALID _IOW('!', 2, __u64)
#endif
#ifndef SECCOMP_IOCTL_NOTIF_ADDFD
struct seccomp_notif_addfd {
    __u64 id;
    __u32 flags;
    __u32 srcfd;
    __u32 newfd;
    __u32 newfd_flags;
};
#define SECCOMP_IOCTL_NOTIF_ADDFD   _IOW('!', 3, struct seccomp_notif_addfd)
#endif
#ifndef AUDIT_ARCH_X86_64
#define AUDIT_ARCH_X86_64 0xC000003EU
#endif
#ifndef __NR_connect
#define __NR_connect 42
#endif
#ifndef __NR_sendto
#define __NR_sendto 44
#endif
#ifndef __NR_socket
#define __NR_socket 41
#endif
#ifndef SYS_seccomp
#define SYS_seccomp __NR_seccomp
#endif
#ifndef SECCOMP_ADDFD_FLAG_SEND
#define SECCOMP_ADDFD_FLAG_SEND (1UL << 1)
#endif

/* ---- Tracked socketpairs from ADDFD connect interceptions ---- */

#define MAX_PAIRS 64

#ifdef OC_TLS_PROXY
#include "tls.h"
#include <sys/time.h>
/* struct pair is defined in tls.h */
#else
struct pair {
    int    fd;       /* supervisor end (sv[1]) */
    char   ip[INET6_ADDRSTRLEN];
    int    port;
    time_t deadline; /* absolute monotonic deadline */
};
#endif

static struct pair pairs[MAX_PAIRS];
static int npairs;

/* ---- Socket type tracking (from intercepted socket() calls) ---- */
#define MAX_SOCK_MAP 256
static struct { int fd; int type; } sock_map[MAX_SOCK_MAP];
static int nsock;

/* ---- Globals ---- */

static volatile sig_atomic_t got_sigchld;
#ifdef OC_TLS_PROXY
static int g_proxy;
#endif

static void on_signal(int sig) {
    if (sig == SIGCHLD) got_sigchld = 1;
}

/* ---- Base64 ---- */

static const char b64tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void b64(const unsigned char *in, size_t len, char *out) {
    size_t i, j = 0;
    for (i = 0; i + 2 < len; i += 3) {
        out[j++] = b64tab[(in[i] >> 2) & 0x3f];
        out[j++] = b64tab[((in[i] & 0x03) << 4) | ((in[i + 1] >> 4) & 0x0f)];
        out[j++] = b64tab[((in[i + 1] & 0x0f) << 2) | ((in[i + 2] >> 6) & 0x03)];
        out[j++] = b64tab[in[i + 2] & 0x3f];
    }
    if (i < len) {
        out[j++] = b64tab[(in[i] >> 2) & 0x3f];
        if (i + 1 < len) {
            out[j++] = b64tab[((in[i] & 0x03) << 4) | ((in[i + 1] >> 4) & 0x0f)];
            out[j++] = b64tab[((in[i + 1] & 0x0f) << 2)];
        } else {
            out[j++] = b64tab[(in[i] & 0x03) << 4];
            out[j++] = '=';
        }
        out[j++] = '=';
    }
    out[j] = '\0';
}

/* ---- Helpers ---- */

static ssize_t procmem(pid_t pid, unsigned long addr, void *buf, size_t len) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/mem", (int)pid);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = pread64(fd, buf, len, (off_t)addr);
    close(fd);
    return n;
}

static int is_loopback(const struct sockaddr_storage *ss) {
    if (ss->ss_family == AF_INET) {
        const struct sockaddr_in *s = (const struct sockaddr_in *)ss;
        return (ntohl(s->sin_addr.s_addr) >> 24) == 127;
    }
    if (ss->ss_family == AF_INET6) {
        const struct sockaddr_in6 *s = (const struct sockaddr_in6 *)ss;
        return memcmp(&s->sin6_addr, &in6addr_loopback,
                      sizeof(struct in6_addr)) == 0;
    }
    return 0;
}

static void reply(int lfd, __u64 id, long long val, int err, unsigned flags) {
    struct seccomp_notif_resp resp;
    memset(&resp, 0, sizeof(resp));
    resp.id    = id;
    resp.val   = val;
    resp.error = err;
    resp.flags = flags;
    ioctl(lfd, SECCOMP_IOCTL_NOTIF_SEND, &resp);
}

static time_t mono(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec;
}

/* Emit JSON for a tracked socketpair and close it */
static void emit_pair(int epfd, int idx) {
    unsigned char buf[4096];
    ssize_t nr = read(pairs[idx].fd, buf, sizeof(buf));
    if (nr < 0) nr = 0;

    char enc[((4096 + 2) / 3) * 4 + 1];
    enc[0] = '\0';
    if (nr > 0) b64(buf, (size_t)nr, enc);

    printf("{\"type\":\"connect\",\"addr\":\"%s\",\"port\":%d,\"data\":\"%s\"}\n",
           pairs[idx].ip, pairs[idx].port, enc);
    fflush(stdout);

    epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[idx].fd, NULL);
    close(pairs[idx].fd);
    pairs[idx] = pairs[--npairs];
}

/* ---- socket() handler: create socket in supervisor, inject via ADDFD ---- */

static int sock_type_lookup(int fd) {
    for (int i = 0; i < nsock; i++)
        if (sock_map[i].fd == fd) return sock_map[i].type;
    return -1;
}

static void handle_socket(int lfd, struct seccomp_notif *n) {
    int domain   = (int)n->data.args[0];
    int type     = (int)n->data.args[1];
    int protocol = (int)n->data.args[2];

    /* Create the socket in the supervisor's process */
    int real_fd = socket(domain, type, protocol);
    if (real_fd < 0) {
        reply(lfd, n->id, -1, -errno, 0);
        return;
    }

    struct seccomp_notif_addfd addfd;
    memset(&addfd, 0, sizeof(addfd));
    addfd.id    = n->id;
    addfd.flags = SECCOMP_ADDFD_FLAG_SEND; /* atomically install + reply */
    addfd.srcfd = (unsigned)real_fd;

    int child_fd = ioctl(lfd, SECCOMP_IOCTL_NOTIF_ADDFD, &addfd);
    close(real_fd);

    if (child_fd < 0) {
        /* ADDFD+SEND failed — fall back to letting kernel handle it */
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    /* Track the fd → type mapping (update if fd already exists) */
    int masked = type & 0xF; /* mask out SOCK_NONBLOCK etc */
    int found = 0;
    for (int i = 0; i < nsock; i++) {
        if (sock_map[i].fd != child_fd) continue;
        sock_map[i].type = masked;
        found = 1;
        break;
    }
    if (!found && nsock < MAX_SOCK_MAP) {
        sock_map[nsock].fd   = child_fd;
        sock_map[nsock].type = masked;
        nsock++;
    }
}

/* ---- connect() handler ---- */

static void handle_connect(int lfd, int epfd, struct seccomp_notif *n) {
    int sock = (int)n->data.args[0];

    struct sockaddr_storage ss;
    memset(&ss, 0, sizeof(ss));
    if (procmem(n->pid, n->data.args[1], &ss, sizeof(ss))
        < (ssize_t)sizeof(sa_family_t)) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    if (ss.ss_family != AF_INET && ss.ss_family != AF_INET6) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }
    if (is_loopback(&ss)) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    char ip[INET6_ADDRSTRLEN] = "";
    int port = 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)&ss;
        inet_ntop(AF_INET, &s->sin_addr, ip, sizeof(ip));
        port = ntohs(s->sin_port);
    } else {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)&ss;
        inet_ntop(AF_INET6, &s->sin6_addr, ip, sizeof(ip));
        port = ntohs(s->sin6_port);
    }

    /* Only intercept TCP (SOCK_STREAM) connects — skip UDP.
     * Socket types tracked via intercepted socket() calls. */
    int stype = sock_type_lookup(sock);
    if (stype != -1 && stype != SOCK_STREAM) {
        if (port == 53)
            printf("{\"type\":\"dns_connect\",\"addr\":\"%s\",\"port\":53}\n", ip);
        fflush(stdout);
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    /* SSH: observe via /proc/pid/cmdline, don't intercept */
    if (port == 22) {
        char cl[4096], cmd[64] = "", repo[512] = "";
        snprintf(cl, sizeof(cl), "/proc/%d/cmdline", (int)n->pid);
        int cfd = open(cl, O_RDONLY);
        if (cfd >= 0) {
            ssize_t nr = read(cfd, cl, sizeof(cl) - 1);
            close(cfd);
            if (nr > 0) {
                cl[nr] = '\0';
                for (int off = 0; off < nr; ) {
                    char *arg = &cl[off];
                    size_t alen = strlen(arg);
                    char *rp = strstr(arg, "git-receive-pack");
                    char *up = strstr(arg, "git-upload-pack");
                    if (rp || up) {
                        snprintf(cmd, sizeof(cmd), "%s",
                                 rp ? "git-receive-pack" : "git-upload-pack");
                        char *q = strchr(arg, '\'');
                        if (q) {
                            q++;
                            char *end = strchr(q, '\'');
                            if (end) {
                                size_t rlen = (size_t)(end - q);
                                if (rlen < sizeof(repo)) {
                                    memcpy(repo, q, rlen);
                                    repo[rlen] = '\0';
                                }
                            }
                        }
                        break;
                    }
                    off += (int)alen + 1;
                }
            }
        }
        printf("{\"type\":\"ssh\",\"addr\":\"%s\",\"port\":%d,\"cmd\":\"%s\",\"repo\":\"%s\"}\n",
               ip, port, cmd, repo);
        fflush(stdout);
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    if (ioctl(lfd, SECCOMP_IOCTL_NOTIF_ID_VALID, &n->id) < 0) {
        close(sv[0]);
        close(sv[1]);
        return;
    }

    struct seccomp_notif_addfd addfd;
    memset(&addfd, 0, sizeof(addfd));
    addfd.id    = n->id;
    addfd.flags = SECCOMP_ADDFD_FLAG_SETFD;
    addfd.srcfd = (unsigned)sv[0];
    addfd.newfd = (unsigned)sock;

    if (ioctl(lfd, SECCOMP_IOCTL_NOTIF_ADDFD, &addfd) < 0) {
        close(sv[0]);
        close(sv[1]);
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    close(sv[0]);

    /* Tell child connect() "succeeded" — skip real syscall */
    reply(lfd, n->id, 0, 0, 0);

    /* Track sv[1] in epoll for async data capture */
    if (npairs < MAX_PAIRS) {
        fcntl(sv[1], F_SETFL, O_NONBLOCK);
        struct epoll_event ev = { .events = EPOLLIN | EPOLLHUP, .data.fd = sv[1] };
        epoll_ctl(epfd, EPOLL_CTL_ADD, sv[1], &ev);

        struct pair *p = &pairs[npairs++];
        p->fd = sv[1];
        memcpy(p->ip, ip, sizeof(p->ip));
        p->port = port;
        p->deadline = mono() + 5;
#ifdef OC_TLS_PROXY
        p->phase = PHASE_OBSERVE;
        if (g_proxy && port == 443) {
            if (tls_init_pair(p) != 0) {
                emit_pair(epfd, npairs - 1);
            } else {
                struct epoll_event tev = { .events = EPOLLIN, .data.fd = sv[1] };
                epoll_ctl(epfd, EPOLL_CTL_MOD, sv[1], &tev);
            }
        }
#endif
    } else {
        /* Too many active pairs — emit immediately with no data */
        printf("{\"type\":\"connect\",\"addr\":\"%s\",\"port\":%d,\"data\":\"\"}\n",
               ip, port);
        fflush(stdout);
        close(sv[1]);
    }
}

/* ---- sendto() handler ---- */

static void handle_sendto(int lfd, struct seccomp_notif *n) {
    unsigned long addr_ptr = n->data.args[4];

    if (addr_ptr == 0) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    struct sockaddr_storage ss;
    memset(&ss, 0, sizeof(ss));
    if (procmem(n->pid, addr_ptr, &ss, sizeof(ss))
        < (ssize_t)sizeof(sa_family_t)) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    char ip[INET6_ADDRSTRLEN] = "";
    int port = 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)&ss;
        port = ntohs(s->sin_port);
        inet_ntop(AF_INET, &s->sin_addr, ip, sizeof(ip));
    } else if (ss.ss_family == AF_INET6) {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)&ss;
        port = ntohs(s->sin6_port);
        inet_ntop(AF_INET6, &s->sin6_addr, ip, sizeof(ip));
    } else {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    if (port != 53) {
        reply(lfd, n->id, 0, 0, SECCOMP_USER_NOTIF_FLAG_CONTINUE);
        return;
    }

    size_t len = n->data.args[2];
    if (len > 512) len = 512;
    unsigned char buf[512];
    ssize_t nr = procmem(n->pid, n->data.args[1], buf, len);
    if (nr < 0) nr = 0;

    if (ioctl(lfd, SECCOMP_IOCTL_NOTIF_ID_VALID, &n->id) < 0)
        return;

#ifdef OC_TLS_PROXY
    if (g_proxy) {
        char enc[((512 + 2) / 3) * 4 + 1];
        enc[0] = '\0';
        if (nr > 0) b64(buf, (size_t)nr, enc);

        int udp = socket(ss.ss_family == AF_INET6 ? AF_INET6 : AF_INET, SOCK_DGRAM, 0);
        if (udp >= 0) {
            struct timeval tv = { .tv_sec = 2, .tv_usec = 0 };
            setsockopt(udp, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
            unsigned char resp[512];
            ssize_t rlen = -1;
            if (sendto(udp, buf, (size_t)nr, 0, (struct sockaddr *)&ss,
                       ss.ss_family == AF_INET6 ? sizeof(struct sockaddr_in6) : sizeof(struct sockaddr_in)) > 0) {
                rlen = recv(udp, resp, sizeof(resp), 0);
            }
            close(udp);

            int dsv[2];
            if (rlen > 0 && socketpair(AF_UNIX, SOCK_DGRAM, 0, dsv) == 0) {
                struct seccomp_notif_addfd daddfd;
                memset(&daddfd, 0, sizeof(daddfd));
                daddfd.id = n->id;
                daddfd.flags = SECCOMP_ADDFD_FLAG_SETFD;
                daddfd.srcfd = (unsigned)dsv[0];
                daddfd.newfd = (unsigned)n->data.args[0];
                if (ioctl(lfd, SECCOMP_IOCTL_NOTIF_ADDFD, &daddfd) == 0) {
                    (void)write(dsv[1], resp, (size_t)rlen);
                    reply(lfd, n->id, (long long)nr, 0, 0);
                } else {
                    reply(lfd, n->id, -1, -ENETUNREACH, 0);
                }
                close(dsv[0]);
                close(dsv[1]);
            } else {
                reply(lfd, n->id, -1, -ENETUNREACH, 0);
            }
        } else {
            reply(lfd, n->id, -1, -ENETUNREACH, 0);
        }
        printf("{\"type\":\"dns\",\"addr\":\"%s\",\"port\":53,\"data\":\"%s\"}\n", ip, enc);
        fflush(stdout);
        return;
    }
#endif
    /* Non-proxy: block DNS */
    reply(lfd, n->id, -1, -ENETUNREACH, 0);

    char enc[((512 + 2) / 3) * 4 + 1];
    enc[0] = '\0';
    if (nr > 0) b64(buf, (size_t)nr, enc);

    printf("{\"type\":\"dns\",\"addr\":\"%s\",\"port\":53,\"data\":\"%s\"}\n",
           ip, enc);
    fflush(stdout);
}

/* ---- Entry point ---- */

int main(int argc, char **argv) {
    int proxy = 0;
    char *ca_cert = NULL, *ca_key = NULL;
    int cmd_start = 1;
    if (argc > 3 && strcmp(argv[1], "--proxy") == 0) {
        proxy = 1;
        ca_cert = argv[2];
        ca_key = argv[3];
        cmd_start = 4;
    }
#ifdef OC_TLS_PROXY
    g_proxy = proxy;
#else
    (void)proxy;
    (void)ca_cert;
    (void)ca_key;
#endif

    if (argc < cmd_start + 1) {
        fprintf(stderr, "usage: oc-observe [--proxy ca.pem ca.key] <command> [args...]\n");
        return 1;
    }

    int pass[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pass) < 0) {
        perror("socketpair");
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 1;
    }

    if (child == 0) {
        /* ---- Child: install seccomp, send listener fd, exec ---- */
        close(pass[0]);

        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
            perror("prctl");
            _exit(1);
        }

        struct sock_filter filt[] = {
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                     offsetof(struct seccomp_data, arch)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
            BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                     offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
            BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 1),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
            BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        };
        struct sock_fprog prog = {
            .len    = (unsigned short)(sizeof(filt) / sizeof(filt[0])),
            .filter = filt,
        };

        int listener = (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                                    SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
        if (listener < 0) {
            perror("seccomp");
            _exit(1);
        }

        char dummy = 'x';
        struct iovec iov = { .iov_base = &dummy, .iov_len = 1 };
        char cbuf[CMSG_SPACE(sizeof(int))];
        struct msghdr hdr;
        memset(&hdr, 0, sizeof(hdr));
        hdr.msg_iov        = &iov;
        hdr.msg_iovlen     = 1;
        hdr.msg_control    = cbuf;
        hdr.msg_controllen = sizeof(cbuf);

        struct cmsghdr *cm = CMSG_FIRSTHDR(&hdr);
        cm->cmsg_level = SOL_SOCKET;
        cm->cmsg_type  = SCM_RIGHTS;
        cm->cmsg_len   = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(cm), &listener, sizeof(int));

        if (sendmsg(pass[1], &hdr, 0) < 0) {
            perror("sendmsg");
            _exit(1);
        }

        close(pass[1]);
        close(listener);
        execv(argv[cmd_start], &argv[cmd_start]);
        perror("execv");
        _exit(127);
    }

    /* ---- Parent: receive listener fd, enter notification loop ---- */
    close(pass[1]);

    char dummy;
    struct iovec iov = { .iov_base = &dummy, .iov_len = 1 };
    char cbuf[CMSG_SPACE(sizeof(int))];
    struct msghdr hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.msg_iov        = &iov;
    hdr.msg_iovlen     = 1;
    hdr.msg_control    = cbuf;
    hdr.msg_controllen = sizeof(cbuf);

    if (recvmsg(pass[0], &hdr, 0) < 0) {
        perror("recvmsg");
        waitpid(child, NULL, 0);
        return 1;
    }
    close(pass[0]);

    int listener = -1;
    struct cmsghdr *cm = CMSG_FIRSTHDR(&hdr);
    if (cm && cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS)
        memcpy(&listener, CMSG_DATA(cm), sizeof(int));

    if (listener < 0) {
        fprintf(stderr, "oc-observe: failed to receive listener fd\n");
        waitpid(child, NULL, 0);
        return 1;
    }

#ifdef OC_TLS_PROXY
    if (proxy) {
        if (tls_init(ca_cert, ca_key) != 0) {
            fprintf(stderr, "oc-observe: tls_init failed\n");
            waitpid(child, NULL, 0);
            return 1;
        }
    }
#endif

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGCHLD, &sa, NULL);

    fcntl(listener, F_SETFL, O_NONBLOCK);

    int epfd = epoll_create1(0);
    if (epfd < 0) {
        perror("epoll_create1");
        close(listener);
        waitpid(child, NULL, 0);
        return 1;
    }
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listener };
    epoll_ctl(epfd, EPOLL_CTL_ADD, listener, &ev);

    /* Main event loop: handles both seccomp notifications and socketpair data */
    struct epoll_event events[8];

    for (;;) {
        /* Compute timeout: min of 1s and earliest pair deadline */
        int timeout_ms = 1000;
        time_t now = mono();
        for (int i = 0; i < npairs; i++) {
            int remain = (int)(pairs[i].deadline - now) * 1000;
            if (remain < 0) remain = 0;
            if (remain < timeout_ms) timeout_ms = remain;
        }

        int nev = epoll_wait(epfd, events, 8, timeout_ms);
        if (nev < 0) {
            if (errno == EINTR) {
                int wst;
                if (got_sigchld && waitpid(child, &wst, WNOHANG) > 0)
                    goto done;
                continue;
            }
            break;
        }

        /* Process events */
        for (int i = 0; i < nev; i++) {
            int fd = events[i].data.fd;

            if (fd == listener) {
                /* Seccomp notification ready */
                struct seccomp_notif notif;
                memset(&notif, 0, sizeof(notif));

                if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &notif) < 0) {
                    if (errno == ENOENT) {
                        int wst;
                        if (waitpid(child, &wst, WNOHANG) > 0)
                            goto done;
                    }
                    continue;
                }

                if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID,
                          &notif.id) < 0)
                    continue;

                if (notif.data.nr == __NR_connect)
                    handle_connect(listener, epfd, &notif);
                else if (notif.data.nr == __NR_sendto)
                    handle_sendto(listener, &notif);
                else if (notif.data.nr == __NR_socket)
                    handle_socket(listener, &notif);
                else
                    reply(listener, notif.id, 0, 0,
                          SECCOMP_USER_NOTIF_FLAG_CONTINUE);
            } else {
                /* Data ready on a tracked socketpair */
                for (int j = 0; j < npairs; j++) {
                    if (pairs[j].fd != fd) continue;
#ifdef OC_TLS_PROXY
                    if (g_proxy && pairs[j].phase != PHASE_OBSERVE) {
                        int r = -1;
                        if (pairs[j].phase == PHASE_TLS_HANDSHAKE_SERVER) {
                            r = tls_handshake_step(&pairs[j], epfd);
                            if (pairs[j].phase == PHASE_TLS_HANDSHAKE_CLIENT &&
                                pairs[j].target_fd >= 0) {
                                struct epoll_event tev = {
                                    .events = EPOLLIN | EPOLLOUT,
                                    .data.fd = pairs[j].target_fd
                                };
                                epoll_ctl(epfd, EPOLL_CTL_ADD, pairs[j].target_fd, &tev);
                            } else if (r == 2) {
                                struct epoll_event tev = { .events = EPOLLIN | EPOLLOUT, .data.fd = pairs[j].fd };
                                epoll_ctl(epfd, EPOLL_CTL_MOD, pairs[j].fd, &tev);
                            } else if (r == 1) {
                                struct epoll_event tev = { .events = EPOLLIN, .data.fd = pairs[j].fd };
                                epoll_ctl(epfd, EPOLL_CTL_MOD, pairs[j].fd, &tev);
                            }
                        } else if (pairs[j].phase == PHASE_TLS_HANDSHAKE_CLIENT) {
                            /* Client handshake driven only from target_fd events */
                            r = 0;
                        } else if (pairs[j].phase == PHASE_HTTP_INSPECT) {
                            r = tls_http_parse(&pairs[j]);
                            if (pairs[j].phase == PHASE_BLOCKED) {
                                tls_emit_json(&pairs[j]);
                                tls_cleanup_pair(&pairs[j]);
                                epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[j].fd, NULL);
                                close(pairs[j].fd);
                                pairs[j] = pairs[--npairs];
                                r = 0; /* already handled */
                            }
                        } else if (pairs[j].phase == PHASE_PROXYING) {
                            r = tls_proxy_step(&pairs[j]);
                            if (pairs[j].phase == PHASE_BLOCKED) {
                                tls_cleanup_pair(&pairs[j]);
                                epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[j].fd, NULL);
                                close(pairs[j].fd);
                                pairs[j] = pairs[--npairs];
                                r = 0; /* already handled */
                            }
                        }
                        if (r < 0) {
                            tls_cleanup_pair(&pairs[j]);
                            epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[j].fd, NULL);
                            close(pairs[j].fd);
                            pairs[j] = pairs[--npairs];
                        }
                        break;
                    }
#endif
                    emit_pair(epfd, j);
                    break;
                }
#ifdef OC_TLS_PROXY
                /* Also check if this fd is a target_fd for any TLS pair */
                if (g_proxy) {
                    for (int j = 0; j < npairs; j++) {
                        if (pairs[j].target_fd != fd) continue;
                        if (pairs[j].phase == PHASE_TLS_HANDSHAKE_CLIENT) {
                            int r = tls_handshake_step(&pairs[j], epfd);
                            if (r < 0) {
                                tls_cleanup_pair(&pairs[j]);
                                epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[j].fd, NULL);
                                close(pairs[j].fd);
                                pairs[j] = pairs[--npairs];
                            }
                        } else if (pairs[j].phase == PHASE_PROXYING) {
                            tls_proxy_step(&pairs[j]);
                        }
                        break;
                    }
                }
#endif
            }
        }

        /* Expire timed-out pairs */
        now = mono();
        for (int i = npairs - 1; i >= 0; i--) {
            if (now < pairs[i].deadline) continue;
#ifdef OC_TLS_PROXY
            if (g_proxy && pairs[i].phase != PHASE_OBSERVE) {
                tls_emit_json(&pairs[i]);
                tls_cleanup_pair(&pairs[i]);
                epoll_ctl(epfd, EPOLL_CTL_DEL, pairs[i].fd, NULL);
                close(pairs[i].fd);
                pairs[i] = pairs[--npairs];
                continue;
            }
#endif
            emit_pair(epfd, i);
        }

        /* Check child exit on timeout (nev == 0) */
        if (nev == 0) {
            int wst;
            if (waitpid(child, &wst, WNOHANG) > 0)
                break;
        }
    }

done:
    /* Flush remaining pairs */
#ifdef OC_TLS_PROXY
    if (g_proxy) {
        for (int i = npairs - 1; i >= 0; i--) {
            if (pairs[i].phase != PHASE_OBSERVE)
                tls_cleanup_pair(&pairs[i]);
            else
                emit_pair(epfd, i);
        }
        tls_cleanup();
    } else {
        for (int i = npairs - 1; i >= 0; i--)
            emit_pair(epfd, i);
    }
#else
    for (int i = npairs - 1; i >= 0; i--)
        emit_pair(epfd, i);
#endif

    close(epfd);
    close(listener);

    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
