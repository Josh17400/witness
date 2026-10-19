/* bridge_host.c - the "browser" for a native test build of witness.h's web bridge (WITNESS_WEB_BRIDGE).
 * The EM_JS functions of witness.h become calls over stdin/stdout to bridge-node.mjs, which runs the real
 * witness_emscripten.js shim with a fake wasm heap; the shim's calls into C (inbuf/recv/closed) come back the same
 * way. emscripten_exit_with_live_runtime() runs that loop instead of returning to a browser.
 *   host -> node (stdout): "active\n" | "open\n" (both answered with "ret N\n") | "send N\n" + the line | "close\n" | "gesture 0|1\n"
 *   node -> host (stdin):  "ret N\n" | "recv N\n" + N bytes | "closed\n"
 * (lines, not the byte count, frame "send": Windows text-mode stdout writes each \n as \r\n) */
#include "witness.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int read_line(char *buf, int size) {
    int n = 0, c;
    while ((c = getchar()) != EOF) {
        if (c == '\n') { buf[n] = 0; return n; }
        if (n < size - 1) buf[n++] = (char)c;
    }
    return -1;
}

static void handle(const char *line);

static int wait_ret(void) {
    char line[256];
    for (;;) {
        if (read_line(line, sizeof line) < 0) exit(0);
        if (strncmp(line, "ret ", 4) == 0) return atoi(line + 4);
        handle(line);
    }
}

static void handle(const char *line) {
    if (strncmp(line, "recv ", 5) == 0) {
        int n = atoi(line + 5), i;
        char *p = witness_emscripten_inbuf(n);
        for (i = 0; i < n; i++) { int c = getchar(); if (c == EOF) exit(0); if (p) p[i] = (char)c; }
        witness_emscripten_recv(n);
    } else if (strcmp(line, "closed") == 0) {
        witness_emscripten_closed();
    }
}

static void say(const char *s) { fputs(s, stdout); fflush(stdout); }

int witness__js_active(void) { say("active\n"); return wait_ret(); }
int witness__js_open(void) { say("open\n"); return wait_ret(); }
void witness__js_send(const char *data, int len) { printf("send %d\n", len); fwrite(data, 1, (size_t)len, stdout); fflush(stdout); }
void witness__js_close(void) { say("close\n"); }
void witness__js_gesture(int on) { say(on ? "gesture 1\n" : "gesture 0\n"); }

void emscripten_exit_with_live_runtime(void) {
    char line[256];
    while (read_line(line, sizeof line) >= 0) {
        handle(line);
        if (!witness_connected()) break;
    }
    exit(0);
}
