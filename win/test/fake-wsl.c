/* fake-wsl.c — wsl.exe (and ubuntu.exe) for win/launcher-test.sh under wine. Every call is appended to
 * C:\wsl-calls.txt (arguments joined by " | "). What it answers comes from C:\fake\scenario.ini [wsl]:
 *   default = ok | root | other | none     the default distribution (ok: Ubuntu, user alice uid 1000; root: uid 0)
 *   ubuntu  = ok | none | installed | registered    "-d Ubuntu": there / not / after --install / after ubuntu.exe
 *   install_rc = N         wsl --install's exit code        status_rc = N   wsl --status
 *   setup = real | fail    --setup runs the real wsl-bootstrap.sh as root, or fails
 *   join  = a fake-join.sh mode    prep / wait = seconds before the code shows / it stays up
 *   probe_ms = how long each probe takes
 * State between calls: C:\fake\state.ini [state] installed=1 registered=1.
 * "-e bash SCRIPT ..." runs the REAL script as a Unix process (wine starts those; their exit code comes back
 * through a file), with HOME=/tmp/wslhome/<user> and win/test/fake-join.sh as join.sh. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SCEN "C:\\fake\\scenario.ini"
#define STATE "C:\\fake\\state.ini"
typedef char *(CDECL *unix_name_fn)(const WCHAR *);

static void scen(const char *key, const char *def, char *out, int n) { GetPrivateProfileStringA("wsl", key, def, out, n, SCEN); }
static int scen_int(const char *key, int def) { return GetPrivateProfileIntA("wsl", key, def, SCEN); }
static int state_int(const char *key) { return GetPrivateProfileIntA("state", key, 0, STATE); }
static void state_set(const char *key) { WritePrivateProfileStringA("state", key, "1", STATE); }

static void log_call(int argc, char **argv) {
    FILE *f = fopen("C:\\wsl-calls.txt", "a");
    if (!f) return;
    const char *base = strrchr(argv[0], '\\');
    base = base ? base + 1 : argv[0];
    if (!_stricmp(base, "ubuntu.exe")) fprintf(f, "ubuntu.exe | ");
    for (int i = 1; i < argc; i++) fprintf(f, "%s%s", argv[i], i + 1 < argc ? " | " : "");
    fprintf(f, "\n");
    fclose(f);
}

static void to_unix(const char *win, char *out, int n) { /* C:\x -> /tmp/wp/drive_c/x (wine's own mapping) */
    WCHAR w[MAX_PATH];
    unix_name_fn f = (unix_name_fn)GetProcAddress(GetModuleHandleA("kernel32"), "wine_get_unix_file_name");
    MultiByteToWideChar(CP_ACP, 0, win, -1, w, MAX_PATH);
    char *u = f ? f(w) : NULL;
    snprintf(out, n, "%s", u ? u : win);
}

static char g_cwd[MAX_PATH] = "/";   /* wsl.exe --cd DIR: where the Unix process starts */

static void squote(FILE *f, const char *s) { /* 'a'\''b' */
    fputc('\'', f);
    for (; *s; s++) { if (*s == '\'') fputs("'\\''", f); else fputc(*s, f); }
    fputc('\'', f);
}

/* run "bash ARGS..." as a Unix process with ENV lines; its output to our stdout; its exit code */
static int run_unix(const char *home, int argc, char **argv, int from, int with_join_env) {
    char join[64], tag[64], path[MAX_PATH], buf[4096];
    unsigned long id = GetCurrentProcessId() * 1000UL + (GetTickCount() % 1000);
    CreateDirectoryA("Z:\\tmp\\fakewsl", NULL);
    snprintf(tag, sizeof tag, "job-%lu", id);
    snprintf(path, sizeof path, "Z:\\tmp\\fakewsl\\%s.sh", tag);
    FILE *f = fopen(path, "wb");
    if (!f) return 126;
    fprintf(f, "#!/bin/sh\nmkdir -p '%s'\nexport HOME='%s' VERALDAR_PROBE_SECS=1\n", home, home);
    if (with_join_env) {
        int wait = scen_int("wait", 3), prep = scen_int("prep", 0);
        scen("join", "ok", join, sizeof join);
        fprintf(f, "export FAKE_JOIN_MODE='%s' FAKE_WAIT=%d FAKE_PREP=%d FAKE_ROOTJOIN=/repo/root/install/rootjoin.py "
                   "VERALDAR_JOIN_SH=/repo/win/test/fake-join.sh FAKE_BRAIN_PORT=4180\n", join, wait, prep);
    }
    fprintf(f, "cd ");
    squote(f, g_cwd);
    fprintf(f, "\nbash");
    for (int i = from; i < argc; i++) { fputc(' ', f); squote(f, argv[i]); }
    fprintf(f, " >/tmp/fakewsl/%s.out 2>&1\necho $? >/tmp/fakewsl/%s.rc.tmp && mv /tmp/fakewsl/%s.rc.tmp /tmp/fakewsl/%s.rc\n",
            tag, tag, tag, tag);
    fclose(f);
    char cmd[512];
    snprintf(cmd, sizeof cmd, "/bin/sh /tmp/fakewsl/%s.sh", tag);
    STARTUPINFOA si = {sizeof si};
    PROCESS_INFORMATION pi;
    if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) return 127;
    snprintf(path, sizeof path, "Z:\\tmp\\fakewsl\\%s.rc", tag);
    for (;;) { /* wine does not hand back a Unix child's exit code: it comes as a file */
        FILE *r = fopen(path, "rb");
        if (r) {
            int rc = 1;
            if (fscanf(r, "%d", &rc) != 1) rc = 1;
            fclose(r);
            snprintf(path, sizeof path, "Z:\\tmp\\fakewsl\\%s.out", tag);
            FILE *o = fopen(path, "rb");
            size_t n;
            if (o) { while ((n = fread(buf, 1, sizeof buf, o)) > 0) fwrite(buf, 1, n, stdout); fclose(o); }
            return rc;
        }
        Sleep(200);
    }
}

