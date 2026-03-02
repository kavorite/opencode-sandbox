/*
 * tls.c — TLS MITM proxy engine for oc-observe
 */

#ifdef OC_TLS_PROXY

/* Enable SNI support in mbedTLS headers (required for cert callback + SNI) */
#ifndef MBEDTLS_SSL_SERVER_NAME_INDICATION
#define MBEDTLS_SSL_SERVER_NAME_INDICATION
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "tls.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/x509.h"
#include "mbedtls/pk.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecp.h"
#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h"
#include "psa/crypto.h"

/* ---- globals ---- */

static mbedtls_entropy_context g_entropy;
static mbedtls_ctr_drbg_context g_drbg;
static mbedtls_ssl_config g_srv_conf;
static mbedtls_ssl_config g_cli_conf;
static mbedtls_x509_crt g_ca_crt;
static mbedtls_pk_context g_ca_key;
static mbedtls_x509_crt g_sys_ca;

#define MAX_METHODS 32
static char g_methods[MAX_METHODS][16];
static int g_nmethod;

/* ---- forward declarations ---- */

static int cert_callback(mbedtls_ssl_context *ssl);
static int tls_forge_cert(struct pair *p);

/* ---- file reading helper (no MBEDTLS_FS_IO) ---- */

static unsigned char *read_file(const char *path, size_t *out)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    if (sz <= 0) {
        fclose(f);
        return NULL;
    }
    fseek(f, 0, SEEK_SET);
    unsigned char *buf = malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (rd == 0) {
        free(buf);
        return NULL;
    }
    buf[rd] = '\0';
    *out = rd;
    return buf;
}

/* ---- BIO callbacks ---- */

