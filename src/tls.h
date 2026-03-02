/*
 * tls.h — TLS MITM proxy types and function declarations for oc-observe
 */
#ifndef OC_TLS_H
#define OC_TLS_H

#ifdef OC_TLS_PROXY

#include <time.h>
#include <netinet/in.h>
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"

/* Connection phases for TLS proxy connections */
enum pair_phase {
    PHASE_OBSERVE = 0,              /* non-TLS observe mode (port 80, etc.) */
    PHASE_TLS_HANDSHAKE_SERVER = 1, /* doing TLS handshake with sandboxed child */
    PHASE_TLS_HANDSHAKE_CLIENT = 2, /* doing TLS handshake with real target */
    PHASE_HTTP_INSPECT = 3,         /* reading decrypted HTTP request */
    PHASE_PROXYING = 4,             /* bidirectional TLS proxy active */
    PHASE_BLOCKED = 5,              /* connection blocked (non-HTTP TLS or disallowed method) */
};

/* BIO context wrapping a file descriptor */
struct fd_ctx {
    int fd;
};

/*
 * Extended connection tracking struct.
 * In non-TLS mode (PHASE_OBSERVE), only fd/ip/port/deadline are used.
 */
struct pair {
    /* Base fields (same as Phase 2) */
    int    fd;                         /* supervisor end of AF_UNIX socketpair (sv[1]) */
    char   ip[INET6_ADDRSTRLEN];       /* target IP address */
    int    port;                       /* target port */
    time_t deadline;                   /* absolute monotonic deadline */

    /* TLS proxy fields (only used when port == 443 in proxy mode) */
    int    phase;                      /* enum pair_phase */
    int    target_fd;                  /* outbound socket to real target server */

    /* mbedTLS contexts — server side (with sandboxed child) */
    mbedtls_ssl_context  ssl_server;
    mbedtls_ssl_config   conf_server;
    struct fd_ctx        bio_server;

    /* mbedTLS contexts — client side (with real target) */
    mbedtls_ssl_context  ssl_client;
    mbedtls_ssl_config   conf_client;
    struct fd_ctx        bio_client;

    /* Per-connection forged certificate (leaf + CA chain) */
    mbedtls_x509_crt     chain;        /* linked list: chain -> ca_crt */
    mbedtls_pk_context   leaf_key;

    /* Parsed HTTP request fields */
    char  sni[256];                    /* SNI hostname from TLS ClientHello */
    char  http_method[16];             /* "GET", "POST", "NON-HTTP", etc. */
    char  http_path[512];              /* request path */
    char  http_host[256];              /* Host header value */
    int   forwarded;                   /* 1 if proxied through, 0 if blocked */
};

/* ---- Function prototypes ---- */

/*
 * tls_init: initialize global TLS state (entropy, DRBG, shared configs,
 * load CA cert+key from files). Call once in parent after fork.
 * Returns 0 on success, -1 on error.
 */
int tls_init(const char *ca_cert_path, const char *ca_key_path);

/*
 * tls_cleanup: free global TLS state. Call at program exit.
 */
void tls_cleanup(void);

/*
 * tls_init_pair: initialize TLS state for a new connection.
 * Sets up server SSL context with BIO on pair->fd (sv[1]).
 * Returns 0 on success, -1 on error.
 */
int tls_init_pair(struct pair *p);

/*
 * tls_handshake_step: drive non-blocking TLS handshake.
 * Returns:
 *   0  — handshake complete, phase advanced
 *   1  — WANT_READ (wait for EPOLLIN on p->fd or p->target_fd)
 *   2  — WANT_WRITE (wait for EPOLLOUT)
 *  -1  — fatal error, pair should be cleaned up
 */
int tls_handshake_step(struct pair *p, int epfd);

/*
 * tls_http_parse: read and parse HTTP method from decrypted stream.
 * Returns:
 *   0  — parsed, phase set to PROXYING or BLOCKED based on allow list
 *   1  — WANT_READ
 *  -1  — error
 */
int tls_http_parse(struct pair *p);

/*
 * tls_proxy_step: bidirectional data relay between ssl_server and ssl_client.
 * Returns:
 *   0  — connection still active
 *   1  — WANT_READ/WANT_WRITE
 *  -1  — connection closed or error (emit JSON, cleanup)
 */
int tls_proxy_step(struct pair *p);

/*
 * tls_emit_json: write JSON observation line to stdout.
 */
void tls_emit_json(const struct pair *p);

/*
 * tls_cleanup_pair: free per-connection TLS resources and close target_fd.
 */
void tls_cleanup_pair(struct pair *p);

/* BIO callbacks */
int fd_send(void *ctx, const unsigned char *buf, size_t len);
int fd_recv(void *ctx, unsigned char *buf, size_t len);

#else  /* !OC_TLS_PROXY */

/* Minimal struct pair for non-TLS build */
struct pair {
    int    fd;
    char   ip[INET6_ADDRSTRLEN];
    int    port;
    time_t deadline;
};

#endif /* OC_TLS_PROXY */

#endif /* OC_TLS_H */
