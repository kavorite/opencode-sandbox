/*
 * ca_gen.c — generate a self-signed CA certificate + EC P-256 private key
 * Usage: ca-gen <output-directory>
 * Produces: <dir>/ca.pem and <dir>/ca.key
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecp.h"
#include "mbedtls/error.h"
#include "psa/crypto.h"

/* Platform entropy source — config defines MBEDTLS_ENTROPY_HARDWARE_ALT */
int mbedtls_hardware_poll(void *data, unsigned char *output, size_t len, size_t *olen)
{
    (void)data;
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f)
        return -1;
    *olen = fread(output, 1, len, f);
    fclose(f);
    return 0;
}

#define SUBJECT "CN=opencode-sandbox CA,O=opencode"
#define BUFSIZE 4096

static int write_file(const char *path, const unsigned char *buf, size_t len)
{
    FILE *f = fopen(path, "wb");
    if (!f)
        return -1;
    if (fwrite(buf, 1, len, f) != len) {
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}

static void validity(char *from, char *to, size_t sz)
{
    time_t now = time(NULL);
    struct tm t;
    gmtime_r(&now, &t);
    snprintf(from, sz, "%04d%02d%02d%02d%02d%02d",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
             t.tm_hour, t.tm_min, t.tm_sec);
    t.tm_year += 10;
    snprintf(to, sz, "%04d%02d%02d%02d%02d%02d",
             t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
             t.tm_hour, t.tm_min, t.tm_sec);
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: %s <output-directory>\n", argv[0]);
        return 1;
    }

    const char *dir = argv[1];
    struct stat st;
    if (stat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) {
        fprintf(stderr, "error: '%s' is not a directory\n", dir);
        return 1;
    }

    /* PSA crypto init — required before any mbedTLS crypto */
    psa_status_t psa = psa_crypto_init();
    if (psa != PSA_SUCCESS) {
        fprintf(stderr, "error: psa_crypto_init failed (%d)\n", (int)psa);
        return 1;
    }

    int ret = 1;
    mbedtls_pk_context key;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context drbg;
    mbedtls_x509write_cert crt;

    mbedtls_pk_init(&key);
    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&drbg);
    mbedtls_x509write_crt_init(&crt);

    char errbuf[256];

    /* seed DRBG */
    ret = mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy,
                                (const unsigned char *)"ca_gen", 6);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: drbg seed: %s\n", errbuf);
        goto cleanup;
    }

    /* generate EC P-256 key */
    ret = mbedtls_pk_setup(&key, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: pk setup: %s\n", errbuf);
        goto cleanup;
    }

    ret = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1,
                              mbedtls_pk_ec(key),
                              mbedtls_ctr_drbg_random, &drbg);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: keygen: %s\n", errbuf);
        goto cleanup;
    }

    /* configure certificate */
    mbedtls_x509write_crt_set_subject_key(&crt, &key);
    mbedtls_x509write_crt_set_issuer_key(&crt, &key);
    mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);

    ret = mbedtls_x509write_crt_set_subject_name(&crt, SUBJECT);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set subject: %s\n", errbuf);
        goto cleanup;
    }

    ret = mbedtls_x509write_crt_set_issuer_name(&crt, SUBJECT);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set issuer: %s\n", errbuf);
        goto cleanup;
    }

    /* serial */
    unsigned char serial[] = { 0x01 };
    ret = mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof(serial));
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set serial: %s\n", errbuf);
        goto cleanup;
    }

    /* validity: now to now+10y */
    char from[64], to[64];
    validity(from, to, sizeof(from));

    ret = mbedtls_x509write_crt_set_validity(&crt, from, to);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set validity: %s\n", errbuf);
        goto cleanup;
    }

    /* basic constraints: CA=TRUE, pathlen unlimited */
    ret = mbedtls_x509write_crt_set_basic_constraints(&crt, 1, -1);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set basic constraints: %s\n", errbuf);
        goto cleanup;
    }

    /* key usage: cert signing + CRL signing */
    ret = mbedtls_x509write_crt_set_key_usage(&crt,
            MBEDTLS_X509_KU_KEY_CERT_SIGN | MBEDTLS_X509_KU_CRL_SIGN);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set key usage: %s\n", errbuf);
        goto cleanup;
    }

    /* subject key identifier */
    ret = mbedtls_x509write_crt_set_subject_key_identifier(&crt);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set SKI: %s\n", errbuf);
        goto cleanup;
    }

    /* authority key identifier */
    ret = mbedtls_x509write_crt_set_authority_key_identifier(&crt);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: set AKI: %s\n", errbuf);
        goto cleanup;
    }

    /* write cert PEM */
    unsigned char buf[BUFSIZE];

    ret = mbedtls_x509write_crt_pem(&crt, buf, sizeof(buf),
                                    mbedtls_ctr_drbg_random, &drbg);
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: write cert pem: %s\n", errbuf);
        goto cleanup;
    }

    char path[1024];
    snprintf(path, sizeof(path), "%s/ca.pem", dir);
    if (write_file(path, buf, strlen((char *)buf))) {
        fprintf(stderr, "error: cannot write '%s'\n", path);
        ret = 1;
        goto cleanup;
    }

    /* write private key PEM */
    ret = mbedtls_pk_write_key_pem(&key, buf, sizeof(buf));
    if (ret) {
        mbedtls_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "error: write key pem: %s\n", errbuf);
        goto cleanup;
    }

    snprintf(path, sizeof(path), "%s/ca.key", dir);
    if (write_file(path, buf, strlen((char *)buf))) {
        fprintf(stderr, "error: cannot write '%s'\n", path);
        ret = 1;
        goto cleanup;
    }

    ret = 0;

cleanup:
    mbedtls_x509write_crt_free(&crt);
    mbedtls_pk_free(&key);
    mbedtls_ctr_drbg_free(&drbg);
    mbedtls_entropy_free(&entropy);
    mbedtls_psa_crypto_free();
    return ret;
}