int fd_recv(void *ctx, unsigned char *buf, size_t len)
{
    struct fd_ctx *c = ctx;
    ssize_t n = read(c->fd, buf, len);
    if (n > 0)
        return (int)n;
    if (n == 0) {
        return MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        return MBEDTLS_ERR_SSL_WANT_READ;
    return MBEDTLS_ERR_NET_CONN_RESET;
}

int fd_send(void *ctx, const unsigned char *buf, size_t len)
{
    struct fd_ctx *c = ctx;
    ssize_t n = write(c->fd, buf, len);
    if (n >= 0)
        return (int)n;
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        return MBEDTLS_ERR_SSL_WANT_WRITE;
    return MBEDTLS_ERR_NET_CONN_RESET;
}

/* ---- allow list parsing ---- */

static void parse_methods(void)
{
    g_nmethod = 0;
    const char *env = getenv("OC_ALLOW_METHODS");
    if (!env || !*env)
        return;

    char tmp[512];
    snprintf(tmp, sizeof(tmp), "%s", env);
    char *tok = strtok(tmp, ",");
    while (tok && g_nmethod < MAX_METHODS) {
        while (*tok == ' ') tok++;
        size_t l = strlen(tok);
        while (l > 0 && tok[l - 1] == ' ') l--;
        if (l > 0 && l < sizeof(g_methods[0])) {
            memcpy(g_methods[g_nmethod], tok, l);
            g_methods[g_nmethod][l] = '\0';
            g_nmethod++;
        }
        tok = strtok(NULL, ",");
    }
}

static int allowed(const char *method)
{
    if (g_nmethod == 0)
        return 1;
    for (int i = 0; i < g_nmethod; i++) {
        if (strcmp(g_methods[i], method) == 0)
            return 1;
    }
    return 0;
}

/* ---- global init / cleanup ---- */

int tls_init(const char *ca_cert_path, const char *ca_key_path)
{
    psa_status_t psa = psa_crypto_init();
    if (psa != PSA_SUCCESS)
        goto cleanup;

    mbedtls_entropy_init(&g_entropy);
    mbedtls_ctr_drbg_init(&g_drbg);
    mbedtls_ssl_config_init(&g_srv_conf);
    mbedtls_ssl_config_init(&g_cli_conf);
    mbedtls_x509_crt_init(&g_ca_crt);
    mbedtls_pk_init(&g_ca_key);
    mbedtls_x509_crt_init(&g_sys_ca);

    int ret = mbedtls_ctr_drbg_seed(&g_drbg, mbedtls_entropy_func, &g_entropy,
                                    (const unsigned char *)"oc_tls", 6);
    if (ret)
        goto cleanup;

    /* load CA cert from file */
    size_t csz = 0;
    unsigned char *cbuf = read_file(ca_cert_path, &csz);
    if (!cbuf)
        goto cleanup;
    ret = mbedtls_x509_crt_parse(&g_ca_crt, cbuf, csz + 1);
    free(cbuf);
    if (ret)
        goto cleanup;

    /* load CA key from file */
    size_t ksz = 0;
    unsigned char *kbuf = read_file(ca_key_path, &ksz);
    if (!kbuf)
        goto cleanup;
    ret = mbedtls_pk_parse_key(&g_ca_key, kbuf, ksz + 1, NULL, 0,
                               mbedtls_ctr_drbg_random, &g_drbg);
    free(kbuf);
    if (ret)
        goto cleanup;

    /* server config: TLS 1.2 only, no client auth */
    ret = mbedtls_ssl_config_defaults(&g_srv_conf, MBEDTLS_SSL_IS_SERVER,
                                      MBEDTLS_SSL_TRANSPORT_STREAM,
                                      MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret)
        goto cleanup;
    mbedtls_ssl_conf_rng(&g_srv_conf, mbedtls_ctr_drbg_random, &g_drbg);
    mbedtls_ssl_conf_authmode(&g_srv_conf, MBEDTLS_SSL_VERIFY_NONE);
    mbedtls_ssl_conf_max_tls_version(&g_srv_conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_min_tls_version(&g_srv_conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_cert_cb(&g_srv_conf, cert_callback);

    /* client config: verify required, load system CAs */
    ret = mbedtls_ssl_config_defaults(&g_cli_conf, MBEDTLS_SSL_IS_CLIENT,
                                      MBEDTLS_SSL_TRANSPORT_STREAM,
                                      MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret)
        goto cleanup;
    mbedtls_ssl_conf_max_tls_version(&g_cli_conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_min_tls_version(&g_cli_conf, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_rng(&g_cli_conf, mbedtls_ctr_drbg_random, &g_drbg);
    mbedtls_ssl_conf_authmode(&g_cli_conf, MBEDTLS_SSL_VERIFY_REQUIRED);

    /* load system CA chain */
    static const char *ca_paths[] = {
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/cert.pem",
        NULL,
    };
    for (const char **pp = ca_paths; *pp; pp++) {
        size_t sz = 0;
        unsigned char *buf = read_file(*pp, &sz);
        if (!buf)
            continue;
        if (mbedtls_x509_crt_parse(&g_sys_ca, buf, sz + 1) == 0) {
            free(buf);
            break;
        }
        free(buf);
    }
    mbedtls_ssl_conf_ca_chain(&g_cli_conf, &g_sys_ca, NULL);
    if (g_sys_ca.raw.len == 0)
        fprintf(stderr, "oc-observe: warning: no system CA bundle found; outbound TLS verification will fail\n");

    parse_methods();
    return 0;
cleanup:
    tls_cleanup();
    return -1;
}

void tls_cleanup(void)
{
    mbedtls_ssl_config_free(&g_srv_conf);
    mbedtls_ssl_config_free(&g_cli_conf);
    mbedtls_x509_crt_free(&g_ca_crt);
    mbedtls_pk_free(&g_ca_key);
    mbedtls_x509_crt_free(&g_sys_ca);
    mbedtls_ctr_drbg_free(&g_drbg);
    mbedtls_entropy_free(&g_entropy);
    mbedtls_psa_crypto_free();
}

/* ---- certificate forge ---- */

static int tls_forge_cert(struct pair *p)
{
    int ret;
    mbedtls_x509write_cert crt;
    mbedtls_x509write_crt_init(&crt);

    /* generate leaf EC P-256 key */
    mbedtls_pk_init(&p->leaf_key);
    ret = mbedtls_pk_setup(&p->leaf_key,
                           mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    if (ret)
        goto fail;
    ret = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1,
                              mbedtls_pk_ec(p->leaf_key),
                              mbedtls_ctr_drbg_random, &g_drbg);
    if (ret)
        goto fail;

    /* subject CN=<sni> */
    char subj[300];
    snprintf(subj, sizeof(subj), "CN=%s", p->sni);

    mbedtls_x509write_crt_set_subject_key(&crt, &p->leaf_key);
    mbedtls_x509write_crt_set_issuer_key(&crt, &g_ca_key);
    mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
    mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);

    ret = mbedtls_x509write_crt_set_subject_name(&crt, subj);
    if (ret)
        goto fail;

    /* issuer from CA */
    char issuer[512];
    ret = mbedtls_x509_dn_gets(issuer, sizeof(issuer), &g_ca_crt.subject);
    if (ret < 0)
        goto fail;
    ret = mbedtls_x509write_crt_set_issuer_name(&crt, issuer);
    if (ret)
        goto fail;

    /* serial: timestamp-based, strip leading zeros (ASN.1 rule) */
    time_t now = time(NULL);
    unsigned char raw[8];
    for (int i = 7; i >= 0; i--) {
        raw[i] = (unsigned char)(now & 0xFF);
        now >>= 8;
    }
    int skip = 0;
    while (skip < 7 && raw[skip] == 0) skip++;
    ret = mbedtls_x509write_crt_set_serial_raw(&crt, raw + skip, (size_t)(8 - skip));
    if (ret)
        goto fail;

    /* validity: now to now+24h */
    time_t t = time(NULL);
    struct tm tm;
    char from[32], to[32];
    gmtime_r(&t, &tm);
    snprintf(from, sizeof(from), "%04d%02d%02d%02d%02d%02d",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec);
    t += 86400;
    gmtime_r(&t, &tm);
    snprintf(to, sizeof(to), "%04d%02d%02d%02d%02d%02d",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec);
    ret = mbedtls_x509write_crt_set_validity(&crt, from, to);
    if (ret)
        goto fail;

    /* basic constraints: not CA */
    ret = mbedtls_x509write_crt_set_basic_constraints(&crt, 0, -1);
    if (ret)
        goto fail;

    /* key usage: digital signature + key encipherment */
    ret = mbedtls_x509write_crt_set_key_usage(&crt,
            MBEDTLS_X509_KU_DIGITAL_SIGNATURE | MBEDTLS_X509_KU_KEY_ENCIPHERMENT);
    if (ret)
        goto fail;

    /* SAN: DNS name = sni */
    mbedtls_x509_san_list san;
    memset(&san, 0, sizeof(san));
    san.node.type = MBEDTLS_X509_SAN_DNS_NAME;
    san.node.san.unstructured_name.tag = MBEDTLS_ASN1_IA5_STRING;
    san.node.san.unstructured_name.len = strlen(p->sni);
    san.node.san.unstructured_name.p = (unsigned char *)p->sni;
    san.next = NULL;
    ret = mbedtls_x509write_crt_set_subject_alternative_name(&crt, &san);
    if (ret)
        goto fail;

    /* write DER, then parse into chain */
    unsigned char buf[4096];
    ret = mbedtls_x509write_crt_der(&crt, buf, sizeof(buf),
                                    mbedtls_ctr_drbg_random, &g_drbg);
    if (ret < 0)
        goto fail;

    /* DER written at tail of buf */
    mbedtls_x509_crt_init(&p->chain);
    int pret = mbedtls_x509_crt_parse_der(&p->chain,
                                          buf + sizeof(buf) - ret,
                                          (size_t)ret);
    if (pret) {
        ret = pret;
        goto fail;
    }

    /* chain: leaf -> CA */
    p->chain.next = &g_ca_crt;

    mbedtls_x509write_crt_free(&crt);
    return 0;

fail:
    mbedtls_x509write_crt_free(&crt);
    return -1;
}

/* ---- cert callback (server handshake) ---- */

static int cert_callback(mbedtls_ssl_context *ssl)
{
    size_t len = 0;
    const unsigned char *name = mbedtls_ssl_get_hs_sni(ssl, &len);
    struct pair *p = mbedtls_ssl_get_user_data_p(ssl);

    if (!name || len == 0) {
        p->phase = PHASE_BLOCKED;
        return MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE;
    }

    size_t clen = len < sizeof(p->sni) - 1 ? len : sizeof(p->sni) - 1;
    memcpy(p->sni, name, clen);
    p->sni[clen] = '\0';

    if (tls_forge_cert(p) != 0) {
        p->phase = PHASE_BLOCKED;
        return MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE;
    }

    return mbedtls_ssl_set_hs_own_cert(ssl, &p->chain, &p->leaf_key);
}

/* ---- per-connection init ---- */

int tls_init_pair(struct pair *p)
{
    mbedtls_ssl_init(&p->ssl_server);
    int ret = mbedtls_ssl_setup(&p->ssl_server, &g_srv_conf);
    if (ret)
        return -1;

    mbedtls_ssl_set_user_data_p(&p->ssl_server, p);

    p->bio_server.fd = p->fd;
    mbedtls_ssl_set_bio(&p->ssl_server, &p->bio_server, fd_send, fd_recv, NULL);

    p->target_fd = -1;
    p->phase = PHASE_TLS_HANDSHAKE_SERVER;
    p->forwarded = 0;
    p->sni[0] = '\0';
    p->http_method[0] = '\0';
    p->http_path[0] = '\0';
    p->http_host[0] = '\0';

    return 0;
}

/* ---- outbound socket creation ---- */

static int connect_target(struct pair *p)
{
    int fd;
    struct sockaddr_in addr4;
    struct sockaddr_in6 addr6;
    struct sockaddr *sa;
    socklen_t slen;

    if (strchr(p->ip, ':')) {
        fd = socket(AF_INET6, SOCK_STREAM, 0);
        if (fd < 0)
            return -1;
        memset(&addr6, 0, sizeof(addr6));
        addr6.sin6_family = AF_INET6;
        addr6.sin6_port = htons((uint16_t)p->port);
        if (inet_pton(AF_INET6, p->ip, &addr6.sin6_addr) <= 0) { close(fd); return -1; }
        sa = (struct sockaddr *)&addr6;
        slen = sizeof(addr6);
    } else {
        fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0)
            return -1;
        memset(&addr4, 0, sizeof(addr4));
        addr4.sin_family = AF_INET;
        addr4.sin_port = htons((uint16_t)p->port);
        if (inet_pton(AF_INET, p->ip, &addr4.sin_addr) <= 0) { close(fd); return -1; }
        sa = (struct sockaddr *)&addr4;
        slen = sizeof(addr4);
    }

    if (connect(fd, sa, slen) != 0) {
        close(fd);
        return -1;
    }

    /* set non-blocking */
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0)
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    return fd;
}

/* ---- TLS handshake step ---- */

int tls_handshake_step(struct pair *p, int epfd)
{
    (void)epfd;
    int ret;

    if (p->phase == PHASE_TLS_HANDSHAKE_SERVER) {
        ret = mbedtls_ssl_handshake(&p->ssl_server);
        if (ret == MBEDTLS_ERR_SSL_WANT_READ)
            return 1;
        if (ret == MBEDTLS_ERR_SSL_WANT_WRITE)
            return 2;
        if (ret != 0)
            return -1;

        /* server handshake done — connect to real target */
        p->target_fd = connect_target(p);
        if (p->target_fd < 0)
            return -1;

        /* init client SSL */
        mbedtls_ssl_init(&p->ssl_client);
        ret = mbedtls_ssl_setup(&p->ssl_client, &g_cli_conf);
        if (ret)
            return -1;

        /* CVE-2025-27809: set hostname for cert verification */
        ret = mbedtls_ssl_set_hostname(&p->ssl_client, p->sni);
        if (ret)
            return -1;

        p->bio_client.fd = p->target_fd;
        mbedtls_ssl_set_bio(&p->ssl_client, &p->bio_client,
                            fd_send, fd_recv, NULL);

        p->phase = PHASE_TLS_HANDSHAKE_CLIENT;
        /* fall through to start client handshake immediately */
    }

    if (p->phase == PHASE_TLS_HANDSHAKE_CLIENT) {
        ret = mbedtls_ssl_handshake(&p->ssl_client);
        if (ret == MBEDTLS_ERR_SSL_WANT_READ)
            return 1;
        if (ret == MBEDTLS_ERR_SSL_WANT_WRITE)
            return 2;
        if (ret != 0)
            return -1;

        p->phase = PHASE_HTTP_INSPECT;
        return 0;
    }

    return -1;
}

/* ---- HTTP method parser ---- */

int tls_http_parse(struct pair *p)
{
    unsigned char buf[4096];
    int n = mbedtls_ssl_read(&p->ssl_server, buf, sizeof(buf));
    if (n == MBEDTLS_ERR_SSL_WANT_READ)
        return 1;
    if (n <= 0) {
        p->phase = PHASE_BLOCKED;
        return -1;
    }

    /* check for non-HTTP: first bytes should be ASCII method + space */
    int space = -1;
    for (int i = 0; i < n && i < 16; i++) {
        if (buf[i] == ' ') {
            space = i;
            break;
        }
        if (buf[i] < 0x20 || buf[i] > 0x7E) {
            snprintf(p->http_method, sizeof(p->http_method), "NON-HTTP");
            p->http_path[0] = '\0';
            p->http_host[0] = '\0';
            p->forwarded = 0;
            p->phase = PHASE_BLOCKED;
            return 0;
        }
    }
    if (space <= 0 || space > 15) {
        snprintf(p->http_method, sizeof(p->http_method), "NON-HTTP");
        p->http_path[0] = '\0';
        p->http_host[0] = '\0';
        p->forwarded = 0;
        p->phase = PHASE_BLOCKED;
        return 0;
    }

    /* extract method */
    int mlen = space < (int)sizeof(p->http_method) - 1
               ? space : (int)sizeof(p->http_method) - 1;
    memcpy(p->http_method, buf, (size_t)mlen);
    p->http_method[mlen] = '\0';

    /* extract path: from space+1 to next space */
    int pstart = space + 1;
    int pend = pstart;
    while (pend < n && buf[pend] != ' ' && buf[pend] != '\r' && buf[pend] != '\n')
        pend++;
    int plen = pend - pstart;
    if (plen > (int)sizeof(p->http_path) - 1)
        plen = (int)sizeof(p->http_path) - 1;
    memcpy(p->http_path, buf + pstart, (size_t)plen);
    p->http_path[plen] = '\0';

    /* extract Host header */
    p->http_host[0] = '\0';
    for (int i = 0; i < n - 5; i++) {
        if (buf[i] != '\n')
            continue;
        if (strncasecmp((char *)buf + i + 1, "Host:", 5) != 0)
            continue;
        int hs = i + 6;
        while (hs < n && buf[hs] == ' ') hs++;
        int he = hs;
        while (he < n && buf[he] != '\r' && buf[he] != '\n') he++;
        int hl = he - hs;
        if (hl > (int)sizeof(p->http_host) - 1)
            hl = (int)sizeof(p->http_host) - 1;
        memcpy(p->http_host, buf + hs, (size_t)hl);
        p->http_host[hl] = '\0';
        break;
    }

    /* check allow list */
    if (!allowed(p->http_method)) {
        static const char resp[] =
            "HTTP/1.1 403 Forbidden\r\n"
            "Content-Length: 0\r\n"
            "Connection: close\r\n\r\n";
        mbedtls_ssl_write(&p->ssl_server,
                          (const unsigned char *)resp, sizeof(resp) - 1);
        p->forwarded = 0;
        p->phase = PHASE_BLOCKED;
        return 0;
    }

    /* forward decrypted request to real target */
    int w = mbedtls_ssl_write(&p->ssl_client, buf, (size_t)n);
    if (w < 0) {
        p->forwarded = 0;
        p->phase = PHASE_BLOCKED;
        return 0;
    }

    p->forwarded = 1;
    p->phase = PHASE_PROXYING;
    return 0;
}

/* ---- bidirectional proxy ---- */

int tls_proxy_step(struct pair *p)
{
    unsigned char buf[16384];
    int ret;

    /* child -> target */
    ret = mbedtls_ssl_read(&p->ssl_server, buf, sizeof(buf));
    if (ret > 0) {
        int sent = 0;
        while (sent < ret) {
            int w = mbedtls_ssl_write(&p->ssl_client, buf + sent, (size_t)(ret - sent));
            if (w == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
            if (w < 0) { tls_emit_json(p); p->phase = PHASE_BLOCKED; return -1; }
            sent += w;
        }
    } else if (ret != MBEDTLS_ERR_SSL_WANT_READ) {
        tls_emit_json(p); p->phase = PHASE_BLOCKED; return -1;
    }

    /* target -> child */
    ret = mbedtls_ssl_read(&p->ssl_client, buf, sizeof(buf));
    if (ret > 0) {
        int sent = 0;
        while (sent < ret) {
            int w = mbedtls_ssl_write(&p->ssl_server, buf + sent, (size_t)(ret - sent));
            if (w == MBEDTLS_ERR_SSL_WANT_WRITE) continue;
            if (w < 0) { tls_emit_json(p); p->phase = PHASE_BLOCKED; return -1; }
            sent += w;
        }
        return 0;
    } else if (ret == MBEDTLS_ERR_SSL_WANT_READ) {
        return 1;  /* both sides would block */
    }
    tls_emit_json(p); p->phase = PHASE_BLOCKED; return -1;
}

/* ---- JSON output ---- */

static void json_escape(const char *s, char *out, size_t sz)
{
    static const char hex[] = "0123456789abcdef";
    size_t j = 0;
    for (size_t i = 0; s[i] && j < sz - 2; i++) {
        if (s[i] == '"' || s[i] == '\\') {
            out[j++] = '\\'; out[j++] = s[i];
        } else if ((unsigned char)s[i] < 0x20) {
            if (j + 6 >= sz) break;
            out[j++] = '\\'; out[j++] = 'u'; out[j++] = '0'; out[j++] = '0';
            out[j++] = hex[(s[i] >> 4) & 0xf]; out[j++] = hex[s[i] & 0xf];
        } else {
            out[j++] = s[i];
        }
    }
    out[j] = '\0';
}

void tls_emit_json(const struct pair *p)
{
    char method[32], path[1024], host[512], addr[INET6_ADDRSTRLEN + 4];
    json_escape(p->http_method, method, sizeof(method));
    json_escape(p->http_path, path, sizeof(path));

    /* host: prefer Host header, fall back to sni */
    if (p->http_host[0])
        json_escape(p->http_host, host, sizeof(host));
    else
        json_escape(p->sni, host, sizeof(host));

    json_escape(p->ip, addr, sizeof(addr));

    printf("{\"type\":\"http\","
           "\"method\":\"%s\","
           "\"path\":\"%s\","
           "\"host\":\"%s\","
           "\"addr\":\"%s\","
           "\"port\":%d,"
           "\"forwarded\":%s}\n",
           method, path, host, addr, p->port,
           p->forwarded ? "true" : "false");
    fflush(stdout);
}

/* ---- per-connection cleanup ---- */

void tls_cleanup_pair(struct pair *p)
{
    mbedtls_ssl_close_notify(&p->ssl_server);
    mbedtls_ssl_free(&p->ssl_server);

    if (p->target_fd >= 0) {
        mbedtls_ssl_close_notify(&p->ssl_client);
        mbedtls_ssl_free(&p->ssl_client);
        close(p->target_fd);
        p->target_fd = -1;
    }

    /* unlink from global CA before freeing to avoid double-free */
    if (p->chain.next == &g_ca_crt)
        p->chain.next = NULL;
    mbedtls_x509_crt_free(&p->chain);
    mbedtls_pk_free(&p->leaf_key);
}

#endif /* OC_TLS_PROXY */