static int probe(const char *distro) {
    char mode[32];
    if (!distro) scen("default", "ok", mode, sizeof mode);
    else if (!_stricmp(distro, "Ubuntu")) {
        scen("ubuntu", "none", mode, sizeof mode);
        if (!strcmp(mode, "installed")) strcpy(mode, state_int("installed") ? "ok" : "none");
        else if (!strcmp(mode, "registered")) strcpy(mode, state_int("registered") ? "root" : "none");
    } else { char d[32]; scen("default", "ok", d, sizeof d); strcpy(mode, strcmp(d, "none") ? d : "none"); }
    static int first = 1;
    if (first) { first = 0; Sleep(scen_int("probe_ms", 0)); }
    if (!strcmp(mode, "none")) { printf("There is no distribution with the supplied name.\r\n"); return -1; }
    if (!strcmp(mode, "other")) { printf("vb:Arch:alice:1000:arch:5.15.167.4-microsoft-standard-WSL2:Arch Linux\n"); return 0; }
    if (!strcmp(mode, "root")) { printf("vb:Ubuntu:root:0:ubuntu debian:5.15.167.4-microsoft-standard-WSL2:Ubuntu 24.04.1 LTS\n"); return 0; }
    printf("vb:Ubuntu:alice:1000:ubuntu debian:5.15.167.4-microsoft-standard-WSL2:Ubuntu 24.04.1 LTS\n");
    return 0;
}

int main(int argc, char **argv) {
    log_call(argc, argv);
    const char *base = strrchr(argv[0], '\\');
    base = base ? base + 1 : argv[0];
    if (!_stricmp(base, "ubuntu.exe")) { /* ubuntu.exe install --root | config --default-user U */
        if (argc >= 2 && !strcmp(argv[1], "install")) state_set("registered");
        return 0;
    }
    const char *distro = NULL, *user = NULL;
    int i = 1;
    if (argc >= 2 && !strcmp(argv[1], "--status")) return scen_int("status_rc", 0);
    if (argc >= 2 && !strcmp(argv[1], "--version")) { printf("WSL version: 2.3.26.0\r\nKernel version: 5.15.167.4-1\r\n"); return 0; }
    if (argc >= 2 && !strcmp(argv[1], "--manage")) return 0;
    if (argc >= 2 && !strcmp(argv[1], "--install")) {
        int rc = scen_int("install_rc", 0);
        if (rc == 0) state_set("installed");
        return rc;
    }
    for (; i < argc; i++) {
        if (!strcmp(argv[i], "-d") && i + 1 < argc) distro = argv[++i];
        else if (!strcmp(argv[i], "-u") && i + 1 < argc) user = argv[++i];
        else if (!strcmp(argv[i], "--cd") && i + 1 < argc) to_unix(argv[++i], g_cwd, sizeof g_cwd);
        else if (!strcmp(argv[i], "-e")) { i++; break; }
        else { fprintf(stderr, "fake wsl: unexpected %s\n", argv[i]); return 1; }
    }
    if (i >= argc) return 1;
    const char *cmd = argv[i];
    if (!strcmp(cmd, "sh") && i + 2 < argc && strstr(argv[i + 2], "os-release")) return probe(distro);
    if (!strcmp(cmd, "sh")) return 0;   /* bin/start --hold, bin/stop: recorded only */
    if (!strcmp(cmd, "wslpath") && argc >= i + 2) { char u[MAX_PATH]; to_unix(argv[argc - 1], u, sizeof u); printf("%s\n", u); return 0; }
    if (!strcmp(cmd, "bash")) {
        int is_setup = 0, is_cancel = 0;
        for (int k = i + 1; k < argc; k++) { if (!strcmp(argv[k], "--setup")) is_setup = 1; if (!strcmp(argv[k], "--cancel")) is_cancel = 1; }
        if (is_setup) {
            char mode[16];
            scen("setup", "real", mode, sizeof mode);
            if (!strcmp(mode, "fail")) {
                for (int k = i + 1; k + 1 < argc; k++)
                    if (!strcmp(argv[k], "--out")) {
                        char p[MAX_PATH];
                        snprintf(p, sizeof p, "Z:%s\\setup.ini", argv[k + 1]);
                        for (char *c = p; *c; c++) if (*c == '/') *c = '\\';
                        WritePrivateProfileStringA("setup", "result", "fail", p);
                        WritePrivateProfileStringA("setup", "why", "apt-get could not install curl python3", p);
                    }
                return 1;
            }
            return run_unix("/root", argc, argv, i + 1, 0);
        }
        char home[128];
        snprintf(home, sizeof home, "/tmp/wslhome/%s", user ? user : "default");
        return run_unix(home, argc, argv, i + 1, !is_cancel);
    }
    return 0;
}
